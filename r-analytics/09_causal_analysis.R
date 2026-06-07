# ══════════════════════════════════════════════════════════════════════════════
# 09_causal_analysis.R — two-stage causal model of tournament OVERPERFORMANCE
#   Stage 1: expected rounds from team quality (ELO/draw/host)
#   Stage 2: what predicts beating that expectation (squad/style/cohesion)
#   Then apply to WC2026 teams + heuristic Iceland/Germany fingerprints.
#   NB: historical squad-composition fields are hand-estimated; treat as directional.
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(corrplot)
set.seed(42)

mp   <- readRDS(file.path(DATA_DIR, "master_players.rds"))
ht   <- read_csv(file.path(DATA_DIR, "historical_tournaments.csv"), show_col_types = FALSE)
elos <- read_csv(file.path(DATA_DIR, "team_elos.csv"), show_col_types = FALSE)
sp   <- read_csv(file.path(DATA_DIR, "set_piece_rates.csv"), show_col_types = FALSE)
cf   <- read_csv(file.path(DATA_DIR, "confederation_form.csv"), show_col_types = FALSE) %>%
          group_by(team) %>% slice(1) %>% ungroup()

# ── SECTION A — derived vars ──────────────────────────────────────────────────
elo_implied <- function(e) plogis((e - 1750) / 110)   # ELO → rough deep-run prob
ht <- ht %>% mutate(
  age_gini = squad_age_sd,                              # proxy for spread
  elo_implied_prob = elo_implied(elo_entering),
  underdog_score = odds_implied_prob - elo_implied_prob # priced as bigger underdog than ELO ⇒ +
)
cat("SECTION A: historical rows =", nrow(ht), "| missing key vars:",
    sum(!complete.cases(ht[, c("elo_entering","rounds_reached","draw_difficulty")])), "\n")

# ── SECTION B — Stage 1 (expected performance from quality) ───────────────────
stage1 <- lm(rounds_reached ~ elo_entering + draw_difficulty + host_nation + I(elo_entering^2), data = ht)
ht$rounds_expected  <- predict(stage1)
ht$overperformance  <- ht$rounds_reached - ht$rounds_expected
cat("\nSECTION B: Stage-1 R² =", round(summary(stage1)$r.squared, 3), "\n")
cat("  Sanity checks (expect Germany≪0, Iceland/Morocco≫0):\n")
ht %>% filter((team=="Germany" & year %in% c(2018,2022)) | (team=="Iceland" & year==2016) | (team=="Morocco" & year==2022)) %>%
  transmute(team, year, rounds_reached, rounds_expected=round(rounds_expected,2), overperformance=round(overperformance,2)) %>% print()

# ── SECTION C — predictor correlations ────────────────────────────────────────
cand <- c("squad_avg_age","age_gini","pct_over_30","pct_under_23","herfindahl_league",
          "pct_domestic_league","pct_big5_league","avg_intl_caps","lineup_consistency",
          "manager_tenure_months","core_xi_stability","set_piece_goal_pct","counter_goal_pct",
          "friendly_record_last3m","competitive_pts_per_game_last12m","underdog_score")
cors <- sapply(cand, function(v) cor(ht[[v]], ht$overperformance, use = "complete.obs"))
cat("\nSECTION C: |r| with overperformance (★ = |r|>0.35 worth including)\n")
print(round(sort(cors, decreasing = TRUE), 2))
worth <- names(cors)[abs(cors) > 0.35]
cat("  worth including:", paste(worth, collapse=", "), "\n")
tryCatch({
  png(file.path(OUTPUT_DIR, "predictor_correlations.png"), width=900, height=800)
  cm <- cor(ht[, c("overperformance", cand)], use = "complete.obs")
  corrplot(cm, method="color", type="upper", tl.cex=0.7, tl.col="black", addCoef.col="grey30", number.cex=0.5)
  dev.off(); cat("  saved predictor_correlations.png\n")
}, error=function(e) message("  corrplot skipped: ", conditionMessage(e)))

# ── SECTION D — Stage 2 (stepwise; curated start set to respect df) ───────────
start_form <- overperformance ~ lineup_consistency + manager_tenure_months + pct_big5_league +
  herfindahl_league + set_piece_goal_pct + underdog_score + competitive_pts_per_game_last12m + squad_avg_age
stage2_final <- step(lm(start_form, data = ht), direction = "both", trace = FALSE)
s2 <- summary(stage2_final)
cat("\nSECTION D: Stage-2 final model\n"); print(formula(stage2_final))
print(round(s2$coefficients, 3))
adjr2 <- s2$adj.r.squared
cat("  Adjusted R² =", round(adjr2, 3), "\n")
if (adjr2 < 0.25) cat("  WARNING: Model explains limited variance. Treat overperformance predictions as weak signals, not forecasts.\n")
tryCatch({
  png(file.path(OUTPUT_DIR, "stage2_diagnostics.png"), width=900, height=400); par(mfrow=c(1,2))
  plot(stage2_final, which=1); plot(stage2_final, which=2); dev.off(); cat("  saved stage2_diagnostics.png\n")
}, error=function(e) message("  diagnostics skipped: ", conditionMessage(e)))

# ── SECTION E — apply to WC2026 teams ─────────────────────────────────────────
# Composition features for 2026 are ESTIMATED (hand priors for notable teams + confederation
# defaults). Mark teams with <5 seed players as 'partial'.
conf_of <- c(Brazil="CONMEBOL",Argentina="CONMEBOL",Uruguay="CONMEBOL",Colombia="CONMEBOL",Ecuador="CONMEBOL",Paraguay="CONMEBOL",
  France="UEFA",Spain="UEFA",England="UEFA",Germany="UEFA",Portugal="UEFA",Netherlands="UEFA",Belgium="UEFA",Croatia="UEFA",
  Switzerland="UEFA",Austria="UEFA",Norway="UEFA",Scotland="UEFA",Sweden="UEFA","Czech Republic"="UEFA","Bosnia and Herzegovina"="UEFA",
  Morocco="CAF",Senegal="CAF",Egypt="CAF",Algeria="CAF",Tunisia="CAF","Ivory Coast"="CAF","South Africa"="CAF","DR Congo"="CAF","Cape Verde"="CAF",Ghana="CAF",
  Japan="AFC","South Korea"="AFC",Iran="AFC","Saudi Arabia"="AFC",Qatar="AFC",Australia="AFC",Iraq="AFC",Uzbekistan="AFC",Jordan="AFC",
  Mexico="CONCACAF","United States"="CONCACAF",Canada="CONCACAF",Panama="CONCACAF",Haiti="CONCACAF",Curacao="CONCACAF","New Zealand"="OFC",
  Turkey="UEFA")
# hand priors: lineup_consistency, manager_tenure_months, pct_big5_league, herfindahl_league, set_piece_goal_pct, squad_avg_age
prior2026 <- tribble(
  ~team,~lineup_consistency,~manager_tenure_months,~pct_big5_league,~herfindahl_league,~set_piece_goal_pct,~squad_avg_age,
  "Morocco",0.88,28,0.48,0.26,0.34,27.0,  "Japan",0.82,40,0.45,0.26,0.30,27.5,
  "Senegal",0.84,60,0.70,0.16,0.30,27.0,  "Ecuador",0.80,20,0.40,0.28,0.30,25.5,
  "Switzerland",0.82,30,0.60,0.20,0.32,28.0, "Norway",0.80,42,0.62,0.22,0.32,26.5,
  "Croatia",0.84,90,0.72,0.16,0.28,29.0,  "Uruguay",0.78,18,0.72,0.18,0.30,27.5,
  "Mexico",0.78,14,0.25,0.30,0.30,28.0,   "Iran",0.80,20,0.30,0.34,0.30,28.0,
  "Germany",0.64,36,0.92,0.09,0.24,26.5,  "Belgium",0.64,18,0.92,0.09,0.26,28.5,
  "England",0.72,30,0.96,0.30,0.30,25.5,  "Brazil",0.72,16,0.82,0.10,0.26,27.0,
  "France",0.72,180,0.92,0.10,0.24,26.0,  "Portugal",0.74,30,0.75,0.16,0.32,27.5,
  "Spain",0.80,30,0.55,0.30,0.30,26.5,    "Argentina",0.82,60,0.78,0.16,0.30,28.5)
wc <- elos %>% mutate(confederation = conf_of[team]) %>%
  left_join(prior2026, by="team") %>%
  left_join(sp %>% transmute(team, sp_seed = corner_rate + fk_goal_rate), by="team") %>%
  left_join(cf %>% transmute(team, competitive_pts_per_game_last12m = pts_per_game_group, form_rating), by="team") %>%
  mutate(
    elo_entering = elo_approx,
    # confederation defaults where no hand prior
    lineup_consistency = coalesce(lineup_consistency, recode(confederation, UEFA=0.72, CONMEBOL=0.76, CAF=0.80, AFC=0.80, CONCACAF=0.78, OFC=0.82, .default=0.75), 0.75),
    manager_tenure_months = coalesce(manager_tenure_months, 24),
    pct_big5_league = coalesce(pct_big5_league, recode(confederation, UEFA=0.80, CONMEBOL=0.70, CAF=0.55, AFC=0.25, CONCACAF=0.30, OFC=0.20, .default=0.4), 0.40),
    herfindahl_league = coalesce(herfindahl_league, recode(confederation, UEFA=0.14, CONMEBOL=0.16, CAF=0.22, AFC=0.34, CONCACAF=0.30, OFC=0.40, .default=0.25), 0.25),
    set_piece_goal_pct = coalesce(set_piece_goal_pct, sp_seed, 0.28),
    squad_avg_age = coalesce(squad_avg_age, 27.0),
    competitive_pts_per_game_last12m = coalesce(competitive_pts_per_game_last12m, 1.6),
    elo_implied_prob = elo_implied(elo_entering),
    # underdog_score proxy: recent form stronger than ELO implies ⇒ underrated
    underdog_score = pmax(pmin((coalesce(form_rating,6)/10) - elo_implied_prob, 0.5), -0.5)
  )
wc$overperformance_predicted <- as.numeric(predict(stage2_final, newdata = wc))
# rounds_expected for 2026 from stage1 (draw_difficulty unknown ⇒ neutral 3, host for MEX/USA/CAN)
wc$host_nation <- as.integer(wc$team %in% c("Mexico","United States","Canada"))
wc$draw_difficulty <- 3
wc$rounds_expected <- as.numeric(predict(stage1, newdata = wc))

# seed-player coverage per team
cov <- mp %>% count(team, name="n_seed")
wc <- wc %>% left_join(cov, by="team") %>%
  mutate(confidence = if_else(coalesce(n_seed,0L) >= 5, "medium", if_else(coalesce(n_seed,0L) >= 1, "low", "very low")),
         data_completeness = if_else(coalesce(n_seed,0L) >= 5, "full", "partial"))

# ── SECTION F — Iceland test + Germany fingerprint (heuristic pattern-matching) ─
elo_rank <- rank(-wc$elo_entering)
wc <- wc %>% mutate(
  iceland_score =
    (underdog_score > 0.15) + (lineup_consistency > 0.80) + (manager_tenure_months > 24) +
    (set_piece_goal_pct > 0.30) + (herfindahl_league > 0.25) + (pct_big5_league < 0.50),
  germany_score =
    (elo_rank <= 5) + (manager_tenure_months < 18) + (herfindahl_league < 0.10) +
    (lineup_consistency < 0.65) + (pct_big5_league > 0.90),
  giant_killer_flag = iceland_score >= 4,
  overvalued_flag   = germany_score >= 3
)
cat("\nSECTION E/F: WC2026 overperformance — top 10\n")
wc %>% arrange(desc(overperformance_predicted)) %>%
  transmute(team, elo_entering, rounds_expected=round(rounds_expected,2),
            overperf=round(overperformance_predicted,2), iceland_score, giant_killer_flag, confidence) %>% head(10) %>% print()
cat("\nbottom 10\n")
wc %>% arrange(overperformance_predicted) %>%
  transmute(team, elo_entering, overperf=round(overperformance_predicted,2), germany_score, overvalued_flag) %>% head(10) %>% print()
cat("\nGIANT KILLERS (iceland_score>=4):", paste(wc$team[wc$giant_killer_flag], collapse=", "), "\n")
cat("OVERVALUED (germany fingerprint):", paste(wc$team[wc$overvalued_flag], collapse=", "), "\n")

# ── SECTION G — per-player causal fantasy signals ─────────────────────────────
op_scale <- function(x) pmax(pmin(x, 1.5), -1.5)
player_signals <- mp %>% select(id, name, team, pos, own) %>%
  left_join(wc %>% select(team, overperformance_predicted, giant_killer_flag, overvalued_flag, iceland_score), by="team") %>%
  mutate(
    team_overperf_predicted = round(coalesce(overperformance_predicted, 0), 2),
    giant_killer_flag = coalesce(giant_killer_flag, FALSE),
    overvalued_team_flag = coalesce(overvalued_flag, FALSE),
    # additive pts nudge: + for giant killers (CS/upset upside), - for overvalued (early-exit risk)
    causal_pts_adjustment = round(op_scale(team_overperf_predicted) * 1.5, 2)
  ) %>% select(id, name, team, pos, own, team_overperf_predicted, giant_killer_flag, overvalued_team_flag, iceland_score, causal_pts_adjustment)

iceland_2026_match <- wc %>% arrange(desc(iceland_score), desc(overperformance_predicted)) %>% slice(1) %>% pull(team)
causal_results <- list(
  stage1_r2 = summary(stage1)$r.squared, stage2_adj_r2 = adjr2,
  stage2_coefs = as.data.frame(s2$coefficients) %>% rownames_to_column("term"),
  predictions = wc %>% select(team, confederation, elo_entering, rounds_expected, overperformance_predicted,
                              iceland_score, germany_score, giant_killer_flag, overvalued_flag, confidence, data_completeness),
  player_signals = player_signals,
  iceland_2026_match = iceland_2026_match,
  worth_predictors = worth,
  historical = ht %>% transmute(team, year, tournament, elo_entering, rounds_reached,
                rounds_expected = round(rounds_expected, 2), overperformance = round(overperformance, 2)))
saveRDS(causal_results, file.path(DATA_DIR, "causal_results.rds"))
cat("\n✓ 09_causal_analysis.R complete (iceland-2026 closest match:", iceland_2026_match, ")\n")
