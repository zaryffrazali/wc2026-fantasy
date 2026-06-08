// lineups_fetch.cjs — server-side predicted-lineup fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs            (batch of 8)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs --test     (Spain only, verbose)
//
// TWO-AGENT PIPELINE (no web search — that blew the 30k tok/min limit):
//   Agent 1 (Predictor) generates an XI + bench from training knowledge.
//   Agent 2 (Reviewer) fact-checks it (retired players, wrong squad, formation, injuries,
//   omissions) and returns corrections. Final confidence comes from the reviewer.
// Sonnet 4.6 for both: Haiku's knowledge is too stale for accurate 2026 squads.
const fs = require("fs"), path = require("path");

const TEAMS_PER_RUN = 8;
const DELAY_MS = 3000;             // between teams
const REVIEW_DELAY_MS = 3000;      // between Agent 1 and Agent 2 for the same team (rate-limit buffer)
const CHECKPOINT_FILE = "public/data/lineups_checkpoint.json";
const MODEL = "claude-opus-4-6"; // Opus: most recent/accurate 2026 squad knowledge (expensive — manual runs only)
const PREDICT_MAX_TOKENS = 1500;   // 11 starters + 4 bench + notes
const REVIEW_MAX_TOKENS = 1000;

const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lineups.json");
const CP = path.join(ROOT, CHECKPOINT_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teams = fs.readFileSync(path.join(__dirname, "data", "team_elos.csv"), "utf8")
  .split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[0]);

const PREDICT_SYSTEM = `You are a football analyst. It is June 2026. Use your most current knowledge of national team squads to predict the most likely starting XI for the given national team at the 2026 FIFA World Cup.
Key facts to remember:
- Use the 2026 WC qualifying squads as your baseline; prioritise players who featured in recent qualifiers
- Do not include any player who retired from international football before 2026
- Kane is fully fit and England's first-choice striker
- Neymar is NOT retired — he returned to Brazil's squad for 2026 qualifying after ACL recovery
Use your training knowledge — do not say you cannot access live data, just give your best prediction. Return only valid JSON, no markdown.
Output exactly this shape and nothing else:
{"team":"","flag":"emoji flag","formation":"4-3-3","manager":"","players":[{"name":"","slot":"GK|LB|LCB|RCB|RB|CDM|CM|CAM|LM|RM|LW|ST|RW","status":"CERTAIN|PROBABLE|DOUBT|OUT","doubt_reason":null}],"bench":[{"name":"","slot":"","status":"","doubt_reason":null}],"key_absences":[],"tactical_note":"","fantasy_note":""}
Give exactly 11 starting players and 4 bench players likely to feature. Keep every string short.`;

const REVIEW_SYSTEM = `You are a strict football squad fact-checker for the 2026 FIFA World Cup (June-July 2026).
Your job: review a predicted national team lineup and flag or correct any errors.

Check for these specific errors:
1. RETIRED PLAYERS: Remove anyone who retired from international football before 2026.
   Confirmed retirements: Pepe (Portugal, 2024), Sergio Ramos (Spain, 2023), Thiago Silva (Brazil, 2023), Thomas Muller (Germany, 2021).
   Neymar is NOT retired — he returned to the Brazil squad for 2026 qualifying after ACL recovery.
   If you are not 100% certain a player retired, do NOT flag them as retired. Only flag clear, confirmed retirements. When in doubt, approve the pick.
2. WRONG SQUAD: Flag players who were not in the nation's WC 2026 qualifying or final squad.
3. FORMATION MISMATCH: Check the number of players in each position matches the stated formation (4-3-3 = 1 GK + 4 DEF + 3 MID + 3 FWD = 11 total).
4. INJURY STATUS: Flag any player listed as CERTAIN who you know had a significant injury concern entering the tournament.
5. OBVIOUS OMISSIONS: Flag if a nation's most important player is missing entirely with no explanation (e.g. Vinicius Jr missing from Brazil with no note).

Return ONLY valid JSON, no markdown:
{
  "approved": true/false,
  "confidence": "HIGH" / "MEDIUM" / "LOW",
  "errors_found": [
    { "type": "RETIRED_PLAYER"/"WRONG_SQUAD"/"FORMATION_MISMATCH"/"INJURY_STATUS"/"OBVIOUS_OMISSION", "description": "brief description", "player_affected": "player name or null", "correction": "what it should be" }
  ],
  "corrected_players": [ /* only players that need changing, same schema as the original players array */ ],
  "reviewer_note": "one sentence summary of review"
}`;

const SLOT_POS = { GK:"GK", LB:"DEF", LCB:"DEF", RCB:"DEF", CB:"DEF", RB:"DEF",
  CDM:"MID", CM:"MID", LCM:"MID", RCM:"MID", CAM:"MID", LM:"MID", RM:"MID",
  LW:"FWD", ST:"FWD", RW:"FWD", LF:"FWD", RF:"FWD" };
const withPos = (p) => { p.position = SLOT_POS[p.slot] || p.position || "MID"; return p; };

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

// ── Agent 1: predict (with a single 429 retry) ──────────────────────────────────
async function predict(team) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const obj = extractJson(await apiCall(PREDICT_SYSTEM, `Predicted starting XI for ${team} at the 2026 World Cup. JSON only.`, PREDICT_MAX_TOKENS));
      obj.team = obj.team || team;
      (obj.players || []).forEach(withPos);
      (obj.bench || []).forEach(withPos);
      return obj;
    } catch (e) {
      if (e.status === 429 && attempt === 0) { console.log(`  ⏳ 429 on ${team} (predict) — 20s then retry`); await sleep(20000); continue; }
      throw e;
    }
  }
}

// ── Agent 2: review + apply corrections ─────────────────────────────────────────
async function review(team, lineup) {
  const userMsg = `Review this predicted lineup for ${team} at the 2026 FIFA World Cup and check for errors:\n\n${JSON.stringify(lineup, null, 2)}\n\nIt is June 2026. Check against your knowledge of the actual WC 2026 squads and player availability. Return JSON only.`;
  const r = extractJson(await apiCall(REVIEW_SYSTEM, userMsg, REVIEW_MAX_TOKENS));
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
  lineup.review = { approved: !!r.approved, errors_found: errs, corrected_players: r.corrected_players || [], reviewer_note: r.reviewer_note || "", confidence, reviewed_at: new Date().toISOString() };
  return lineup;
}

// ── full per-team flow: predict → 3s → review (review failure ⇒ UNREVIEWED) ─────
async function fetchTeam(team) {
  const lineup = await predict(team);
  await sleep(REVIEW_DELAY_MS);
  try {
    return await review(team, lineup);
  } catch (e) {
    lineup.confidence = "UNREVIEWED";
    lineup.review = { approved: false, errors_found: [], corrected_players: [], reviewer_note: "reviewer unavailable", confidence: "UNREVIEWED", reviewed_at: new Date().toISOString() };
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
  console.log(`── TEST MODE — Spain only (model ${MODEL}, two-agent pipeline) ──`);
  const a1 = await predict("Spain");
  console.log("\nAGENT 1 (Predictor) lineup:\n", JSON.stringify(a1, null, 2));
  await sleep(REVIEW_DELAY_MS);
  const final = await review("Spain", JSON.parse(JSON.stringify(a1)));
  console.log("\nAGENT 2 (Reviewer) result:\n", JSON.stringify(final.review, null, 2));
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
