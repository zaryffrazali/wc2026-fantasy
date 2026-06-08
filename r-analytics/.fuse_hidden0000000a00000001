// apifootball_news.cjs — real WC2026 news from API-Football (api-sports.io), zero-cost free tier.
// Writes public/data/news.json in the exact item schema the News tab renders.
//
//   API_FOOTBALL_KEY=xxxx node r-analytics/apifootball_news.cjs           (write public/data/news.json)
//   API_FOOTBALL_KEY=xxxx node r-analytics/apifootball_news.cjs --test    (verbose; prints raw responses)
//
// Free tier = 100 requests/day. This script makes 3 requests/run (injuries, fixtures, topscorers).
// Fail-safe: on missing key or API error it keeps the existing news.json (or writes 3 placeholders),
// and ALWAYS exits 0 so the GitHub Action is never marked failed.
//
// VERIFY BEFORE RELYING ON IT: confirm the World Cup league id / season with your key:
//   curl -s "https://v3.football.api-sports.io/leagues?search=world%20cup" -H "x-apisports-key: $API_FOOTBALL_KEY"
// The context doc assumes league=1, season=2026 — this is NOT yet verified against a live key.

const fs = require("fs"), path = require("path");
const TEST = process.argv.includes("--test");
const KEY = process.env.API_FOOTBALL_KEY;
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "public", "data", "news.json");
const PLAYERS = path.join(ROOT, "public", "data", "players.json");

const BASE = "https://v3.football.api-sports.io";
const LEAGUE = process.env.API_FOOTBALL_LEAGUE || "1";   // FIFA World Cup (override via env if wrong)
const SEASON = process.env.API_FOOTBALL_SEASON || "2026";

const PLACEHOLDER_NEWS = [
  { id: "ph-1", timestamp: null, category: "LINEUP", priority: "MEDIUM", player_name: null, team: "General", headline: "News feed loading — check back shortly", summary: "Live WC2026 injury, fixture and top-scorer data populates from API-Football during the tournament.", fantasy_impact: "— NEUTRAL", source_hint: "WC26 Scout" },
  { id: "ph-2", timestamp: null, category: "INJURY", priority: "LOW", player_name: null, team: "General", headline: "Injury & availability updates arrive during the tournament", summary: "Live injury news is fetched every 6 hours once the World Cup begins (Jun 11).", fantasy_impact: "— NEUTRAL", source_hint: "WC26 Scout" },
  { id: "ph-3", timestamp: null, category: "GENERAL", priority: "LOW", player_name: null, team: "General", headline: "Use the AI Lineups tab for predicted XIs", summary: "Until live news is active, use the AI Lineups tab for predicted XIs and the Players tab for projections.", fantasy_impact: "— NEUTRAL", source_hint: "WC26 Scout" },
];

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").trim();

async function api(endpoint) {
  const url = `${BASE}${endpoint}`;
  const res = await fetch(url, { headers: { "x-apisports-key": KEY } });
  const json = await res.json().catch(() => ({}));
  if (TEST) console.log(`\n[${endpoint}] HTTP ${res.status} | results=${json.results} | errors=${JSON.stringify(json.errors || {})}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpoint}`);
  // api-sports returns 200 with an "errors" object on auth/quota/param problems
  if (json.errors && (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors).length)) {
    throw new Error(`API error on ${endpoint}: ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

function loadSeedNames() {
  try {
    const d = JSON.parse(fs.readFileSync(PLAYERS, "utf8"));
    const arr = Array.isArray(d) ? d : (d.players || []);
    return new Set(arr.map((p) => norm(p.name)));
  } catch { return new Set(); }
}

function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " MYT"; }
  catch { return iso; }
}

function mapInjuries(rows, seed) {
  return rows.map((r, i) => {
    const name = r.player?.name || "Unknown player";
    const team = r.team?.name || null;
    const reason = r.player?.reason || r.reason || r.type || "Fitness concern";
    const high = seed.has(norm(name));
    return {
      id: `inj-${r.player?.id || i}-${r.fixture?.id || i}`,
      timestamp: r.fixture?.date || null,
      category: "INJURY",
      priority: high ? "HIGH" : "MEDIUM",
      player_name: name,
      team,
      headline: `${name}${team ? ` (${team})` : ""} — ${reason}`,
      summary: `${r.type || "Availability"}${r.player?.reason ? `: ${r.player.reason}` : ""}. Flagged by API-Football injury feed.`,
      fantasy_impact: high ? "↓ NEGATIVE — tracked asset; check before locking your XI." : "↓ NEGATIVE — squad availability in doubt.",
      source_hint: "API-Football · /injuries",
    };
  });
}

function mapFixtures(rows) {
  return rows.map((r) => {
    const home = r.teams?.home?.name || "TBD", away = r.teams?.away?.name || "TBD";
    const venue = r.fixture?.venue?.name ? `${r.fixture.venue.name}${r.fixture.venue.city ? `, ${r.fixture.venue.city}` : ""}` : "";
    return {
      id: `fix-${r.fixture?.id}`,
      timestamp: r.fixture?.date || null,
      category: "FIXTURE",
      priority: "LOW",
      player_name: null,
      team: `${home} vs ${away}`,
      headline: `${home} vs ${away}`,
      summary: `Kick-off ${fmtDate(r.fixture?.date)}${venue ? ` · ${venue}` : ""}.`,
      fantasy_impact: "— NEUTRAL — set your captain and transfers before this deadline.",
      source_hint: "API-Football · /fixtures",
    };
  });
}

function mapTopScorers(rows) {
  if (!rows.length) return [];
  const top = rows.slice(0, 5).map((r, i) => {
    const g = r.statistics?.[0]?.goals?.total ?? 0;
    return `${i + 1}. ${r.player?.name} (${g})`;
  }).join(" · ");
  return [{
    id: "topscorers", timestamp: null, category: "FORM", priority: "LOW",
    player_name: null, team: null, headline: "🥇 Golden Boot race",
    summary: top, fantasy_impact: "↑ POSITIVE — in-form scorers are captaincy candidates.",
    source_hint: "API-Football · /players/topscorers",
  }];
}

function writeFallback() {
  try {
    const ex = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const real = (ex.items || []).filter((i) => i.source_hint && !i.source_hint.startsWith("WC26 Scout"));
    if (real.length) { console.log(`kept existing news.json (${ex.items.length} items, ${real.length} real)`); return; }
  } catch { /* no/invalid existing file */ }
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), items: PLACEHOLDER_NEWS }, null, 2));
  console.log("wrote placeholder news.json (3 items)");
}

(async () => {
  if (!KEY) { console.error("✗ API_FOOTBALL_KEY not set — keeping existing news.json / placeholder."); writeFallback(); process.exit(0); }
  const seed = loadSeedNames();
  const q = `league=${LEAGUE}&season=${SEASON}`;
  let items = [];
  // each endpoint isolated: one failing must not kill the others
  try { items = items.concat(mapInjuries(await api(`/injuries?${q}`), seed)); } catch (e) { console.error("injuries:", e.message); }
  try { items = items.concat(mapFixtures(await api(`/fixtures?${q}&next=10`))); } catch (e) { console.error("fixtures:", e.message); }
  try { items = items.concat(mapTopScorers(await api(`/players/topscorers?${q}`))); } catch (e) { console.error("topscorers:", e.message); }

  // order: HIGH injuries → other injuries → fixtures → topscorers
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const catRank = { INJURY: 0, FIXTURE: 1, FORM: 2 };
  items.sort((a, b) => (rank[a.priority] - rank[b.priority]) || (catRank[a.category] - catRank[b.category]));

  if (!items.length) { console.log("0 items from API-Football → fallback"); writeFallback(); process.exit(0); }
  fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), items }, null, 2));
  console.log(`✓ API-Football news: ${items.length} items → public/data/news.json`);
  if (TEST) console.log(JSON.stringify(items.slice(0, 5), null, 2));
})();
