// build_squads.cjs — one-time confirmed-squad builder, batched into small groups (~4 teams each)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/build_squads.cjs            (all groups → wc2026_squads.json)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/build_squads.cjs --test     (UEFA-1 group only)
//
// One big confederation search (16 teams × 26 players) times out, so we search small groups with a
// modest max_tokens, a per-request 2-minute abort timeout, and a 10s gap between groups.
const fs = require("fs"), path = require("path");
const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const OUT = path.join(__dirname, "data", "wc2026_squads.json");

const SEARCH_GROUPS = [
  // UEFA (split into 4 groups of 4)
  { label: "UEFA-1", teams: ["England", "France", "Germany", "Spain"] },
  { label: "UEFA-2", teams: ["Portugal", "Netherlands", "Belgium", "Croatia"] },
  { label: "UEFA-3", teams: ["Italy", "Switzerland", "Austria", "Denmark"] },
  { label: "UEFA-4", teams: ["Scotland", "Turkey", "Serbia", "Sweden"] },
  // CONMEBOL
  { label: "CONMEBOL", teams: ["Brazil", "Argentina", "Uruguay", "Colombia", "Ecuador", "Chile"] },
  // CAF (Africa)
  { label: "CAF-1", teams: ["Morocco", "Senegal", "Nigeria", "Cameroon", "Egypt"] },
  { label: "CAF-2", teams: ["Ivory Coast", "Mali", "South Africa", "Tunisia", "Algeria"] },
  // AFC (Asia)
  { label: "AFC-1", teams: ["Japan", "South Korea", "Iran", "Saudi Arabia", "Australia"] },
  { label: "AFC-2", teams: ["Jordan", "Uzbekistan", "Iraq"] },
  // CONCACAF
  { label: "CONCACAF", teams: ["USA", "Mexico", "Canada", "Panama", "Haiti", "Curacao"] },
  // OFC
  { label: "OFC", teams: ["New Zealand"] },
];

const systemFor = (teams) => `Search Wikipedia for the confirmed 2026 FIFA World Cup squads for these teams: ${teams.join(", ")}.
Extract every player for each of these teams.

Return ONLY valid JSON, no markdown:
{
  "teams": {
    "England": {
      "manager": "Thomas Tuchel",
      "players": [
        { "name": "Jordan Pickford", "position": "GK", "club": "Everton", "age": 32 }
      ]
    }
  }
}

Include ALL players for each listed team. Position must be one of: GK, DEF, MID, FWD`;

async function searchGroup(group) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 min
  let data;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 4000,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
        system: systemFor(group.teams),
        messages: [{ role: "user", content: `FIFA World Cup 2026 official squad ${group.teams.join(" ")} 26 players confirmed list Wikipedia. Return ONLY the JSON object with every listed team and player. Start with { immediately.` }],
      }),
    });
    if (!res.ok) { const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200)); err.status = res.status; throw err; }
    data = await res.json();
  } finally {
    clearTimeout(timeout);
  }
  if (TEST) console.log(`[${group.label}] usage:`, JSON.stringify(data.usage), "stop_reason:", data.stop_reason);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON object in response");
  const obj = JSON.parse(clean.slice(s, e + 1));
  return obj.teams || {};
}

(async () => {
  if (!KEY) { console.error("✗ ANTHROPIC_API_KEY not set — aborting."); process.exit(1); }

  if (TEST) {
    const g = SEARCH_GROUPS[0];
    console.log(`── TEST MODE — ${g.label} group: ${g.teams.join(", ")} ──`);
    const teams = await searchGroup(g);
    console.log(`\nTeams returned: ${Object.keys(teams).length}`);
    g.teams.forEach((t) => {
      const sq = teams[t];
      console.log(`  ${t}: ${sq ? sq.players.length + " players (mgr: " + sq.manager + ")" : "⚠ NOT FOUND"}`);
    });
    const eng = teams["England"];
    if (eng) {
      const names = eng.players.map((p) => p.name.toLowerCase()).join(" | ");
      console.log("\nEngland sanity — Kane:", /kane/.test(names), "| Saka:", /saka/.test(names),
        "| Bellingham:", /bellingham/.test(names), "| Trippier:", /trippier/.test(names),
        "| Trent (should be FALSE):", /alexander-arnold|trent/.test(names));
    }
    return;
  }

  const merged = {};
  let ok = 0;
  for (const group of SEARCH_GROUPS) {
    try {
      const teams = await searchGroup(group);
      Object.assign(merged, teams);
      ok++;
      console.log(`✓ ${group.label} — ${Object.keys(teams).length} teams (total ${Object.keys(merged).length})`);
    } catch (e) {
      console.error(`✗ ${group.label} — ${e.name === "AbortError" ? "timed out (>2min)" : e.message}`);
    }
    await new Promise((r) => setTimeout(r, 10000)); // 10s between groups
  }
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), source: "Wikipedia via web search", teams: merged }, null, 2));
  console.log(`\n✓ Wrote ${Object.keys(merged).length} teams (${ok}/${SEARCH_GROUPS.length} groups) → r-analytics/data/wc2026_squads.json`);
})();
