// lineups_fetch.cjs — server-side predicted-lineup fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs
//
// BATCH MODE: 48 web-search calls in one run blows the 30k tokens/min limit regardless of
// delay, so each run fetches only TEAMS_PER_RUN teams, tracked by a checkpoint file. The
// GitHub Action runs 6×/day (every 4h) → 6 × 8 = 48 teams/day, then the checkpoint wraps to 0.
const fs = require("fs"), path = require("path");

const TEAMS_PER_RUN = 8;
const DELAY_MS = 15000;
const CHECKPOINT_FILE = "public/data/lineups_checkpoint.json";

const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lineups.json");
const CP = path.join(ROOT, CHECKPOINT_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teams = fs.readFileSync(path.join(__dirname, "data", "team_elos.csv"), "utf8")
  .split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[0]);

const SYSTEM = `You are a football lineup analyst for WC2026 fantasy.
Search for the most likely starting XI for the given national team at the 2026 World Cup. Look for:
- Manager's preferred formation and lineup from recent press conferences
- Injury news and doubts
- Predicted lineups from Fantasy Football Scout, BBC Sport, Sky Sports
- Recent qualifying and friendly lineups as baseline

Return ONLY valid JSON. No preamble, no markdown, no backticks.
Return this exact structure:
{
  "team": "country name", "flag": "emoji flag", "formation": "4-3-3",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "last_news_date": "approximate date of most recent source", "manager": "manager name",
  "players": [ { "name": "...", "position": "GK|DEF|MID|FWD",
    "slot": "GK|LB|LCB|RCB|RB|LM|CM|RM|CAM|LW|ST|RW|CDM",
    "status": "CERTAIN|PROBABLE|DOUBT|OUT", "doubt_reason": "... or null",
    "caps": 0, "in_fantasy_pool": true, "fantasy_price": null, "fantasy_xpts": null } ],
  "key_absences": ["player — reason"], "tactical_note": "one sentence", "fantasy_note": "one sentence"
}`;

async function fetchTeam(team) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 2000,
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      system: SYSTEM,
      messages: [{ role: "user", content: `Search for the predicted starting XI for ${team} at the 2026 FIFA World Cup. Find the most recent lineup news, injury updates and manager quotes. Return JSON only.` }],
    }),
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 160));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON in response");
  return JSON.parse(clean.slice(s, e + 1));
}

// one retry after a 60s pause on 429; a second 429 (or any other error) is thrown to the caller
async function fetchWithRetry(team) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fetchTeam(team); }
    catch (e) {
      if (e.status === 429 && attempt === 0) {
        console.log(`  ⏳ 429 rate-limited on ${team} — pausing 60s before one retry`);
        await sleep(60000);
        continue;
      }
      throw e;
    }
  }
}

function readCheckpoint() {
  if (!fs.existsSync(CP)) return 0;
  try { return Number(JSON.parse(fs.readFileSync(CP, "utf8")).last_completed_index) || 0; }
  catch { return 0; }
}
function writeCheckpoint(idx) {
  fs.writeFileSync(CP, JSON.stringify({ last_completed_index: idx }, null, 2) + "\n");
}

(async () => {
  if (!KEY) { console.error("✗ ANTHROPIC_API_KEY not set — aborting. UI keeps the existing lineups.json."); process.exit(1); }

  // merge into the existing file so the other ~40 teams are never wiped by a batch
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { teams: {} };
  const out = { generated_at: existing.generated_at || null, teams: existing.teams || {} };

  let start = readCheckpoint();
  if (start >= teams.length || start < 0) start = 0;          // wrap / sanity
  const end = Math.min(start + TEAMS_PER_RUN, teams.length);
  console.log(`Run starting at index ${start} — fetching teams ${start} to ${end - 1}`);

  let fetched = 0, skipped = 0;
  for (let i = start; i < end; i++) {
    const team = teams[i];
    try {
      out.teams[team] = await fetchWithRetry(team);
      out.generated_at = new Date().toISOString();
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2));     // persist after every team
      fetched++;
      console.log(`✓ ${team} — saved (index ${i})`);
    } catch (e) {
      skipped++;
      console.error(`✗ ${team} (index ${i}) — skipped: ${e.message}`);
    }
    // advance the checkpoint after every team so the run always moves forward (8 teams/run)
    const next = (i + 1 >= teams.length) ? 0 : i + 1;
    writeCheckpoint(next);
    if (i < end - 1) await sleep(DELAY_MS);
  }

  const nextStart = (end >= teams.length) ? 0 : end;
  if (nextStart === 0) console.log("All 48 teams cycled — checkpoint reset to index 0.");
  console.log(`Run complete — fetched ${fetched} teams${skipped ? ` (${skipped} skipped)` : ""}, next run starts at index ${nextStart}`);
})();
