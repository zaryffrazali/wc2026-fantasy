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

# ── SECTION B — LP optimiser ──────────────────────────────────────────────────
solve_squad <- function(metric, own_cap = NULL, label = "") {
  keep <- if (is.null(own_cap)) rep(TRUE, nrow(players)) else players$own <= own_cap
  P <- players[keep, ]; o <- P[[metric]]
  pos <- P$pos; teams <- unique(P$team)
  cons <- rbind(
    P$price,                                                  # budget
    as.integer(pos == "GK"), as.integer(pos == "DEF"),
    as.integer(pos == "MID"), as.integer(pos == "FWD"),
    t(sapply(teams, function(tm) as.integer(P$team == tm)))   # max 3 per nation
  )
  dir <- c("<=", "=", "=", "=", "=", rep("<=", length(teams)))
  rhs <- c(100, 2, 5, 5, 3, rep(3, length(teams)))
  sol <- lp("max", o, cons, dir, rhs, all.bin = TRUE)
  if (sol$status != 0) { cat("  [", label, "] LP infeasible\n"); return(NULL) }
  pick <- sol$solution > 0.5
  sel <- P[pick, ]
  cat(sprintf("\n[%s] total pts=%.1f  budget=$%.1fm  (%d players)\n",
              label, sum(o[pick]), sum(sel$price), nrow(sel)))
  print(sel %>% mutate(pts = round(.data[[metric]], 1)) %>%
          arrange(factor(pos, c("GK","DEF","MID","FWD")), desc(price)) %>%
          select(name, team, pos, price, pts))
  sel %>% mutate(squad = label, sel_metric = metric, sel_pts = .data[[metric]])
}
cat("\nSECTION B: solving squads\n")
sq_safe <- solve_squad("pts_safe",     NULL, "safe")
sq_bal  <- solve_squad("pts_balanced", NULL, "balanced")
sq_diff <- solve_squad("pts_diff",     NULL, "differential")
sq_pure <- solve_squad("pts_diff",     15,   "pure_differential")

optimal_squads <- list(
  safe = sq_safe, balanced = sq_bal, differential = sq_diff, pure_differential = sq_pure,
  all_players = players)
saveRDS(optimal_squads, file.path(DATA_DIR, "optimal_squads.rds"))
cat("\n✓ 04_lp_optimizer.R complete\n")
