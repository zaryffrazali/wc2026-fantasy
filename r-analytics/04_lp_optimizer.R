# ══════════════════════════════════════════════════════════════════════════════
# 04_lp_optimizer.R — predicted points (R port of computePrediction) + lpSolve squads
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(lpSolve)

mp       <- readRDS(file.path(DATA_DIR, "master_players.rds"))
rr       <- readRDS(file.path(DATA_DIR, "role_regression_results.rds")) %>%
              select(id, intl_premium_xG, intl_premium_score, mispricing_flag)
clusters <- readRDS(file.path(DATA_DIR, "team_clusters.rds")) %>% select(team, team_cluster)
M        <- readRDS(file.path(DATA_DIR, "matchup_matrix.rds"))

players <- mp %>% left_join(rr, by = "id") %>% left_join(clusters, by = "team")
# international-form multiplier (10_form_tracker.R); default 1 if absent
.form <- tryCatch(readRDS(file.path(DATA_DIR, "player_form.rds")) %>% select(id, form_mult), error = function(e) NULL)
players <- if (!is.null(.form)) left_join(players, .form, by = "id") else dplyr::mutate(players, form_mult = 1)
players <- players %>% mutate(form_mult = coalesce(form_mult, 1))
cluster_of <- setNames(clusters$team_cluster, clusters$team)

ROLE_MULT <- list(  # (xG_mult, xA_mult) per role shift
  SAME            = c(1.00, 1.00), DEF_to_ATT = c(1.40, 1.60), ATT_to_DEF = c(0.60, 0.70),
  MID_to_ATT      = c(1.25, 1.20), MID_to_DEF = c(0.75, 0.80), WING_to_STRIKER = c(1.30, 0.80))

# ── SECTION A — predicted points per player (mirrors React computePrediction) ──
predict_pts <- function(p) {
  fx <- p$fixtures[[1]]                       # data.frame of 3 matchdays
  rm <- ROLE_MULT[[p$roleShift]]; if (is.null(rm)) rm <- c(1,1)
  fm <- p$form_mult %||% 1                              # international form (10_form_tracker)
  xG <- p$xGp90 * rm[1] * fm; xA <- p$xAp90 * rm[2] * fm
  xG <- xG * (1 + (p$intl_premium_xG %||% 0) * 0.3)   # model mispricing adjustment

  csP_md  <- mean(fx$oddsWin * 0.72 + fx$oddsDraw * 0.28)   # per-MD clean-sheet prob
  goalP   <- mean(fx$oddsWin * 1.40 + fx$oddsDraw * 0.50)   # per-MD team goal scale
  # average matchup xG multiplier across the 3 opponents
  mm <- mean(sapply(fx$opponent, function(opp) {
    oc <- unname(cluster_of[opp]); tc <- p$team_cluster          # single-bracket → NA if missing
    if (is.na(oc) || is.null(tc) || is.na(tc) ||
        !(tc %in% rownames(M)) || !(oc %in% colnames(M))) 1 else M[tc, oc]
  }))

  # Expected minutes: appearance pts use start prob; per-90 RETURNS are scaled by
  # E_mins/90 = startProb*minsIfStarted/90 so rotation/sub risk is properly priced.
  appearance  <- p$startProb * 2
  mins_factor <- (p$startProb * p$minsIfStarted) / 90
  returns <- 0
  if (p$pos == "GK") {
    returns <- csP_md * 5 + ((p$savesP90 %||% 3.2)/3) - (1 - csP_md) * 0.8
  } else if (p$pos == "DEF") {
    returns <- csP_md * 5 + xG * 7 * goalP * mm + xA * 3 - (1 - csP_md) * 0.5
  } else if (p$pos == "MID") {
    returns <- xG * 6 * goalP * mm + xA * 3 + csP_md + (xA * 2.5 / 2) + 0.4
  } else {  # FWD
    returns <- xG * 5 * goalP * mm + xA * 3 + (p$SoTp90/2)
  }
  if (isTRUE(p$penTaker))    returns <- returns + 0.5
  if (isTRUE(p$fkTaker))     returns <- returns + 0.4
  if (isTRUE(p$cornerTaker)) returns <- returns + 0.3
  returns <- returns - switch(p$cardRisk, high = 0.4, medium = 0.2, 0)
  pts <- appearance + returns * mins_factor

  E_MATCHES <- 3 + (p$advP/100) * 5
  scoutEV   <- if (p$own < 5) 1.8 else if (p$own < 10) 0.6 else 0
  capMult   <- switch(as.character(p$captainSlot), `3` = 1.15, `2` = 1.08, 1.00)

  pts_balanced <- pts * E_MATCHES + scoutEV
  pts_safe     <- pts * E_MATCHES * 0.88
  pts_diff     <- (pts * E_MATCHES * 1.28 + scoutEV * 1.5) * capMult
  c(pts_safe = pts_safe, pts_balanced = pts_balanced, pts_diff = pts_diff,
    captainValue = pts_diff * capMult, gs_subtotal = pts * 3)
}
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || is.na(a)) b else a

preds <- t(sapply(seq_len(nrow(players)), function(i) predict_pts(players[i, ])))
players <- bind_cols(players, as_tibble(preds))
cat("SECTION A: predicted points computed. Range balanced:",
    round(min(players$pts_balanced),1), "-", round(max(players$pts_balanced),1), "\n")

# ── SECTION A2 — fold causal overperformance nudge into points (DISCOUNTED) ────
# 09 runs before 04 (see run_all). The causal signal is low-confidence (n=46,
# heuristic), so we apply only CAUSAL_WT of it: lifts giant-killers, docks
# overvalued teams, but cannot dominate the base model.
CAUSAL_WT <- 0.5
cz <- tryCatch(readRDS(file.path(DATA_DIR, "causal_results.rds")), error = function(e) NULL)
if (!is.null(cz)) {
  players <- players %>%
    left_join(cz$player_signals %>% select(id, causal_pts_adjustment), by = "id") %>%
    mutate(causal_pts_adjustment = coalesce(causal_pts_adjustment, 0),
           pts_safe     = pts_safe     + CAUSAL_WT * causal_pts_adjustment,
           pts_balanced = pts_balanced + CAUSAL_WT * causal_pts_adjustment,
           pts_diff     = pts_diff     + CAUSAL_WT * causal_pts_adjustment)
  cat("SECTION A2: causal nudge applied at weight", CAUSAL_WT, "(giant-killers +, overvalued -)\n")
} else cat("SECTION A2: no causal_results.rds yet — skipped (run 09 first)\n")

# ── SECTION B — LP optimiser: four REDEFINED objectives (Change 3) ────────────
top20_cut <- as.numeric(quantile(players$own, 0.80, na.rm = TRUE))   # "template" = top-20% owned

# general solver: objective vector + candidate filter + nation cap + extra structural constraints
solve_squad <- function(obj, label, cand = rep(TRUE, nrow(players)), nation_cap = 3, extra = list()) {
  P <- players[cand, ]; o <- obj[cand]; pos <- P$pos; teams <- unique(P$team)
  cons <- rbind(P$price, as.integer(pos=="GK"), as.integer(pos=="DEF"),
                as.integer(pos=="MID"), as.integer(pos=="FWD"),
                t(sapply(teams, function(tm) as.integer(P$team==tm))))
  dir <- c("<=","=","=","=","=", rep("<=", length(teams)))
  rhs <- c(100, 2, 5, 5, 3, rep(nation_cap, length(teams)))
  for (e in extra) { cons <- rbind(cons, as.integer(e$coef[cand])); dir <- c(dir, e$dir); rhs <- c(rhs, e$rhs) }
  sol <- lp("max", o, cons, dir, rhs, all.bin = TRUE)
  if (sol$status != 0) { cat("  [", label, "] LP infeasible\n"); return(NULL) }
  sel <- P[sol$solution > 0.5, ] %>% mutate(squad = label, sel_pts = pts_balanced)
  cat(sprintf("  [%s] %d players · $%.1fm · %.0f pts · avg own %.1f%%\n",
              label, nrow(sel), sum(sel$price), sum(sel$pts_balanced), mean(sel$own)))
  sel
}
cat("\nSECTION B: solving four squads\n")
sq_safe <- solve_squad(players$pts_balanced, "safe", cand = players$startProb >= 0.85)
sq_bal  <- solve_squad(players$pts_balanced, "balanced", nation_cap = 4, extra = list(
  list(coef = players$own > 20, dir = ">=", rhs = 8),       # ≥8 template anchors
  list(coef = players$own < 15, dir = ">=", rhs = 3)))      # ≥3 differentials
sq_diff <- solve_squad(players$pts_balanced / players$price, "differential", extra = list(
  list(coef = players$own < 15, dir = ">=", rhs = 6)))       # value hunt, ≥6 low-owned
sq_pure <- solve_squad(players$pts_diff * (1/(players$own + 1)), "pure_differential", extra = list(
  list(coef = players$own > 30, dir = "<=", rhs = 2)))       # ceiling×scarcity, ≤2 template

meta <- function(sq, label, desc, objtxt) if (is.null(sq)) NULL else list(
  label = label, description = desc, objective = objtxt,
  total_pts = round(sum(sq$pts_balanced),1), budget = round(sum(sq$price),1),
  avg_own = round(mean(sq$own),1), n_scout = sum(sq$own < 5),
  template_overlap_pct = round(100*mean(sq$own >= top20_cut)))
squad_meta <- list(
  safe = meta(sq_safe, "🛡️ Safe — Minutes Certainty",
    "Maximises guaranteed minutes. Every player >85% start probability. Zero rotation risk, lower ceiling.",
    "max Σ pts s.t. startProb ≥ 0.85 (all nailed starters)"),
  balanced = meta(sq_bal, "⚖️ Balanced — Core + Edge",
    "8 template anchors + 3-4 differentials. Tracks the field while keeping mini-league edge.",
    "max Σ pts s.t. ≥8 own>20%, ≥3 own<15%, ≤4/nation"),
  differential = meta(sq_diff, "📈 Differential — Value Hunt",
    "Maximises points-per-dollar. Targets systematically underpriced players. High variance, high upside.",
    "max Σ (pts / price) s.t. ≥6 own<15%"),
  pure_differential = meta(sq_pure, "🎯 Pure Diff — Ceiling & Scarcity",
    "Explosive ceiling in low-owned players. Built to win mini-leagues, not finish top-10k overall.",
    "max Σ (pts_p90 × 1/(own+1)) s.t. ≤2 own>30%"))

optimal_squads <- list(
  safe = sq_safe, balanced = sq_bal, differential = sq_diff, pure_differential = sq_pure,
  meta = squad_meta, all_players = players)
saveRDS(optimal_squads, file.path(DATA_DIR, "optimal_squads.rds"))
cat("\n✓ 04_lp_optimizer.R complete\n")
