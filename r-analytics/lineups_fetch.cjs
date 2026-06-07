// lineups_fetch.cjs — server-side predicted-lineup fetcher (holds the key; never client-side)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/lineups_fetch.cjs
//   Loops all 48 WC2026 teams, calls Claude + web search, writes public/data/lineups.json.
const fs = require("fs"), path = require("path");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "lineups.json");

const teams = fs.readFileSync(path.join(__dirname, "data", "team_elos.csv"), "utf8")
  .split("\n").slice(1).filter(Boolean).map(l => l.split(",")[0]);

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
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 160));
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON in response");
  return JSON.parse(clean.slice(s, e + 1));
}

(async () => {
  if (!KEY) { console.error("✗ ANTHROPIC_API_KEY not set — aborting. UI will use the existing lineups.json seed."); process.exit(1); }
  const out = { generated_at: new Date().toISOString(), teams: {} };
  let ok = 0;
  for (const t of teams) {
    try { out.teams[t] = await fetchTeam(t); ok++; console.log("✓", t, "—", out.teams[t]?.formation || ""); }
    catch (e) { console.error("✗", t, "—", e.message); out.teams[t] = null; }
    await new Promise(r => setTimeout(r, 2000));   // rate-limit courtesy
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`✓ Lineups fetched: ${ok}/${teams.length} teams → public/data/lineups.json`);
})();
