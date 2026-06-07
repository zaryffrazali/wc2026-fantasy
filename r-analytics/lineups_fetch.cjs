// lineups_fetch.cjs — server-side predicted-lineup fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs            (batch of 8)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs --test     (Spain only, verbose)
//
// ROOT CAUSE of the 429s: the web_search tool injects fetched page content back into the
// request as INPUT tokens. One uncapped search can push a single request past the 30k
// tokens/minute ceiling — so it 429s on the very first team no matter how long we pause.
// Pacing can't fix a single over-budget request. The real levers are: cap searches with
// `max_uses`, use Haiku (separate, higher TPM bucket, far cheaper tokens), keep output small.
const fs = require("fs"), path = require("path");

const TEAMS_PER_RUN = 8;
const DELAY_MS = 15000;            // FIX 5 fallback: raise to 90000 if 429s persist after this
const CHECKPOINT_FILE = "public/data/lineups_checkpoint.json";
const MODEL = "claude-haiku-4-5-20251001";   // FIX 2 — cheaper/faster, separate rate-limit bucket
const MAX_TOKENS = 800;                       // FIX 3 — lineup JSON needs nothing close to 2000
const MAX_SEARCHES = 2;                        // cap web_search input-token blow-up (real fix)

const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lineups.json");
const CP = path.join(ROOT, CHECKPOINT_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const teams = fs.readFileSync(path.join(__dirname, "data", "team_elos.csv"), "utf8")
  .split("\n").slice(1).filter(Boolean).map((l) => l.split(",")[0]);

// FIX 1 — minimal system prompt (<200 words), minimal JSON (name, slot, status, doubt_reason)
const SYSTEM = `You return predicted WC2026 starting XIs as compact JSON only — no prose, no markdown.
Use at most ${MAX_SEARCHES} web searches for the latest lineup/injury news, then answer.
Output exactly this shape and nothing else:
{"team":"","flag":"","formation":"4-3-3","confidence":"HIGH|MEDIUM|LOW","manager":"",
"players":[{"name":"","slot":"GK|LB|LCB|RCB|RB|CDM|CM|CAM|LM|RM|LW|ST|RW","status":"CERTAIN|PROBABLE|DOUBT|OUT","doubt_reason":null}],
"key_absences":[]}
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
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
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
  (obj.players || []).forEach((p) => { p.position = SLOT_POS[p.slot] || "MID"; });   // re-add position
  return obj;
}

// one retry after a 60s pause on 429; a second 429 (or other error) is thrown to the caller
async function fetchWithRetry(team) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return parseLineup(await callApi(team), team); }
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

async function runTest() {
  console.log(`── TEST MODE — fetching Spain only (model ${MODEL}, max_tokens ${MAX_TOKENS}, max_uses ${MAX_SEARCHES}) ──`);
  const raw = await callApi("Spain");
  console.log("\nUSAGE:", JSON.stringify(raw.usage, null, 2));
  console.log("stop_reason:", raw.stop_reason);
  console.log("\nFULL RESPONSE:\n", JSON.stringify(raw, null, 2));
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
