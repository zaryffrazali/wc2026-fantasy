# WC2026 Fantasy — Analytics Pipeline

R pipeline that builds the player pool, fits the models, and writes the JSON the React
dashboard consumes (`public/data/players.json`, `public/data/analytics.json`,
`public/data/matchday_plan.json`).

## Quick start
```bash
node r-analytics/build_pool.cjs      # (re)build the 1,481-player pool from cached FIFA feeds
Rscript r-analytics/00_setup.R       # install/load R packages (once)
Rscript r-analytics/run_all.R        # run the full modelling pipeline
npm run dev                          # serve the dashboard (localhost:5173)
```

## Pipeline order (`run_all.R`)
| Step | Script | Output |
|---|---|---|
| 0 | `build_pool.cjs` *(node, manual)* | `public/data/players.json` — full pool (price/pos/own/team from FIFA, fixtures+advP from ELO, priors + 56 curated stars) |
| 1 | `01_data_pull.R` | `master_players.rds` — merges **real club xG/xA** (FBref Big-5 + Understat GitHub loads) over the pool; manual/seed fallback |
| 2 | `10_form_tracker.R` | `player_form.rds`, `form_log.rds` — Bayesian international form multiplier |
| 3 | `02_role_regression.R` | club→intl residual = mispricing signal (UNDERRATED/OVERRATED) |
| 4 | `03_playstyle_clustering.R` | team style clusters + matchup matrix |
| 5 | `09_causal_analysis.R` | tournament-overperformance model, giant-killer / overvalued flags |
| 6 | `04_lp_optimizer.R` | LP squads (safe/balanced/diff/pure-diff). Applies form × causal nudge to points |
| 7 | `05_captain_ev.R` | captain EV |
| 8 | `06_starting_xi.R` | best XI + narratives + pitch PNG |
| 9 | `08_tier_list.R` | gambling S/A/B/C/D tiers |
| 10 | `07_export_json.R` | merges everything into `players.json` + writes `analytics.json` |

**Manual / not in `run_all`:**
- `11_matchday_squads.R` — MD1 squad + ≤2-transfer plan for MD2/MD3 → `matchday_plan.json`
- `12_fetch_intl.R` — auto-fetch international matches (see Form, below)

## Updating things
- **Fixtures / draw / strength:** edit `data/wc_groups.csv` (opponents), `data/team_elos.csv` (odds + advancement derive from ELO). Re-run.
- **International form** (carries into the tournament): add matches to `data/intl_matches.csv`
  (`player,team,date,opponent,minutes,xG,xA,goals,assists`), or drop an
  `data/intl_matches_incoming.csv` and run `Rscript r-analytics/12_fetch_intl.R`, or set
  `APIFOOTBALL_KEY`. Then `Rscript r-analytics/run_all.R`.
- **Curated star depth:** `data/seed58_curated.json` (roles, set-piece takers, start probs).

## Data sources — honest status
- ✅ **Cached FBref Big-5 + Understat** (`load_*` from the worldfootballR GitHub repo) — reachable, real club xG/xA. Refreshes on the maintainer's cadence (cache was dated 2025-09-18 → early-season, small-sample).
- ✅ **FIFA Fantasy feeds** (`play.fifa.com/json/fantasy/`) — real prices/positions/ownership.
- ❌ **Live FBref / SofaScore / API-Football** — 403/keyed from this environment.
- ❌ **International friendlies** — not in the cached loaders; supply via `intl_matches.csv` / API key.

## Caveats
- **Long-tail depth is prior-based**: ~850 non-curated players use position/price priors for
  start prob, role, set-pieces (xG real only where FBref-matched). Look for the `prior` badge / `data_tier`.
- **Causal layer is low-confidence** (n=46 hand-estimated rows; Iceland/Germany fingerprints are
  heuristic pattern-matching, partly tuned by construction) → applied at 50% weight.
- **Role regression R² is inflated** (intl stats are a club-derived proxy; no national-team feed).
- Treat curated stars as the trustworthy core; sanity-check cheap prior-filled picks.
