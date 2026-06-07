// build_pool.cjs — build the FULL WC2026 fantasy player pool (~1481) as public/data/players.json
//   source: cached FIFA Fantasy feeds (players + squads)
//   • real fields from FIFA: id, name, team, pos, price, own, status
//   • per-team generated: ELO-based fixtures+odds, advP, csP, captainSlot
//   • heuristic per-player: startProb, minsIfStarted (from price/status/own)
//   • stat priors by position/price (01_data_pull.R later overrides with real FBref/Understat)
//   • the 58 hand-curated stars keep ALL their tuned fields (matched by team+name)
const fs = require("fs");
const D = __dirname + "/data";
const players = JSON.parse(fs.readFileSync(D + "/fifa_players_raw.json", "utf8"));
const squads  = JSON.parse(fs.readFileSync(D + "/fifa_squads_raw.json", "utf8"));
const curated = JSON.parse(fs.readFileSync(D + "/seed58_curated.json", "utf8"));

// ── name canonicalisation: FIFA → our ELO/fixtures/cluster tables ──────────────
const TEAM_FIX = { "Cabo Verde":"Cape Verde","Congo DR":"DR Congo","Curaçao":"Curacao",
  "Czechia":"Czech Republic","Côte d'Ivoire":"Ivory Coast","IR Iran":"Iran",
  "Korea Republic":"South Korea","Türkiye":"Turkey","USA":"United States" };
const squadName = {}; squads.forEach(s => squadName[s.id] = TEAM_FIX[s.name] || s.name);

// ── load ELO + group opponents (from our seed CSVs) ───────────────────────────
const elo = {}; fs.readFileSync(D + "/team_elos.csv","utf8").split("\n").slice(1).filter(Boolean)
  .forEach(l => { const [t,e] = l.split(","); elo[t] = +e; });
const opps = {}; fs.readFileSync(D + "/wc_groups.csv","utf8").split("\n").slice(1).filter(Boolean)
  .forEach(l => { const c = l.split(","); opps[c[1]] = [c[2],c[3],c[4]]; });

// ── ELO → match odds (W/D/L) and team advancement prob ────────────────────────
function odds(a, b) {
  const ea = 1/(1+Math.pow(10,(b-a)/400));            // expected score
  const d = Math.max(0.10, Math.min(0.30, 0.30*Math.exp(-Math.abs(a-b)/300)));
  const w = ea*(1-d), l = (1-ea)*(1-d);
  return [+w.toFixed(2), +d.toFixed(2), +(1-w-d).toFixed(2)];
}
const advP = t => Math.round(Math.max(15, Math.min(92, 100/(1+Math.exp(-((elo[t]||1600)-1650)/95)))));
const fixturesFor = t => (opps[t]||["TBC","TBC","TBC"]).map((o,i) => {
  const [w,dr,l] = elo[t]&&elo[o] ? odds(elo[t],elo[o]) : [0.33,0.33,0.34];
  return { md:i+1, opponent:o, oddsWin:w, oddsDraw:dr, oddsLoss:l };
});
const csPof = fx => +(fx.reduce((s,f)=>s+f.oddsWin*0.72+f.oddsDraw*0.28,0)/fx.length).toFixed(3);

// ── curated-star lookup (preserve hand-tuned depth) ───────────────────────────
const norm = s => (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z ]/g," ").trim();
const last = s => norm(s).split(" ").pop();
// one-to-one: each curated star → its single best FIFA player (team+pos+token, tie-break on price)
const fifaCurated = {};   // fifaId → curated star
curated.forEach(c => {
  const ctoks = new Set(norm(c.name).split(" ").filter(t => t.length > 1));
  let best = null, score = 0;
  players.forEach(fp => {
    if ((squadName[fp.squadId]||"") !== c.team || fp.position !== c.pos) return;
    const fn = fp.knownName || `${fp.firstName||""} ${fp.lastName||""}`;
    const s = norm(fn).split(" ").filter(t => ctoks.has(t)).length;
    if (s > score || (s === score && s > 0 && best && Math.abs(fp.price-c.price) < Math.abs(best.price-c.price))) { score = s; best = fp; }
  });
  if (best && score > 0) fifaCurated[best.id] = c;
});
const CURATED_FIELDS = ["xGp90","xAp90","SoTp90","csP","intlGR","savesP90","penTaker","fkTaker",
  "cornerTaker","cardRisk","roleShift","roleShiftNote","startProb","minsIfStarted","captainSlot","scout","form","nat","advP"];

// ── stat priors by position + price ───────────────────────────────────────────
function priors(pos, price) {
  const p = price;
  if (pos==="FWD") return { xGp90:+(0.12+0.05*(p-3.5)).toFixed(2), xAp90:+(0.08+0.012*p).toFixed(2), SoTp90:+(0.7+0.16*p).toFixed(2), savesP90:0 };
  if (pos==="MID") return { xGp90:+(0.06+0.025*(p-3.5)).toFixed(2), xAp90:+(0.10+0.022*p).toFixed(2), SoTp90:+(0.4+0.12*p).toFixed(2), savesP90:0 };
  if (pos==="DEF") return { xGp90:+(0.04+0.006*p).toFixed(2), xAp90:+(0.05+0.012*p).toFixed(2), SoTp90:+(0.25+0.04*p).toFixed(2), savesP90:0 };
  return { xGp90:0, xAp90:0, SoTp90:0, savesP90:3.2 }; // GK
}

const usedCurated = new Set();
const out = players.map(fp => {
  const team = squadName[fp.squadId] || "TBC";
  const name = fp.knownName || `${fp.firstName||""} ${fp.lastName||""}`.trim();
  const pos = fp.position, price = fp.price, own = +(fp.percentSelected||0).toFixed(1);
  const fx = fixturesFor(team);
  const cur = fifaCurated[fp.id];
  const pr = priors(pos, price);
  // heuristic start prob (price/status/own); curated overrides win
  let startProb = 0.45 + 0.05*(price-4) + 0.003*own + (fp.status==="playing"?0.10:-0.30);
  startProb = +Math.max(0.20, Math.min(0.97, startProb)).toFixed(2);
  const rec = {
    id: fp.id, name, team, nat:"", pos, price, own,
    advP: advP(team),
    xGp90: pr.xGp90, xAp90: pr.xAp90, SoTp90: pr.SoTp90,
    penTaker:false, csP: csPof(fx), fdrGrp:6, intlGR:+(pr.xGp90*0.9).toFixed(2),
    form:"🔥🔥", scout: own<10, savesP90: pr.savesP90,
    startProb, minsIfStarted: (price>=6||own>10)?90:75,
    roleShift:"SAME", roleShiftNote:"", fkTaker:false, cornerTaker:false,
    cardRisk:"low", captainSlot: 2, fixtures: fx, status: fp.status,
    oneToWatch: !!fp.oneToWatch, data_tier: cur ? "curated" : (own>0?"pool":"pool"),
  };
  if (cur) { CURATED_FIELDS.forEach(f => { if (cur[f]!==undefined && cur[f]!==null) rec[f]=cur[f]; }); rec.data_tier="curated"; usedCurated.add(cur.name+"|"+cur.team); }
  return rec;
});

fs.writeFileSync(__dirname + "/../public/data/players.json", JSON.stringify(out, null, 1) + "\n");
const nC = out.filter(p=>p.data_tier==="curated").length;
const nT = new Set(out.map(p=>p.team)).size;
console.log(`pool built: ${out.length} players, ${nT} nations, ${nC} curated stars matched`);
console.log("by position:", ["GK","DEF","MID","FWD"].map(p=>p+":"+out.filter(x=>x.pos===p).length).join(" "));
const unmatched = curated.filter(c => !usedCurated.has(c.name+"|"+c.team));
if (unmatched.length) console.log("curated NOT matched into pool:", unmatched.map(c=>c.name+"("+c.team+")").join(", "));
else console.log("all 58 curated stars matched ✓");
