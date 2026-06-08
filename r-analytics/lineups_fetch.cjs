// lineups_fetch.cjs — server-side predicted-lineup fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs            (batch of 8)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs --test     (England only, verbose)
//
// SOURCES (no per-team web search — that blew the rate limit):
//   1. CONFIRMED SQUAD  — r-analytics/data/wc2026_squads.json (build with `npm run build-squads`)
//   2. LATEST NEWS      — public/data/news.json (filtered per team)
//   3. TACTICAL KNOWLEDGE — the model's own knowledge of each manager's system
// Two-agent pipeline: Agent 1 predicts the XI (only from SOURCE 1), Agent 2 fact-checks it.
const fs = require("fs"), path = require("path");

const TEAMS_PER_RUN = 8;
const DELAY_MS = 3000;             // between teams
const REVIEW_DELAY_MS = 3000;      // between Agent 1 and Agent 2 for the same team
const CHECKPOINT_FILE = "public/data/lineups_checkpoint.json";
const MODEL = "claude-opus-4-6";   // most accurate 2026 knowledge (expensive — manual runs only)
const PREDICT_MAX_TOKENS = 1500;
const REVIEW_MAX_TOKENS = 1200;

const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lineups.json");
const CP = path.join(ROOT, CHECKPOINT_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teams = fs.readFileSync(path.join(__dirname, "data", "team_elos.csv"), "utf8")
  .split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[0]);

// SOURCE 1 — confirmed squads (graceful if not yet built)
let squads = { teams: {} };
try { squads = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "wc2026_squads.json"), "utf8")); }
catch { console.warn("⚠ wc2026_squads.json not found — run `npm run build-squads`. Falling back to model knowledge."); }

// SOURCE 2 — news feed
let allNews = [];
try { const nd = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "data", "news.json"), "utf8")); allNews = Array.isArray(nd) ? nd : (nd.items || []); }
catch { /* no news file */ }

function newsContextFor(team, squadPlayers) {
  const teamNews = allNews.filter((item) =>
    item.team === team ||
    (item.player_name && squadPlayers.some((p) =>
      p.name.toLowerCase().includes((item.player_name.toLowerCase().split(" ")[1]) || item.player_name.toLowerCase())
    ))
  );
  const ctx = teamNews.length > 0
    ? teamNews.map((n) => `[${n.priority}] ${n.headline} — ${n.summary} (Impact: ${n.fantasy_impact})`).join("\n")
    : "No recent news available for this team.";
  return { teamNews, ctx };
}

const SLOT_POS = { GK:"GK", LB:"DEF", LCB:"DEF", RCB:"DEF", CB:"DEF", RB:"DEF",
  CDM:"MID", CM:"MID", LCM:"MID", RCM:"MID", CAM:"MID", LM:"MID", RM:"MID",
  LW:"FWD", ST:"FWD", RW:"FWD", LF:"FWD", RF:"FWD" };
const withPos = (p) => { p.position = SLOT_POS[p.slot] || p.position || "MID"; return p; };

function predictSystem(team, sq, newsContext) {
  const hasSquad = sq.players && sq.players.length;
  const source1 = hasSquad
    ? `You MUST only select players from this list.\nNever predict anyone not on this list.\n${JSON.stringify(sq.players, null, 2)}`
    : `No confirmed squad list is available — use your best knowledge of ${team}'s likely 2026 squad.`;
  return `You are an expert football analyst predicting the most likely starting XI for ${team} at WC 2026.

SOURCE 1 — CONFIRMED 26-MAN SQUAD (ground truth):
${source1}

SOURCE 2 — LATEST NEWS AND INJURY UPDATES:
${newsContext}

SOURCE 3 — YOUR TACTICAL KNOWLEDGE:
Use your knowledge of ${sq.manager || "the manager"}'s preferred system, player roles, set piece takers, and captain.

STRICT RULES:
- All 11 starters must be from SOURCE 1
- Formation must be valid and player counts must match
- Players marked OUT in SOURCE 2: exclude from XI
- Players marked DOUBT in SOURCE 2: mark status as DOUBT
- Bench: 4 most likely impact substitutes from SOURCE 1

Return valid JSON only, no markdown:
{
  "team": "${team}",
  "manager": "${sq.manager || ""}",
  "formation": "4-3-3",
  "confidence": "HIGH/MEDIUM/LOW",
  "players": [
    { "name": "...", "slot": "GK/LB/LCB/RCB/RB/CDM/CM/CAM/LM/RM/LW/RW/ST", "position": "GK/DEF/MID/FWD", "status": "CERTAIN/PROBABLE/DOUBT", "doubt_reason": null }
  ],
  "bench": [4 player objects same schema],
  "tactical_note": "one sentence",
  "fantasy_note": "one sentence fantasy implication"
}`;
}

function reviewSystem(team, sq, newsContext) {
  return `You are fact-checking a predicted WC 2026 lineup for ${team}.

SOURCE 1 — CONFIRMED SQUAD (must use only these players):
${JSON.stringify(sq.players || [], null, 2)}

SOURCE 2 — LATEST NEWS:
${newsContext}

CHECKS IN ORDER:
1. SQUAD CHECK: Every player must be in SOURCE 1. If not → critical error, replace with correct player.
2. NEWS CHECK: Anyone marked OUT in SOURCE 2 must not start. Anyone confirmed starting must be in XI.
3. FORMATION CHECK: Player count must match formation.
4. TACTICAL CHECK: Does lineup fit the manager's known system?
5. OMISSION CHECK: Is the team's key player missing?

Return JSON only:
{
  "approved": true/false,
  "confidence": "HIGH/MEDIUM/LOW",
  "errors_found": [
    { "type": "SQUAD_VIOLATION/NEWS_CONFLICT/FORMATION_ERROR/TACTICAL_ERROR/OMISSION", "player_affected": "name", "description": "what's wrong", "correction": "what it should be" }
  ],
  "corrected_players": [],
  "reviewer_note": "one sentence",
  "key_uncertainties": ["genuinely unclear selections"]
}`;
}

function extractJson(apiJson) {
  const text = (apiJson.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON in response");
  return JSON.parse(clean.slice(s, e + 1));
}

async function apiCall(system, userMsg, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) { const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200)); err.status = res.status; throw err; }
  return res.json();
}

async function predict(team, sq, newsContext, teamNewsCount) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const obj = extractJson(await apiCall(predictSystem(team, sq, newsContext), `Predict the starting XI for ${team} at the 2026 World Cup, using SOURCE 1 (squad), SOURCE 2 (news) and SOURCE 3 (tactics). JSON only.`, PREDICT_MAX_TOKENS));
      obj.team = obj.team || team;
      obj.news_items_used = teamNewsCount;
      (obj.players || []).forEach(withPos);
      (obj.bench || []).forEach(withPos);
      return obj;
    } catch (e) {
      if (e.status === 429 && attempt === 0) { console.log(`  ⏳ 429 on ${team} (predict) — 20s then retry`); await sleep(20000); continue; }
      throw e;
    }
  }
}

async function review(team, sq, newsContext, lineup) {
  const userMsg = `Review this predicted lineup for ${team} against SOURCE 1 (squad) and SOURCE 2 (news):\n\n${JSON.stringify(lineup, null, 2)}\n\nReturn JSON only.`;
  const r = extractJson(await apiCall(reviewSystem(team, sq, newsContext), userMsg, REVIEW_MAX_TOKENS));
  const errs = Array.isArray(r.errors_found) ? r.errors_found : [];
  let confidence;
  if (r.approved && errs.length === 0) {
    confidence = r.confidence || "HIGH";
    console.log(`✓ ${team} — approved by reviewer (confidence: ${confidence})`);
  } else {
    errs.forEach((e) => console.log(`⚠ ${team} — reviewer flagged: ${e.description}`));
    (r.corrected_players || []).forEach((cp) => {
      withPos(cp);
      const idx = (lineup.players || []).findIndex((p) => p.slot === cp.slot);
      if (idx >= 0) lineup.players[idx] = cp; else (lineup.players = lineup.players || []).push(cp);
    });
    confidence = r.confidence || "MEDIUM";
    console.log(`✓ ${team} — corrected by reviewer (${errs.length} error${errs.length === 1 ? "" : "s"} fixed)`);
  }
  lineup.confidence = confidence;
  lineup.review = { approved: !!r.approved, errors_found: errs, corrected_players: r.corrected_players || [], reviewer_note: r.reviewer_note || "", key_uncertainties: r.key_uncertainties || [], confidence, reviewed_at: new Date().toISOString() };
  return lineup;
}

async function fetchTeam(team) {
  const sq = squads.teams[team] || { manager: "", players: [] };
  const { teamNews, ctx } = newsContextFor(team, sq.players || []);
  const lineup = await predict(team, sq, ctx, teamNews.length);
  await sleep(REVIEW_DELAY_MS);
  try {
    return await review(team, sq, ctx, lineup);
  } catch (e) {
    lineup.confidence = "UNREVIEWED";
    lineup.review = { approved: false, errors_found: [], corrected_players: [], reviewer_note: "reviewer unavailable", key_uncertainties: [], confidence: "UNREVIEWED", reviewed_at: new Date().toISOString() };
    console.log(`⚠ ${team} — reviewer failed, using unreviewed prediction (${e.message})`);
    return lineup;
  }
}

function readCheckpoint() {
  if (!fs.existsSync(CP)) return 0;
  try { return Number(JSON.parse(fs.readFileSync(CP, "utf8")).last_completed_index) || 0; } catch { return 0; }
}
function writeCheckpoint(idx) { fs.writeFileSync(CP, JSON.stringify({ last_completed_index: idx }, null, 2) + "\n"); }

async function runTest() {
  const team = "England";
  const sq = squads.teams[team] || { manager: "", players: [] };
  const { teamNews, ctx } = newsContextFor(team, sq.players || []);
  console.log(`── TEST MODE — ${team} (model ${MODEL}) ──`);
  console.log(`SOURCE 1 squad players loaded: ${(sq.players || []).length}`);
  console.log(`SOURCE 2 news items matched: ${teamNews.length}`);
  const a1 = await predict(team, sq, ctx, teamNews.length);
  console.log("\nAGENT 1 (Predictor) lineup:\n", JSON.stringify(a1, null, 2));
  await sleep(REVIEW_DELAY_MS);
  const final = await review(team, sq, ctx, JSON.parse(JSON.stringify(a1)));
  console.log("\nAGENT 2 (Reviewer):\n", JSON.stringify(final.review, null, 2));
  console.log("\nFINAL lineup:\n", JSON.stringify(final, null, 2));
}

async function runBatch() {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { teams: {} };
  const out = { generated_at: existing.generated_at || null, teams: existing.teams || {} };

  let start = readCheckpoint();
  if (start >= teams.length || start < 0) start = 0;
  const end = Math.min(start + TEAMS_PER_RUN, teams.length);
  console.log(`Run starting at index ${start} — fetching teams ${start} to ${end - 1}`);

  let fetched = 0, skipped = 0;
  for (let i = start; i < end; i++) {
    const team = teams[i];
    try {
      out.teams[team] = await fetchTeam(team);
      out.generated_at = new Date().toISOString();
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
      fetched++;
      console.log(`✓ ${team} — saved (index ${i})`);
    } catch (e) {
      skipped++;
      console.error(`✗ ${team} (index ${i}) — skipped: ${e.message}`);
    }
    const next = (i + 1 >= teams.length) ? 0 : i + 1;
    writeCheckpoint(next);
    if (i < end - 1) await sleep(DELAY_MS);
  }

  const nextStart = (end >= teams.length) ? 0 : end;
  if (nextStart === 0) console.log("All 48 teams cycled — checkpoint reset to index 0.");
  console.log(`Run complete — fetched ${fetched} teams${skipped ? ` (${skipped} skipped)` : ""}, next run starts at index ${nextStart}`);
}

(async () => {
  if (!KEY) { console.error("✗ ANTHROPIC_API_KEY not set — aborting. UI keeps the existing lineups.json."); process.exit(1); }
  if (TEST) await runTest(); else await runBatch();
})();
