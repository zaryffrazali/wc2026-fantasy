import { useState, useMemo, useEffect } from "react";

// ─── PALETTE (module scope so all tab components share it) ─────────────────────
const BG = "#060d1a", CARD = "#0d1829", BORDER = "#1e2d42", TEXT = "#e2e8f0", DIM = "#64748b";
const SANS = "'Inter','DM Sans',system-ui,sans-serif";
const MONO = "'DM Mono','Fira Code','Courier New',monospace";  // badges / tier codes / pos tags only
const POS_COLOR = { FWD:"#f97316", MID:"#22c55e", DEF:"#3b82f6", GK:"#a855f7" };
const ROLE_MULT = {
  SAME:[1,1], DEF_to_ATT:[1.40,1.60], ATT_to_DEF:[0.60,0.70],
  MID_to_ATT:[1.25,1.20], MID_to_DEF:[0.75,0.80], WING_to_STRIKER:[1.30,0.80],
};
const cleanCluster = (c) => (c || "").replace(/_\d+$/, "").replace(/_/g, " ");

// ─── PREDICTION ENGINE (uses upgraded schema: minutes, per-MD odds, role, etc.) ─
function computePrediction(p, riskMode) {
  const fx = p.fixtures || [];
  const rm = ROLE_MULT[p.roleShift] || [1, 1];
  const fm = p.form_mult || 1;                  // international form (10_form_tracker)
  let xG = (p.xGp90 || 0) * rm[0] * fm;
  let xA = (p.xAp90 || 0) * rm[1] * fm;
  if (typeof p.intl_premium_xG === "number") xG *= 1 + p.intl_premium_xG * 0.3; // model adj

  // per-matchday fixture difficulty (MD1/MD2/MD3 weighted equally)
  let csP = 0, goalP = 0;
  fx.forEach((f) => { csP += f.oddsWin * 0.72 + f.oddsDraw * 0.28; goalP += f.oddsWin * 1.4 + f.oddsDraw * 0.5; });
  csP = fx.length ? csP / fx.length : (p.csP || 0.3);
  goalP = fx.length ? goalP / fx.length : 1.0;

  const sp = p.startProb ?? 0.85;
  const E_mins = sp * (p.minsIfStarted ?? 90);
  const minsFactor = E_mins / 90;            // scales per-90 returns for rotation/sub risk

  let returns = 0;                            // per-match returns (minute-scaled below)
  if (p.pos === "GK")      returns = csP * 5 + ((p.savesP90 || 3.2) / 3) - (1 - csP) * 0.8;
  else if (p.pos === "DEF") returns = csP * 5 + xG * 7 * goalP + xA * 3 - (1 - csP) * 0.5;
  else if (p.pos === "MID") returns = xG * 6 * goalP + xA * 3 + csP + (xA * 2.5 / 2) + 0.4;
  else                      returns = xG * 5 * goalP + xA * 3 + (p.SoTp90 / 2);

  if (p.penTaker) returns += 0.5;
  if (p.fkTaker) returns += 0.4;
  if (p.cornerTaker) returns += 0.3;
  returns -= p.cardRisk === "high" ? 0.4 : p.cardRisk === "medium" ? 0.2 : 0;
  const pts = sp * 2 + returns * minsFactor;  // appearance + minute-scaled returns

  const E_MATCHES = 3 + (p.advP / 100) * 5;
  const scoutBonusEV = p.own < 5 ? 1.8 : p.own < 10 ? 0.6 : 0;
  const shiftDiff = /ATT|STRIKER/.test(p.roleShift || "") && p.own < 15 ? 1.4 : 1; // role arbitrage
  const capMult = p.captainSlot === 3 ? 1.15 : p.captainSlot === 2 ? 1.08 : 1.0;
  const causalAdj = 0.5 * (p.causal_pts_adjustment || 0);  // discounted causal nudge (matches R)

  const pts_mean   = pts * E_MATCHES + scoutBonusEV * shiftDiff + causalAdj;
  const pts_median = pts * E_MATCHES * 0.88 + causalAdj;
  const pts_p90    = pts * E_MATCHES * 1.28 + scoutBonusEV * 1.5 * shiftDiff + causalAdj;
  const captainValue = pts_p90 * capMult;

  const displayPts = riskMode === "safe" ? pts_median : riskMode === "diff" ? pts_p90 : pts_mean;
  return { pts_median, pts_mean, pts_p90, displayPts, value: displayPts / p.price,
           scoutBonusEV, captainValue, E_MATCHES, E_mins, csP, goalP, xGadj: xG, xAadj: xA };
}

// ─── SMALL UI BITS ─────────────────────────────────────────────────────────────
function OwnBar({ pct }) {
  const color = pct > 30 ? "#f97316" : pct > 10 ? "#eab308" : "#22c55e";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
      <div style={{ width:46, height:6, background:"#1e293b", borderRadius:3, overflow:"hidden" }}>
        <div style={{ width:`${Math.min(pct,100)}%`, height:"100%", background:color }} />
      </div>
      <span style={{ fontSize:11, color }}>{pct}%</span>
    </div>
  );
}
const Badge = ({ children, bg, fg, bd }) => (
  <span style={{ background:bg, border:`1px solid ${bd}`, color:fg, fontSize:9, padding:"1px 5px",
    borderRadius:4, fontWeight:700, letterSpacing:0.5, whiteSpace:"nowrap", fontFamily:MONO }}>{children}</span>
);
const ScoutBadge = () => <Badge bg="#16a34a22" bd="#22c55e88" fg="#4ade80">🎯 SCOUT</Badge>;
const PenBadge   = () => <Badge bg="#7c3aed22" bd="#a855f788" fg="#c084fc">PEN</Badge>;
function RoleArrow({ shift, note }) {
  if (!shift || shift === "SAME") return <span style={{ color:DIM }} title="Same as club role">—</span>;
  const up = /ATT|STRIKER/.test(shift);
  return <span title={note || shift} style={{ color: up ? "#f97316" : "#3b82f6", fontWeight:700, cursor:"help" }}>{up ? "↑" : "↓"}</span>;
}
function MispriceTag({ flag, score }) {
  if (!flag || flag === "FAIR" || flag === "INSUFFICIENT_DATA")
    return <span style={{ fontSize:11, color:DIM }}>{score!=null ? `${score>0?"+":""}${score.toFixed(1)}σ` : "—"}</span>;
  const c = flag === "UNDERRATED" ? "#4ade80" : "#ff6b6b";
  return <span style={{ fontSize:11, color:c, fontWeight:600 }}>{score>0?"+":""}{score?.toFixed(1)}σ</span>;
}
function MDDots({ fixtures }) {
  return (
    <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
      {(fixtures||[]).map((f,i) => {
        const c = f.oddsWin > 0.65 ? "#22c55e" : f.oddsWin >= 0.40 ? "#eab308" : "#ef4444";
        return <div key={i} title={`MD${f.md} vs ${f.opponent} — ${Math.round(f.oddsWin*100)}% win`}
          style={{ width:9, height:9, borderRadius:"50%", background:c }} />;
      })}
    </div>
  );
}

function Sparkline({ matches, w=72, h=22 }) {
  if (!matches || !matches.length) return <span style={{ color:DIM, fontSize:10 }}>no intl data</span>;
  const vals = matches.map(m => m.gi);
  const max = Math.max(...vals, 0.5), min = Math.min(...vals, 0), span = (max-min)||1;
  const xy = i => [vals.length>1 ? (i/(vals.length-1))*w : w/2, h - ((vals[i]-min)/span)*h];
  const pts = vals.map((_,i)=>xy(i).map(n=>n.toFixed(1)).join(",")).join(" ");
  const last = vals[vals.length-1], col = last>0.6?"#4ade80":last>0.3?"#eab308":"#ef4444";
  return (
    <svg width={w} height={h} style={{ display:"block" }}>
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" />
      {vals.map((_,i)=>{ const [x,y]=xy(i); return <circle key={i} cx={x} cy={y} r="1.7" fill={col} />; })}
    </svg>
  );
}

// ─── TAB: PLAYER TABLE ──────────────────────────────────────────────────────────
function PlayerTableTab({ players, selected, setSelected, riskMode, setRiskMode,
                          posFilter, setPosFilter, sortBy, setSortBy, search, setSearch,
                          ownMax, setOwnMax, mispricedOnly, setMispricedOnly }) {
  const riskLabel = { safe:"🛡️ Safe", balanced:"⚖️ Balanced", diff:"🎯 Differential" };
  const riskDesc  = { safe:"Median pts — low-variance template picks",
                      balanced:"Mean expected pts — default projection",
                      diff:"90th-pct + scouting bonus — ceiling chasing" };
  return (
    <>
      {/* risk mode */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"12px 16px", marginBottom:12 }}>
        <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:8 }}>RISK PREFERENCE</div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
          {["safe","balanced","diff"].map(m => (
            <button key={m} onClick={()=>setRiskMode(m)} style={{ padding:"6px 13px", borderRadius:6,
              border:`1px solid ${riskMode===m?"#f97316":BORDER}`, background:riskMode===m?"#f9731618":"transparent",
              color:riskMode===m?"#f97316":DIM, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{riskLabel[m]}</button>
          ))}
        </div>
        <div style={{ fontSize:13, color:"#94a3b8" }}>{riskDesc[riskMode]}</div>
      </div>

      {/* filters */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12, alignItems:"center" }}>
        <input placeholder="Search player or team..." value={search} onChange={e=>setSearch(e.target.value)}
          style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:6, padding:"7px 11px",
            color:TEXT, fontFamily:"inherit", fontSize:12, flex:"1 1 160px", minWidth:0, outline:"none" }} />
        {["ALL","FWD","MID","DEF","GK"].map(pos => (
          <button key={pos} onClick={()=>setPosFilter(pos)} style={{ padding:"7px 12px", borderRadius:6,
            fontFamily:"inherit", fontSize:12, cursor:"pointer",
            border:`1px solid ${posFilter===pos?(POS_COLOR[pos]||"#f97316"):BORDER}`,
            background:posFilter===pos?`${(POS_COLOR[pos]||"#f97316")}18`:"transparent",
            color:posFilter===pos?(POS_COLOR[pos]||"#f97316"):DIM }}>{pos}</button>
        ))}
        <button onClick={()=>setMispricedOnly(v=>!v)} title="Role shift OR model-underrated, sub-20% owned"
          style={{ padding:"7px 12px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer",
          border:`1px solid ${mispricedOnly?"#4ade80":BORDER}`, background:mispricedOnly?"#16a34a22":"transparent",
          color:mispricedOnly?"#4ade80":DIM }}>★ MISPRICED</button>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginLeft:"auto" }}>
          <span style={{ fontSize:11, color:DIM, whiteSpace:"nowrap" }}>Own ≤ {ownMax}%</span>
          <input type="range" min={1} max={100} value={ownMax} onChange={e=>setOwnMax(+e.target.value)}
            style={{ width:70, accentColor:"#f97316" }} />
        </div>
      </div>

      {/* sort tabs */}
      <div style={{ display:"flex", gap:2, borderBottom:`1px solid ${BORDER}` }}>
        {[["displayPts","xPts"],["value","Value/£"],["price","Price"],["own","Own"],["tier","Tier"]].map(([k,l])=>(
          <button key={k} onClick={()=>setSortBy(k)} style={{ padding:"6px 12px", border:"none",
            borderBottom:`2px solid ${sortBy===k?"#f97316":"transparent"}`, background:"transparent",
            color:sortBy===k?"#f97316":DIM, cursor:"pointer", fontFamily:"inherit", fontSize:11 }}>{l}</button>
        ))}
        <span style={{ marginLeft:"auto", fontSize:10, color:DIM, alignSelf:"center", paddingRight:4 }}>{players.length>200?`top 200 of ${players.length}`:`${players.length} players`}</span>
      </div>

      {/* table */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:"0 0 10px 10px", overflow:"hidden" }}>
        <div style={{ display:"grid", gridTemplateColumns:"24px 1fr 50px 46px 42px 60px 56px 44px 34px 56px",
          gap:0, padding:"8px 12px", borderBottom:`1px solid ${BORDER}`, fontSize:9, letterSpacing:1, color:DIM, background:"#0a121f" }}>
          <div>#</div><div>PLAYER</div><div style={{textAlign:"right"}}>£</div>
          <div style={{textAlign:"right"}}>xMIN</div><div style={{textAlign:"center"}}>ROLE</div>
          <div style={{textAlign:"right"}}>xPTS</div><div style={{textAlign:"right"}}>PREM</div>
          <div style={{textAlign:"right"}}>OWN</div><div style={{textAlign:"center"}}>TIER</div>
          <div style={{textAlign:"right"}}>FIX</div>
        </div>
        {players.slice(0,200).map((p,i) => {
          const posCol = POS_COLOR[p.pos];
          return (
            <div key={p.id} onClick={()=>setSelected(selected?.id===p.id?null:p)}
              style={{ display:"grid", gridTemplateColumns:"24px 1fr 50px 46px 42px 60px 56px 44px 34px 56px",
                gap:0, padding:"13px 12px", borderBottom:`1px solid ${BORDER}33`,
                background:selected?.id===p.id?"#f9731610": i<3?"#0f1c2d":"transparent",
                cursor:"pointer", alignItems:"center" }}>
              <div style={{ fontSize:10, color:i<3?"#f97316":DIM }}>{i+1}</div>
              <div style={{ minWidth:0 }}>
                <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                  <span style={{ color:"#fff", fontWeight:700, fontSize:16 }}>{p.nat} {p.name}</span>
                  <span style={{ fontSize:10, color:posCol, border:`1px solid ${posCol}44`, padding:"0 5px", borderRadius:3, fontFamily:MONO }}>{p.pos}</span>
                  {p.scout && p.own<10 && <ScoutBadge/>}
                  {p.mispricing_flag==="UNDERRATED" && <Badge bg="#16a34a22" bd="#22c55e88" fg="#4ade80">★ EDGE</Badge>}
                  {p.penTaker && <PenBadge/>}
                  {p.data_tier && p.data_tier!=="curated" && <Badge bg="#1e293b" bd="#334155" fg="#64748b">prior</Badge>}
                  {p.form_n>0 && <Badge bg="#0a1f1c" bd={p.form_mult>1.05?"#22c55e88":p.form_mult<0.95?"#ef444488":"#33415588"} fg={p.form_mult>1.05?"#4ade80":p.form_mult<0.95?"#ff6b6b":"#94a3b8"}>≈×{p.form_mult}</Badge>}
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:3 }}>
                  <span style={{ fontSize:10, color:DIM }}>{p.team}</span>
                  {p.team_cluster && <span style={{ fontSize:9, color:"#7b8cde" }}>{cleanCluster(p.team_cluster)}</span>}
                  <span style={{ fontSize:11 }}>{p.form}</span>
                </div>
              </div>
              <div style={{ textAlign:"right", fontSize:15, color:"#94a3b8", fontWeight:600 }}>${p.price}m</div>
              <div style={{ textAlign:"right", fontSize:12, color:p.E_mins<60?"#eab308":"#94a3b8" }}>{Math.round(p.E_mins)}'</div>
              <div style={{ textAlign:"center" }}><RoleArrow shift={p.roleShift} note={p.roleShiftNote}/></div>
              <div style={{ textAlign:"right", fontSize:18, fontWeight:800,
                color:p.displayPts>30?"#f97316":p.displayPts>20?"#22c55e":TEXT }}>{p.displayPts.toFixed(1)}</div>
              <div style={{ textAlign:"right" }}><MispriceTag flag={p.mispricing_flag} score={p.intl_premium_score}/></div>
              <div style={{ display:"flex", justifyContent:"flex-end" }}><OwnBar pct={p.own}/></div>
              <div style={{ textAlign:"center", fontSize:13, fontWeight:800, fontFamily:MONO,
                color:p.tier==="S"?"#fbbf24":p.tier==="A"?"#cbd5e1":p.tier==="B"?"#d97706":DIM }}>{p.tier||"-"}</div>
              <div><MDDots fixtures={p.fixtures}/></div>
            </div>
          );
        })}
      </div>

      {selected && <PlayerDetail p={selected} riskMode={riskMode} onClose={()=>setSelected(null)} />}
    </>
  );
}

// ─── PLAYER DETAIL (with MODEL DEEP DIVE + fixtures + role analysis) ────────────
function PlayerDetail({ p, riskMode, onClose }) {
  const pred = computePrediction(p, riskMode);
  const posCol = POS_COLOR[p.pos];
  const rm = ROLE_MULT[p.roleShift] || [1,1];
  return (
    <div style={{ background:CARD, border:`1px solid ${posCol}44`, borderRadius:10, padding:"18px 20px",
      marginTop:10, boxShadow:`0 0 30px ${posCol}18` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:900, color:"#fff" }}>{p.nat} {p.name}</div>
          <div style={{ fontSize:12, color:DIM, marginTop:3 }}>{p.team} · {p.pos} · ${p.price}m · {p.own}% owned · {cleanCluster(p.team_cluster)}</div>
        </div>
        <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${BORDER}`, color:DIM,
          padding:"4px 10px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:11 }}>close ✕</button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:10 }}>
        {/* points */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>PREDICTED POINTS</div>
          {[["Median (safe)",pred.pts_median,"#64748b"],["Mean (balanced)",pred.pts_mean,"#f97316"],
            ["P90 (diff)",pred.pts_p90,"#22c55e"],["Captain value",pred.captainValue,"#fbbf24"]].map(([l,v,c])=>(
            <div key={l} style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
              <span style={{ fontSize:11, color:DIM }}>{l}</span><span style={{ fontSize:14, fontWeight:700, color:c }}>{v.toFixed(1)}</span>
            </div>
          ))}
          <div style={{ borderTop:`1px solid ${BORDER}`, marginTop:8, paddingTop:8, fontSize:11, color:DIM }}>
            xMins/game <b style={{color:TEXT}}>{Math.round(pred.E_mins)}'</b> · Exp matches <b style={{color:TEXT}}>{pred.E_MATCHES.toFixed(1)}</b>
            {pred.scoutBonusEV>0 && <div style={{ color:"#4ade80", marginTop:4 }}>✓ Scout Bonus EV +{pred.scoutBonusEV.toFixed(1)}</div>}
          </div>
        </div>

        {/* fixture schedule */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>FIXTURE SCHEDULE</div>
          {(p.fixtures||[]).map(f => {
            const c = f.oddsWin>0.65?"#22c55e":f.oddsWin>=0.40?"#eab308":"#ef4444";
            return (
              <div key={f.md} style={{ marginBottom:9 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
                  <span style={{ color:TEXT }}>MD{f.md} · {f.opponent}</span>
                  <span style={{ color:DIM }}>{Math.round(f.oddsWin*100)}/{Math.round(f.oddsDraw*100)}/{Math.round(f.oddsLoss*100)}</span>
                </div>
                <div style={{ height:5, background:"#1e293b", borderRadius:3, overflow:"hidden" }}>
                  <div style={{ width:`${f.oddsWin*100}%`, height:"100%", background:c }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* role analysis */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>ROLE ANALYSIS</div>
          {p.roleShift && p.roleShift!=="SAME" ? (
            <>
              <div style={{ fontSize:12, color:"#f97316", fontWeight:700, marginBottom:6 }}>{p.roleShift.replace(/_/g," ")}</div>
              <div style={{ fontSize:12, color:"#c8c8c8", marginBottom:8 }}>{p.roleShiftNote}</div>
              <div style={{ fontSize:11, color:DIM }}>xG ×{rm[0]} · xA ×{rm[1]}</div>
              {p.own<15 &&
                <div style={{ marginTop:8, fontSize:11, color:"#fbbf24", fontWeight:700 }}>⚠ POTENTIAL MISPRICING</div>}
            </>
          ) : <div style={{ fontSize:12, color:DIM }}>Club role consistent with international deployment.</div>}
        </div>

        {/* MODEL DEEP DIVE */}
        <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
          <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>MODEL DEEP DIVE</div>
          <ul style={{ margin:0, paddingLeft:16, fontSize:11, color:"#c8c8c8", lineHeight:1.7 }}>
            <li>xG/90 club {p.xGp90} → adjusted {pred.xGadj.toFixed(2)}</li>
            <li>Tier <b style={{color:p.tier==="S"?"#fbbf24":TEXT}}>{p.tier||"-"}</b> (score {p.tier_score ?? "—"})</li>
            <li>Playstyle: {cleanCluster(p.team_cluster)}</li>
            <li>Captain EV (R model): {p.captain_ev ?? "—"}</li>
            {p.form_n>0 && <li>Intl form: <b style={{color:p.form_mult>1.05?"#4ade80":p.form_mult<0.95?"#ff6b6b":TEXT}}>×{p.form_mult}</b> (last {p.form_n} intl match{p.form_n>1?"es":""})</li>}
          </ul>
          {p.mispricing_flag==="UNDERRATED" &&
            <div style={{ marginTop:8, fontSize:11, color:"#4ade80" }}>★ Model underprices: +{p.intl_premium_score?.toFixed(2)}σ intl premium</div>}
          {p.mispricing_flag==="OVERRATED" &&
            <div style={{ marginTop:8, fontSize:11, color:"#ff6b6b" }}>Model overprices: {p.intl_premium_score?.toFixed(2)}σ intl premium</div>}
        </div>

        {/* CAUSAL OUTLOOK */}
        {p.team_overperf_predicted != null && (
          <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>CAUSAL OUTLOOK</div>
            <div style={{ fontSize:12, color:"#c8c8c8", marginBottom:8 }}>
              Team overperformance (model): <b style={{ color: p.team_overperf_predicted>0?"#4ade80":p.team_overperf_predicted<0?"#ff6b6b":TEXT }}>
              {p.team_overperf_predicted>0?"+":""}{p.team_overperf_predicted}</b> rounds vs ELO expectation
            </div>
            {p.giant_killer_flag && <div style={{ fontSize:11, color:"#4ade80", fontWeight:700, marginBottom:4 }}>🏔 GIANT KILLER TEAM — defenders/GK underpriced vs true clean-sheet odds</div>}
            {p.overvalued_team_flag && <div style={{ fontSize:11, color:"#ff8c42", fontWeight:700, marginBottom:4 }}>⚠ OVERVALUED TEAM RISK — early-exit caps points ceiling</div>}
            <div style={{ fontSize:12, fontWeight:700, color: p.causal_pts_adjustment>0?"#4ade80":p.causal_pts_adjustment<0?"#ff6b6b":DIM }}>
              {p.causal_pts_adjustment>0?"+":""}{p.causal_pts_adjustment} pts (causal adj)
            </div>
          </div>
        )}

        {/* INTERNATIONAL FORM (sparkline) */}
        {p.form_n>0 && (
          <div style={{ background:"#0a121f", borderRadius:8, padding:"12px 14px" }}>
            <div style={{ fontSize:9, letterSpacing:3, color:DIM, marginBottom:10 }}>INTERNATIONAL FORM</div>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
              <Sparkline matches={p.formMatches}/>
              <span style={{ fontSize:18, fontWeight:800, color:p.form_mult>1.05?"#4ade80":p.form_mult<0.95?"#ff6b6b":TEXT }}>×{p.form_mult}</span>
            </div>
            {(p.formMatches||[]).map((m,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#c8c8c8" }}>
                <span>{m.date} · {m.opp}</span><span style={{ color:m.gi>0.6?"#4ade80":m.gi>0.3?"#eab308":DIM }}>{m.gi} xGI</span>
              </div>
            ))}
            <div style={{ fontSize:10, color:DIM, marginTop:6 }}>form multiplier applied to xG/xA vs club baseline</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TAB: STARTING XI (CSS pitch with positioned cards) ────────────────────────
function StartingXITab({ xi }) {
  const [open, setOpen] = useState(null);
  if (!xi) return <div style={{ color:DIM }}>No starting XI data — run the R pipeline.</div>;
  return (
    <div>
      <div style={{ marginBottom:12 }}>
        <span style={{ fontSize:16, fontWeight:800, color:"#fff" }}>Econometrics Predicts the XI</span>
        <span style={{ marginLeft:10, fontSize:12, color:DIM }}>{xi.formation} · {Math.round(xi.total_pts)} predicted pts</span>
      </div>
      <div style={{ position:"relative", width:"100%", maxWidth:560, margin:"0 auto", aspectRatio:"3/4",
        background:"linear-gradient(#0a3d1f,#072d17)", border:`2px solid #1e6b3a`, borderRadius:10 }}>
        <div style={{ position:"absolute", top:"50%", left:0, right:0, height:1, background:"#2e7d4f" }} />
        <div style={{ position:"absolute", left:"30%", right:"30%", top:0, height:"14%", border:"1px solid #2e7d4f", borderTop:"none" }} />
        {xi.players.map(pl => (
          <div key={pl.id} onClick={()=>setOpen(open===pl.id?null:pl.id)}
            style={{ position:"absolute", left:`${pl.x}%`, top:`${pl.y}%`, transform:"translate(-50%,-50%)",
              textAlign:"center", cursor:"pointer", width:84 }}>
            <div style={{ width:Math.max(34, Math.min(54, pl.pts_balanced/2)), height:Math.max(34, Math.min(54, pl.pts_balanced/2)),
              margin:"0 auto", borderRadius:"50%", background:POS_COLOR[pl.pos], display:"flex",
              alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:800, color:"#06121f",
              border: pl.is_captain ? "3px solid #fbbf24" : "2px solid #ffffff55", position:"relative" }}>
              {Math.round(pl.pts_balanced)}
              {pl.is_captain && <span style={{ position:"absolute", top:-8, right:-8, fontSize:14 }}>©</span>}
            </div>
            <div style={{ fontSize:10, color:"#fff", fontWeight:700, marginTop:3, textShadow:"0 1px 3px #000" }}>{pl.name}</div>
          </div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:10, marginTop:16 }}>
        {xi.players.map(pl => (
          <div key={pl.id} onClick={()=>setOpen(open===pl.id?null:pl.id)}
            style={{ background:CARD, border:`1px solid ${pl.is_captain?"#fbbf24":BORDER}`, borderRadius:8, padding:"10px 12px", cursor:"pointer" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{pl.name} {pl.is_captain && <span style={{color:"#fbbf24"}}>©</span>}</span>
              <span style={{ fontSize:12, color:POS_COLOR[pl.pos] }}>{pl.pos}</span>
            </div>
            <div style={{ fontSize:11, color:DIM, margin:"4px 0" }}>{pl.team} · ${pl.price}m · {pl.pts_balanced} xPts · {pl.value} val</div>
            <div style={{ fontSize:11, color:"#c8c8c8" }}>{(pl.model_signals||[])[0]}</div>
            {open===pl.id && (
              <div style={{ marginTop:8, borderTop:`1px solid ${BORDER}`, paddingTop:8, fontSize:11, color:"#aaa", lineHeight:1.6 }}>
                {(pl.model_signals||[]).map((s,i)=><div key={i}>• {s}</div>)}
                <div style={{ color:"#f97316", marginTop:6 }}>{pl.role_analysis}</div>
                {pl.mispricing_signal && <div style={{ color:"#4ade80", marginTop:4 }}>{pl.mispricing_signal}</div>}
                {pl.captain_case && <div style={{ color:"#fbbf24", marginTop:4 }}>{pl.captain_case}</div>}
                {(pl.risk_flags||[]).length>0 && <div style={{ color:"#ff8c42", marginTop:4 }}>{pl.risk_flags.join(" · ")}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TAB: OPTIMAL SQUADS ─────────────────────────────────────────────────────────
function OptimalSquadsTab({ squads }) {
  if (!squads) return <div style={{ color:DIM }}>No squad data — run the R pipeline.</div>;
  const labels = { safe:"🛡️ Safe", balanced:"⚖️ Balanced", differential:"🎯 Differential", pure_differential:"💎 Pure Diff (≤15% own)" };
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:12 }}>
      {Object.entries(squads).map(([key, sq]) => {
        if (!sq) return null;
        const total = sq.reduce((a,p)=>a+p.pts,0), budget = sq.reduce((a,p)=>a+p.price,0);
        return (
          <div key={key} style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"12px 14px" }}>
            <div style={{ fontSize:13, fontWeight:800, color:"#fff", marginBottom:2 }}>{labels[key]||key}</div>
            <div style={{ fontSize:11, color:DIM, marginBottom:10 }}>{Math.round(total)} pts · ${budget.toFixed(1)}m</div>
            {["GK","DEF","MID","FWD"].map(pos => (
              <div key={pos} style={{ marginBottom:6 }}>
                <div style={{ fontSize:9, color:POS_COLOR[pos], letterSpacing:1, marginBottom:2 }}>{pos}</div>
                {sq.filter(p=>p.pos===pos).map(p => (
                  <div key={p.id} style={{ display:"flex", justifyContent:"space-between", fontSize:11, padding:"2px 0" }}>
                    <span style={{ color:"#e2e8f0" }}>{p.name}</span>
                    <span style={{ color:DIM }}>${p.price} · {p.pts}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── TAB: TIERS ──────────────────────────────────────────────────────────────────
function TiersTab({ tiers, posFilter, setPosFilter, pureDiff, setPureDiff }) {
  const [open, setOpen] = useState(null);
  if (!tiers) return <div style={{ color:DIM }}>No tier data — run the R pipeline.</div>;
  const tierStyle = { S:{c:"#fbbf24",g:"0 0 16px #fbbf2433",t:"BUILD AROUND"}, A:{c:"#cbd5e1",g:"none",t:"STRONG CORE"}, B:{c:"#d97706",g:"none",t:"WATCHLIST"} };
  const filt = (arr) => (arr||[]).filter(p =>
    (posFilter==="ALL"||p.pos===posFilter) && (!pureDiff || p.own<=15));
  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        {["ALL","FWD","MID","DEF","GK"].map(pos=>(
          <button key={pos} onClick={()=>setPosFilter(pos)} style={{ padding:"6px 12px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer",
            border:`1px solid ${posFilter===pos?(POS_COLOR[pos]||"#f97316"):BORDER}`,
            background:posFilter===pos?`${(POS_COLOR[pos]||"#f97316")}18`:"transparent", color:posFilter===pos?(POS_COLOR[pos]||"#f97316"):DIM }}>{pos}</button>
        ))}
        <button onClick={()=>setPureDiff(v=>!v)} style={{ padding:"6px 12px", borderRadius:6, fontFamily:"inherit", fontSize:12, cursor:"pointer", marginLeft:"auto",
          border:`1px solid ${pureDiff?"#4ade80":BORDER}`, background:pureDiff?"#16a34a22":"transparent", color:pureDiff?"#4ade80":DIM }}>PURE DIFFERENTIALS ONLY</button>
      </div>
      {["S","A","B"].map(t => {
        const st = tierStyle[t], list = filt(tiers[t]);
        return (
          <div key={t} style={{ marginBottom:20 }}>
            <div style={{ fontSize:13, fontWeight:900, color:st.c, letterSpacing:2, marginBottom:10 }}>{t} TIER — {st.t} <span style={{color:DIM, fontWeight:400}}>({list.length})</span></div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:10 }}>
              {list.map(p => (
                <div key={p.id} onClick={()=>setOpen(open===p.id?null:p.id)}
                  style={{ background:CARD, border:`1.5px solid ${st.c}`, borderRadius:10, padding:"12px 14px", cursor:"pointer", boxShadow:st.g }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                    <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{p.name}</span>
                    <span style={{ fontSize:11, color:st.c, fontWeight:800 }}>{p.tier_score?.toFixed(0)}</span>
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:6, flexWrap:"wrap" }}>
                    <span style={{ fontSize:11, color:DIM }}>{p.team}</span>
                    <span style={{ fontSize:10, color:POS_COLOR[p.pos], border:`1px solid ${POS_COLOR[p.pos]}44`, padding:"0 5px", borderRadius:3 }}>{p.pos}</span>
                    <span style={{ fontSize:11, color:DIM }}>${p.price}m</span>
                    {p.own<10 && <ScoutBadge/>}
                    {p.mispricing_angle && <Badge bg="#16a34a22" bd="#22c55e88" fg="#4ade80">★ EDGE</Badge>}
                  </div>
                  <OwnBar pct={p.own}/>
                  <div style={{ fontSize:11, color:"#94a3b8", marginTop:8, fontStyle:"italic" }}>{p.headline}</div>
                  {open===p.id && (
                    <div style={{ marginTop:10, borderTop:`1px solid ${BORDER}`, paddingTop:10, fontSize:11, color:"#c8c8c8", lineHeight:1.65 }}>
                      <div style={{ marginBottom:6 }}><b style={{color:st.c}}>Ceiling:</b> {p.ceiling_case}</div>
                      <div style={{ marginBottom:6 }}><b style={{color:"#4ade80"}}>Differential:</b> {p.differential_edge}</div>
                      {p.mispricing_angle && <div style={{ marginBottom:6, color:"#4ade80" }}>{p.mispricing_angle}</div>}
                      <div style={{ marginBottom:6, color:"#ff8c42" }}>{p.floor_warning}</div>
                      <div style={{ color:"#fbbf24" }}>{p.captain_verdict}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── TAB: CAUSAL (overperformance model + giant killers + historical scatter) ──
function CausalTab({ causal, players }) {
  if (!causal) return <div style={{ color:DIM }}>No causal analysis — run the R pipeline (09).</div>;
  const coefs = (causal.stage2_coefficients || []).filter(c => c.term !== "(Intercept)");
  const maxAbs = Math.max(...coefs.map(c => Math.abs(c.Estimate)), 1);
  const preds = causal.overperformance_predictions || [];
  const killers = preds.filter(t => t.giant_killer_flag);
  const overv = preds.filter(t => t.overvalued_flag);
  const hist = causal.historical || [];
  const teamPlayers = (tm) => players.filter(p => p.team === tm).map(p => p.name);
  // scatter scales
  const elos = hist.map(h => h.elo_entering); const eMin = Math.min(...elos, 1480), eMax = Math.max(...elos, 1990);
  const sx = e => 6 + ((e - eMin) / (eMax - eMin)) * 88;          // % x
  const sy = r => 92 - (r / 5) * 84;                              // % y (rounds 0-5)
  const notable = { "Iceland2016":1, "Morocco2022":1, "Germany2022":1, "Croatia2018":1, "Denmark2021":1, "Argentina2022":1 };

  return (
    <div>
      {/* SECTION 1 — coefficient plot */}
      <div style={{ marginBottom:8, fontSize:15, fontWeight:800, color:"#fff" }}>What Predicts Beating Expectations</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:12 }}>
        Stage-2 causal predictors (controlling for team quality) · major tournaments 2016–2024 ·
        adj R² {causal.model_summary?.stage2_adj_r2}. <span style={{ color:"#ff8c42" }}>{causal.model_summary?.model_warning}</span>
      </div>
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"14px 16px", marginBottom:24 }}>
        {coefs.map(c => {
          const pos = c.Estimate >= 0, w = (Math.abs(c.Estimate) / maxAbs) * 50;
          return (
            <div key={c.term} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
              <div style={{ width:170, fontSize:11, color:"#c8c8c8", textAlign:"right" }}>{c.term.replace(/_/g," ")}</div>
              <div style={{ flex:1, display:"flex", alignItems:"center", position:"relative", height:18 }}>
                <div style={{ position:"absolute", left:"50%", top:0, bottom:0, width:1, background:BORDER }} />
                <div style={{ position:"absolute", left:pos?"50%":`${50-w}%`, width:`${w}%`, height:14,
                  background:pos?"#22c55e":"#ef4444", borderRadius:2 }} />
              </div>
              <div style={{ width:54, fontSize:11, color:pos?"#4ade80":"#ff6b6b", textAlign:"left" }}>
                {pos?"+":""}{c.Estimate.toFixed(2)}</div>
            </div>
          );
        })}
        <div style={{ fontSize:10, color:DIM, marginTop:6 }}>← hurts overperformance · helps overperformance →</div>
      </div>

      {/* SECTION 2 — giant killers vs overvalued */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:16, marginBottom:24 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:900, color:"#4ade80", letterSpacing:1, marginBottom:10 }}>🏔 GIANT KILLERS (iceland ≥ 4)</div>
          {killers.length===0 && <div style={{ color:DIM, fontSize:12 }}>None flagged.</div>}
          {killers.map(t => (
            <div key={t.team} style={{ background:CARD, border:"1px solid #22c55e55", borderRadius:8, padding:"10px 12px", marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#fff", fontWeight:700 }}>{t.team}</span>
                <span style={{ color:"#4ade80", fontSize:12 }}>iceland {t.iceland_score}/6 · +{t.overperformance_predicted} rounds</span>
              </div>
              <div style={{ fontSize:11, color:DIM, marginTop:4 }}>ELO {t.elo_entering} · expected {t.rounds_expected} rounds · {t.confidence} confidence</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>Underpriced players: {teamPlayers(t.team).join(", ")||"—"}</div>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize:13, fontWeight:900, color:"#ff8c42", letterSpacing:1, marginBottom:10 }}>⚠ OVERVALUED (germany 2022 print)</div>
          {overv.length===0 && <div style={{ color:DIM, fontSize:12 }}>None flagged.</div>}
          {overv.map(t => (
            <div key={t.team} style={{ background:CARD, border:"1px solid #ff8c4255", borderRadius:8, padding:"10px 12px", marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#fff", fontWeight:700 }}>{t.team}</span>
                <span style={{ color:"#ff8c42", fontSize:12 }}>{t.overperformance_predicted} rounds</span>
              </div>
              <div style={{ fontSize:11, color:DIM, marginTop:4 }}>ELO {t.elo_entering} · dispersed squad, low cohesion</div>
              <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>Premium risk: {teamPlayers(t.team).join(", ")||"—"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 3 — historical scatter */}
      <div style={{ fontSize:13, fontWeight:800, color:"#fff", marginBottom:4 }}>The Iceland Test — Historical Overperformers</div>
      <div style={{ fontSize:11, color:DIM, marginBottom:10 }}>ELO entering (x) vs rounds reached (y) · green = beat expectation, red = fell short · 2016–2024</div>
      <div style={{ position:"relative", width:"100%", maxWidth:640, height:300, background:CARD, border:`1px solid ${BORDER}`, borderRadius:10 }}>
        {[0,1,2,3,4,5].map(r => (
          <div key={r} style={{ position:"absolute", left:0, right:0, top:`${sy(r)}%`, borderTop:`1px dashed ${BORDER}55`, fontSize:9, color:DIM }}>
            <span style={{ position:"absolute", left:2, top:-6 }}>{["Grp","R16","QF","SF","Fin","Win"][r]}</span></div>
        ))}
        {hist.map((h,i) => {
          const key = h.team + h.year, label = notable[key];
          const c = h.overperformance > 0.3 ? "#22c55e" : h.overperformance < -0.3 ? "#ef4444" : "#94a3b8";
          const sz = 6 + Math.min(Math.abs(h.overperformance) * 5, 12);
          return (
            <div key={i} title={`${h.team} ${h.year}: reached ${h.rounds_reached}, expected ${h.rounds_expected} (${h.overperformance>0?"+":""}${h.overperformance})`}
              style={{ position:"absolute", left:`${sx(h.elo_entering)}%`, top:`${sy(h.rounds_reached)}%`,
                transform:"translate(-50%,-50%)", width:sz, height:sz, borderRadius:"50%", background:c,
                border: label?"2px solid #fff":"none" }}>
              {label && <span style={{ position:"absolute", left:sz+2, top:-4, fontSize:9, color:"#fff", whiteSpace:"nowrap" }}>{h.team} {String(h.year).slice(2)}</span>}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize:10, color:"#475569", marginTop:8 }}>
        Iceland/Germany fingerprints are heuristic pattern-matching, not model output. 2026 composition features are estimated.
        Closest 2026 "Iceland": <b style={{color:"#4ade80"}}>{causal.iceland_2016_analysis?.closest_2026_match}</b>.
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("table");
  const [riskMode, setRiskMode] = useState("balanced");
  const [posFilter, setPosFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("displayPts");
  const [search, setSearch] = useState("");
  const [ownMax, setOwnMax] = useState(100);
  const [selected, setSelected] = useState(null);
  const [mispricedOnly, setMispricedOnly] = useState(false);
  const [tierPos, setTierPos] = useState("ALL");
  const [pureDiff, setPureDiff] = useState(false);

  const [rawPlayers, setRawPlayers] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/data/players.json").then(r => { if (!r.ok) throw new Error("players " + r.status); return r.json(); }),
      fetch("/data/analytics.json").then(r => r.ok ? r.json() : null).catch(() => null), // optional
    ])
      .then(([players, a]) => { setRawPlayers(players); setAnalytics(a); })
      .catch(err => { console.error("Failed to load data:", err); setLoadError(true); });
  }, []);

  const formById = useMemo(() => {
    const m = {}; (analytics?.form_log || []).forEach(r => { (m[r.id] = m[r.id] || []).push(r); }); return m;
  }, [analytics]);

  const players = useMemo(() => {
    if (!rawPlayers) return [];
    return rawPlayers
      .filter(p => posFilter === "ALL" || p.pos === posFilter)
      .filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.team.toLowerCase().includes(search.toLowerCase()))
      .filter(p => p.own <= ownMax)
      .filter(p => !mispricedOnly || ((p.roleShift !== "SAME" || p.mispricing_flag === "UNDERRATED") && p.own < 20))
      .map(p => ({ ...p, ...computePrediction(p, riskMode), formMatches: formById[p.id] || [] }))
      .sort((a,b) => {
        if (sortBy === "displayPts") return b.displayPts - a.displayPts;
        if (sortBy === "value")      return b.value - a.value;
        if (sortBy === "price")      return b.price - a.price;
        if (sortBy === "own")        return b.own - a.own;
        if (sortBy === "tier")       return (b.tier_score||0) - (a.tier_score||0);
        return 0;
      });
  }, [rawPlayers, riskMode, posFilter, sortBy, search, ownMax, mispricedOnly, formById]);

  if (loadError) return <div style={{ background:BG, minHeight:"100vh", color:TEXT, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace" }}>Failed to load data</div>;
  if (!rawPlayers) return <div style={{ background:BG, minHeight:"100vh", color:TEXT, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"monospace" }}>Loading...</div>;

  const TABS = [["table","📊 Players"],["xi","⚽ Starting XI"],["squads","🧮 Optimal Squads"],["tiers","🏆 Tiers"],["causal","🔮 Causal"]];
  return (
    <div style={{ background:BG, minHeight:"100vh", color:TEXT, fontFamily:SANS, fontSize:13, fontVariantNumeric:"tabular-nums" }}>
      <div style={{ background:"linear-gradient(135deg,#0d1829,#0a1020)", borderBottom:`1px solid ${BORDER}`, padding:"16px 20px 0" }}>
        <div style={{ maxWidth:1100, margin:"0 auto" }}>
          <div style={{ fontSize:9, letterSpacing:5, color:"#f97316", marginBottom:4, fontFamily:MONO }}>FIFA WORLD CUP 2026 · FANTASY ANALYTICS</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:12, flexWrap:"wrap" }}>
            <div style={{ fontSize:24, fontWeight:900, letterSpacing:-1, color:"#fff" }}>
              <span style={{ fontSize:17, fontWeight:400, fontStyle:"italic", color:"#fff" }}>tucheliban's </span>
              WC26 <span style={{ color:"#f97316" }}>SCOUT</span>
            </div>
            <span style={{ fontSize:11, fontStyle:"italic", color:"#64748b" }}>it's coming home 🏴󠁧󠁢󠁥󠁮󠁧󠁿</span>
          </div>
          <div style={{ fontSize:12, color:DIM, marginTop:4 }}>Points Prediction Engine · {rawPlayers.length} players · R-model engine{analytics ? " · analytics loaded" : ""}</div>
          <div style={{ display:"flex", gap:4, marginTop:12 }}>
            {TABS.map(([k,l]) => (
              <button key={k} onClick={()=>setTab(k)} style={{ padding:"8px 14px", border:"none",
                borderBottom:`2px solid ${tab===k?"#f97316":"transparent"}`, background:"transparent",
                color:tab===k?"#f97316":DIM, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:tab===k?700:400 }}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"16px 16px 40px" }}>
        {tab==="table" && <PlayerTableTab {...{ players, selected, setSelected, riskMode, setRiskMode,
          posFilter, setPosFilter, sortBy, setSortBy, search, setSearch, ownMax, setOwnMax, mispricedOnly, setMispricedOnly }} />}
        {tab==="xi" && <StartingXITab xi={analytics?.starting_xi} />}
        {tab==="squads" && <OptimalSquadsTab squads={analytics?.optimal_squads} />}
        {tab==="tiers" && <TiersTab tiers={analytics?.tier_list} posFilter={tierPos} setPosFilter={setTierPos} pureDiff={pureDiff} setPureDiff={setPureDiff} />}
        {tab==="causal" && <CausalTab causal={analytics?.causal_analysis} players={rawPlayers} />}

        {analytics?.model_summary && (
          <div style={{ display:"flex", gap:16, marginTop:24, flexWrap:"wrap", fontSize:10, color:DIM, borderTop:`1px solid ${BORDER}`, paddingTop:12 }}>
            <span>{analytics.model_summary.n_underrated} underrated · {analytics.model_summary.n_overrated} overrated</span>
            <span>top value: {analytics.model_summary.top_value_pick}</span>
            <span>top differential: {analytics.model_summary.top_differential}</span>
            <span style={{ marginLeft:"auto", color:"#475569" }}>R pipeline · FBref-blocked → seed-model · {analytics.generated_at}</span>
          </div>
        )}
      </div>
    </div>
  );
}
