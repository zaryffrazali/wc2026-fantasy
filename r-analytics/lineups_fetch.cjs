// lineups_fetch.cjs — server-side predicted-lineup fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs            (batch of 8)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs --test     (Spain only, verbose)
//
// NO WEB SEARCH: web_search injected tens of thousands of input tokens per call, hitting the
// 30k tokens/min limit on the very first team regardless of pacing. We dropped the tool entirely
// and rely on the model's training knowledge of WC2026 squads/formations. Lineups are AI-PREDICTED
// (the UI labels them as such), refreshed daily. Tokens per call are now tiny, so pacing is a
// non-issue (3s between teams).
const fs = require("fs"), path = require("path");

const TEAMS_PER_RUN = 8;
const DELAY_MS = 3000;             // no web search → tiny requests → rate limit is no longer a concern
const CHECKPOINT_FILE = "public/data/lineups_checkpoint.json";
const MODEL = "claude-haiku-4-5-20251001"; // no tools → Haiku works fine (~20× cheaper than Sonnet)
const MAX_TOKENS = 1000;

const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lineups.json");
const CP = path.join(ROOT, CHECKPOINT_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teams = fs.readFileSync(path.join(__dirname, "data", "team_elos.csv"), "utf8")
  .split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[0]);

const SYSTEM = `You are a football analyst. Based on your knowledge of WC 2026 squads, typical formations, and player availability as of mid-2026, predict the most likely starting XI for the given national team. Use your training knowledge — do not say you cannot access live data, just give your best prediction. Return only valid JSON, no markdown.
Output exactly this shape and nothing else:
{"team":"","flag":"emoji flag","formation":"4-3-3","manager":"","players":[{"name":"","slot":"GK|LB|LCB|RCB|RB|CDM|CM|CAM|LM|RM|LW|ST|RW","status":"CERTAIN|PROBABLE|DOUBT|OUT","doubt_reason":null}],"key_absences":[],"tactical_note":"","fantasy_note":""}
Give 11 players. Keep every string short.`;

// derive position from slot so the UI keeps its colours without spending output tokens on it
const SLOT_POS = { GK:"GK", LB:"DEF", LCB:"DEF", RCB:"DEF", CB:"DEF", RB:"DEF",
  CDM:"MID", CM:"MID", LCM:"MID", RCM:"MID", CAM:"MID", LM:"MID", RM:"MID",
  LW:"FWD", ST:"FWD", RW:"FWD", LF:"FWD", RF:"FWD" };

async function callApi(team) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: `Predicted starting XI for ${team} at the 2026 World Cup. JSON only.` }],
    }),
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function parseLineup(apiJson, team) {
  const text = (apiJson.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON in response");
  const obj = JSON.parse(clean.slice(s, e + 1));
  obj.team = obj.team || team;
  obj.confidence = "AI_PREDICTED";                                            // always AI-predicted now
  (obj.players || []).forEach((p) => { p.position = SLOT_POS[p.slot] || "MID"; });
  return obj;
}

// on 429: wait 20s, retry once; a second 429 (or other error) is thrown so the caller skips the team
async function fetchWithRetry(team) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return parseLineup(await callApi(team), team); }
    catch (e) {
      if (e.status === 429 && attempt === 0) {
        console.log(`  ⏳ 429 on ${team} — waiting 20s then one retry`);
        await sleep(20000);
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

async function runTest() {
  console.log(`── TEST MODE — Spain only (model ${MODEL}, max_tokens ${MAX_TOKENS}, no web search) ──`);
  const raw = await callApi("Spain");
  console.log("\nUSAGE:", JSON.stringify(raw.usage), "| stop_reason:", raw.stop_reason);
  console.log("\nPARSED LINEUP:\n", JSON.stringify(parseLineup(raw, "Spain"), null, 2));
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
      out.teams[team] = await fetchWithRetry(team);
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
