# ══════════════════════════════════════════════════════════════════════════════
# 07_export_json.R — merge model outputs into players.json + write analytics.json
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(jsonlite)

rr  <- readRDS(file.path(DATA_DIR, "role_regression_results.rds"))
os  <- readRDS(file.path(DATA_DIR, "optimal_squads.rds"))
cl  <- readRDS(file.path(DATA_DIR, "team_clusters.rds"))
xi  <- readRDS(file.path(DATA_DIR, "starting_xi.rds"))
tl  <- readRDS(file.path(DATA_DIR, "tier_list.rds"))
cev <- readRDS(file.path(DATA_DIR, "captain_ev.rds"))
cz  <- tryCatch(readRDS(file.path(DATA_DIR, "causal_results.rds")), error = function(e) NULL)
pf  <- tryCatch(readRDS(file.path(DATA_DIR, "player_form.rds")), error = function(e) NULL)
flog <- tryCatch(readRDS(file.path(DATA_DIR, "form_log.rds")), error = function(e) NULL)
# all_players already carries team_cluster + premium cols from 04; drop the premium
# ones so the full rr join below has no collision, and keep the existing team_cluster.
ply <- os$all_players %>%
  select(-any_of(c("intl_premium_xG","intl_premium_score","mispricing_flag","causal_pts_adjustment","form_mult")))

# ── SECTION A — per-player analytics (incl. per-MD adjusted xG) ────────────────
ROLE_MULT <- list(SAME=c(1,1), DEF_to_ATT=c(1.40,1.60), ATT_to_DEF=c(0.60,0.70),
                  MID_to_ATT=c(1.25,1.20), MID_to_DEF=c(0.75,0.80), WING_to_STRIKER=c(1.30,0.80))
md_xg <- t(sapply(seq_len(nrow(ply)), function(i) {
  p <- ply[i,]; fx <- p$fixtures[[1]]; rm <- ROLE_MULT[[p$roleShift]]; if (is.null(rm)) rm <- c(1,1)
  round(p$xGp90 * rm[1] * (fx$oddsWin*1.4 + fx$oddsDraw*0.5), 3)
}))
analytics_players <- ply %>% left_join(rr %>% select(id, intl_premium_xG, intl_premium_xA,
  intl_premium_score, mispricing_flag, mispricing_direction), by="id") %>%
  left_join(tl$scores %>% select(id, tier, tier_score), by="id") %>%
  left_join(cev %>% select(id, captain_ev), by="id") %>%
  left_join(if (!is.null(cz)) cz$player_signals %>% select(id, team_overperf_predicted,
              giant_killer_flag, overvalued_team_flag, causal_pts_adjustment)
            else tibble(id=integer()), by="id") %>%
  left_join(if (!is.null(pf)) pf %>% select(id, form_mult, form_n)
            else tibble(id=integer()), by="id") %>%
  transmute(id,
    intl_premium_xG = round(coalesce(intl_premium_xG,0),3),
    intl_premium_xA = round(coalesce(intl_premium_xA,0),3),
    intl_premium_score = round(coalesce(intl_premium_score,0),2),
    mispricing_flag = coalesce(mispricing_flag,"FAIR"),
    mispricing_direction = coalesce(mispricing_direction,"0"),
    team_cluster, tier = coalesce(tier,"C"), tier_score = round(coalesce(tier_score,0),1),
    pts_safe = round(pts_safe,1), pts_balanced = round(pts_balanced,1), pts_diff = round(pts_diff,1),
    captain_ev = round(coalesce(captain_ev,0),1),
    md1_xG_adj = md_xg[,1], md2_xG_adj = md_xg[,2], md3_xG_adj = md_xg[,3],
    team_overperf_predicted = coalesce(team_overperf_predicted, 0),
    giant_killer_flag = coalesce(giant_killer_flag, FALSE),
    overvalued_team_flag = coalesce(overvalued_team_flag, FALSE),
    causal_pts_adjustment = coalesce(causal_pts_adjustment, 0),
    form_mult = round(coalesce(form_mult, 1), 2),
    form_n = coalesce(form_n, 0L))

# ── SECTION C — optimal squads (compact) ──────────────────────────────────────
squad_compact <- function(s) if (is.null(s)) NULL else s %>%
  transmute(id, name, team, pos, price, pts = round(sel_pts,1)) %>% arrange(factor(pos,c("GK","DEF","MID","FWD")))
squads_out <- list(safe = squad_compact(os$safe), balanced = squad_compact(os$balanced),
                   differential = squad_compact(os$differential), pure_differential = squad_compact(os$pure_differential))

# ── SECTION D — team clusters ─────────────────────────────────────────────────
clusters_out <- cl %>% select(team, team_cluster, elo_approx)

# ── SECTION E — merge into players.json (ADD-only) + write analytics.json ──────
seed <- fromJSON(file.path(PUBLIC_DATA_DIR, "players.json"))
ana_cols <- setdiff(names(analytics_players), "id")          # all analytics outputs
seed_base <- seed %>% select(-any_of(ana_cols))              # drop stale analytics, keep base schema
merged <- seed_base %>% left_join(analytics_players, by="id")  # write FRESH analytics every run
write_json(merged, file.path(PUBLIC_DATA_DIR, "players.json"), auto_unbox=TRUE, pretty=TRUE, na="null")
cat("SECTION E: players.json merged (", length(ana_cols), "analytics fields refreshed)\n")

n_under <- sum(analytics_players$mispricing_flag=="UNDERRATED")
n_over  <- sum(analytics_players$mispricing_flag=="OVERRATED")
top_value <- ply %>% mutate(v=pts_balanced/price) %>% arrange(desc(v)) %>% slice(1) %>% pull(name)
top_diff  <- ply %>% filter(own<10) %>% arrange(desc(pts_diff)) %>% slice(1) %>% pull(name)

causal_out <- if (!is.null(cz)) {
  preds <- cz$predictions %>% arrange(desc(overperformance_predicted)) %>%
    mutate(across(where(is.numeric), ~round(.,2)))
  list(
    model_summary = list(
      stage1_r2 = round(cz$stage1_r2, 3), stage2_adj_r2 = round(cz$stage2_adj_r2, 3),
      key_predictors = head(cz$stage2_coefs$term[cz$stage2_coefs$term != "(Intercept)"], 5),
      model_warning = if (cz$stage2_adj_r2 < 0.25)
        "Model explains limited variance — treat overperformance predictions as weak signals."
        else "Stage-2 explains moderate variance on hand-estimated training data — directional, not forecast."),
    overperformance_predictions = preds,
    giant_killers = preds %>% filter(giant_killer_flag) %>% pull(team),
    overvalued_teams = preds %>% filter(overvalued_flag) %>% pull(team),
    iceland_2016_analysis = list(retrospective_score = 6,
      key_variables = c("lineup_consistency (+)", "low pct_big5", "set_piece dependency", "underdog_score"),
      closest_2026_match = cz$iceland_2026_match),
    stage2_coefficients = cz$stage2_coefs %>% mutate(across(where(is.numeric), ~round(.,3))),
    historical = cz$historical,
    note = "Iceland/Germany fingerprints are heuristic pattern-matching, not model output. Composition features for 2026 are estimated.")
} else NULL

analytics <- list(
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"),
  starting_xi = xi, optimal_squads = squads_out, team_clusters = clusters_out,
  tier_list = list(S=tl$S, A=tl$A, B=tl$B, generated_at=format(Sys.time(),"%Y-%m-%dT%H:%M:%S")),
  player_analytics = analytics_players,
  form_log = if (!is.null(flog)) flog else tibble(),
  model_summary = list(n_players = nrow(analytics_players), n_underrated = n_under,
    n_overrated = n_over, top_value_pick = top_value, top_differential = top_diff),
  causal_analysis = causal_out)
write_json(analytics, file.path(PUBLIC_DATA_DIR, "analytics.json"), auto_unbox=TRUE, pretty=TRUE, na="null")
cat("SECTION: analytics.json written (under:", n_under, "over:", n_over,
    "top_value:", top_value, "top_diff:", top_diff, ")\n")
cat("✓ 07_export_json.R complete\n")
