// build_squads.cjs — one-time confirmed-squad builder (6 confederation web searches, not 48)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/build_squads.cjs            (all 6 → wc2026_squads.json)
//   ANTHROPIC_API_KEY=sk-... node r-analytics/build_squads.cjs --test     (UEFA only, prints England)
//
// Sonnet 4.6 + web_search (Wikipedia). Output is large per confederation, so max_tokens is high.
const fs = require("fs"), path = require("path");
const TEST = process.argv.includes("--test");
const KEY = process.env.ANTHROPIC_API_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "data", "wc2026_squads.json");

const CONFEDERATIONS = [
  { name: "UEFA",     query: "2026 FIFA World Cup UEFA squads Wikipedia all teams players" },
  { name: "CONMEBOL", query: "2026 FIFA World Cup CONMEBOL squads Wikipedia all teams" },
  { name: "CAF",      query: "2026 FIFA World Cup CAF squads Wikipedia African teams" },
  { name: "AFC",      query: "2026 FIFA World Cup AFC squads Wikipedia Asian teams" },
  { name: "CONCACAF", query: "2026 FIFA World Cup CONCACAF squads Wikipedia teams" },
  { name: "OFC",      query: "2026 FIFA World Cup OFC squads Wikipedia teams" },
];

const systemFor = (conf) => `Search Wikipedia for the confirmed 2026 FIFA World Cup squads for all ${conf} teams. Extract every player for every team in that confederation.

Return ONLY valid JSON, no markdown:
{
  "teams": {
    "England": {
      "manager": "Thomas Tuchel",
      "players": [
        { "name": "Jordan Pickford", "position": "GK", "club": "Everton", "age": 32 }
      ]
    },
    "France": { }
  }
}

Include ALL players for ALL teams in this confederation. Position must be one of: GK, DEF, MID, FWD`;

async function searchConf(conf) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 16000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      system: systemFor(conf.name),
      messages: [{ role: "user", content: `${conf.query}. Return ONLY the JSON object with every team and every player in ${conf.name}. Start with { immediately.` }],
    }),
  });
  if (!res.ok) { const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200)); err.status = res.status; throw err; }
  const data = await res.json();
  if (TEST) console.log(`[${conf.name}] usage:`, JSON.stringify(data.usage), "stop_reason:", data.stop_reason);
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
    console.log("── TEST MODE — UEFA only ──");
    const teams = await searchConf(CONFEDERATIONS[0]);
    const eng = teams["England"];
    console.log(`\nUEFA teams returned: ${Object.keys(teams).length}`);
    if (!eng) { console.log("⚠ England not found in UEFA response."); return; }
    console.log(`\nEngland — manager: ${eng.manager}, ${eng.players.length} players:`);
    eng.players.forEach((p) => console.log(`  ${p.position}  ${p.name}${p.club ? " ("+p.club+")" : ""}`));
    const names = eng.players.map((p) => p.name.toLowerCase()).join(" | ");
    console.log("\nSanity:");
    console.log("  Kane present:  ", /kane/.test(names));
    console.log("  Saka present:  ", /saka/.test(names));
    console.log("  Bellingham:    ", /bellingham/.test(names));
    console.log("  Trippier:      ", /trippier/.test(names));
    console.log("  Trent (should be FALSE):", /alexander-arnold|trent/.test(names));
    return;
  }

  const merged = {};
  let ok = 0;
  for (const conf of CONFEDERATIONS) {
    try {
      const teams = await searchConf(conf);
      Object.assign(merged, teams);
      ok++;
      console.log(`✓ ${conf.name} — ${Object.keys(teams).length} teams (total ${Object.keys(merged).length})`);
    } catch (e) {
      console.error(`✗ ${conf.name} — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), source: "Wikipedia via web search", teams: merged }, null, 2));
  console.log(`\n✓ Wrote ${Object.keys(merged).length} teams (${ok}/6 confederations) → r-analytics/data/wc2026_squads.json`);
})();
