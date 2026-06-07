// news_fetch.cjs — server-side WC2026 fantasy news fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/news_fetch.cjs
//   Calls Claude + web search for the latest fantasy-relevant news, writes public/data/news.json.
const fs = require("fs"), path = require("path");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "news.json");

const SYSTEM = `You are a fantasy-football news analyst for the 2026 FIFA World Cup.
Search the web for the most recent (last 24-48h) news that matters for WC2026 fantasy managers:
injuries, confirmed/predicted lineups, training-ground reports, suspensions, form, and selection news.

Return ONLY valid JSON. No preamble, no markdown, no backticks.
Return a JSON ARRAY of news items (most recent first, max 25), each item:
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

async function fetchNews() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 4000,
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      system: SYSTEM,
      messages: [{ role: "user", content: "Search for the latest WC2026 fantasy-relevant news (injuries, lineups, suspensions, training, form). Return a JSON array only, most recent first." }],
    }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s < 0 || e < 0) throw new Error("no JSON array in response");
  return JSON.parse(clean.slice(s, e + 1));
}

(async () => {
  if (!KEY) { console.error("✗ ANTHROPIC_API_KEY not set — aborting. UI will use existing news.json (or empty state)."); process.exit(1); }
  let items = [];
  try { items = await fetchNews(); }
  catch (e) { console.error("✗ news fetch failed —", e.message); process.exit(1); }
  const out = { generated_at: new Date().toISOString(), items };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`✓ News fetched: ${items.length} items → public/data/news.json`);
})();
