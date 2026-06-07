// news_fetch.cjs — server-side WC2026 fantasy news fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/news_fetch.cjs            (write public/data/news.json)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/news_fetch.cjs --test     (verbose, prints raw response)
const fs = require("fs"), path = require("path");
const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "news.json");

const SYSTEM = `You are a fantasy-football news analyst for the 2026 FIFA World Cup.
Search the web for the most recent (last 24-48h) news that matters for WC2026 fantasy managers:
injuries, confirmed/predicted lineups, training-ground reports, suspensions, form, and selection news.

Return ONLY valid JSON. No preamble, no markdown, no backticks.
Return a JSON ARRAY of news items (most recent first, max 15), each item:
{
  "id": "short-kebab-slug",
  "timestamp": "ISO 8601 datetime of the news",
  "category": "INJURY" | "LINEUP" | "TRAINING" | "SUSPENSION" | "FORM" | "GENERAL",
  "priority": "HIGH" | "MEDIUM" | "LOW",
  "player_name": "player or null",
  "team": "national team or null",
  "headline": "one-line headline",
  "summary": "1-2 sentence summary",
  "fantasy_impact": "what it means for fantasy managers, one sentence",
  "source_hint": "publication / source name"
}`;

async function callApi() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      // Sonnet 4.6, not Haiku: web_search_20260209 is invoked via programmatic tool calling,
      // which Haiku 4.5 can't do (HTTP 400). 1500 tokens fits ~15 compact items without truncating
      // (output cost is negligible vs the web-search input that dominates the bill).
      model: "claude-sonnet-4-6", max_tokens: 1500,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      system: SYSTEM,
      messages: [{ role: "user", content: "Search for the latest WC2026 fantasy-relevant news (injuries, lineups, suspensions, training, form). Return a JSON array only, most recent first." }],
    }),
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// robust extraction: text-only blocks, strip markdown fences, accept [array] or {items|news:[...]}
function parseItems(text) {
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // locate embedded JSON if the model wrapped it in prose — array preferred, else object
    const a1 = clean.indexOf("["), a2 = clean.lastIndexOf("]");
    const o1 = clean.indexOf("{"), o2 = clean.lastIndexOf("}");
    let cand = null;
    if (a1 >= 0 && a2 > a1) cand = clean.slice(a1, a2 + 1);
    else if (o1 >= 0 && o2 > o1) cand = clean.slice(o1, o2 + 1);
    if (cand == null) throw new Error("no JSON found in response text");
    parsed = JSON.parse(cand);
  }
  return Array.isArray(parsed) ? parsed : (parsed.items || parsed.news || []);
}

function logResponse(data) {
  const blocks = data.content || [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log("content blocks:", blocks.length, "| types:", blocks.map((b) => b.type).join(", ") || "(none)");
  console.log("stop_reason:", data.stop_reason, "| usage:", JSON.stringify(data.usage));
  console.log("raw text (first 500):", JSON.stringify(text.slice(0, 500)));
  return text;
}

// don't crash the workflow and don't wipe good data: keep existing items if present, else write []
function writeFallback() {
  try {
    const ex = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (Array.isArray(ex.items) && ex.items.length) { console.log(`kept existing news.json (${ex.items.length} items)`); return; }
  } catch { /* no/!invalid existing file */ }
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), items: [] }, null, 2));
  console.log("wrote empty news.json");
}

(async () => {
  if (!KEY) { console.error("✗ ANTHROPIC_API_KEY not set — aborting. UI keeps existing news.json (or empty state)."); process.exit(1); }

  let data;
  try { data = await callApi(); }
  catch (e) { console.error("✗ news API call failed —", e.message); writeFallback(); process.exit(0); }

  const text = logResponse(data);
  if (TEST) console.log("\nFULL RESPONSE:\n", JSON.stringify(data, null, 2));

  let items;
  try { items = parseItems(text); }
  catch (e) {
    console.error("✗ parse failed —", e.message, "→ writing fallback, exit 0 (workflow not failed)");
    writeFallback();
    process.exit(0);
  }

  items = items.slice(0, 15);
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), items }, null, 2));
  console.log(`✓ News fetched: ${items.length} items → public/data/news.json`);
  if (TEST) console.log("\nPARSED ITEMS:\n", JSON.stringify(items, null, 2));
})();
