# ══════════════════════════════════════════════════════════════════════════════
# 02_role_regression.R — club→international residual = mispricing signal
# NOTE: with FBref blocked, intl stats are seed proxies (built in 01), so the
# club→intl relationship is partly engineered. R² will read HIGH for that reason;
# the residual still isolates the role/elo-driven component. Treat as directional.
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(broom)

mp <- readRDS(file.path(DATA_DIR, "master_players.rds")) %>%
  mutate(role_shift = factor(role_shift))

# ── SECTION A — modeling dataset (>=8 intl apps; else impute) ─────────────────
MIN_APPS <- 8
mp <- mp %>% mutate(enough = intl_apps_24m >= MIN_APPS)
cat("SECTION A:", sum(mp$enough), "players with >=", MIN_APPS, "intl apps;",
    sum(!mp$enough), "below threshold (imputed)\n")

model_df  <- mp %>% filter(enough)
attackers <- model_df %>% filter(pos %in% c("FWD","MID"))
defenders <- model_df %>% filter(pos %in% c("DEF","GK"))

# ── SECTION B — role regressions ──────────────────────────────────────────────
fit <- function(formula, data, label) {
  m <- lm(formula, data = data)
  r2 <- summary(m)$r.squared
  cat(sprintf("  [%s] n=%d  R²=%.3f%s\n", label, nrow(data), r2,
              if (r2 < 0.3) "  ⚠ R²<0.3 UNRELIABLE" else ""))
  m
}
cat("SECTION B: fitting models\n")
model_xG     <- fit(intl_npxG_p90 ~ club_npxG_p90 + league_tier + role_shift + natl_team_elo, attackers, "ATK xG")
model_xA     <- fit(intl_xAG_p90  ~ club_xAG_p90  + league_tier + role_shift + natl_team_elo, attackers, "ATK xA")
model_def_xG <- fit(intl_npxG_p90 ~ club_npxG_p90 + league_tier + role_shift + natl_team_elo, defenders, "DEF xG")
model_def_xA <- fit(intl_xAG_p90  ~ club_xAG_p90  + league_tier + role_shift + natl_team_elo, defenders, "DEF xA")

# ── SECTION C — residuals → premiums → z-scores ───────────────────────────────
clamp <- function(x) pmax(pmin(x, 3), -3)
zscore <- function(x) { s <- sd(x, na.rm = TRUE); if (is.na(s) || s == 0) return(x*0); (x - mean(x, na.rm = TRUE)) / s }

resid_for <- function(df, m_xg, m_xa) df %>% mutate(
  intl_premium_xG = intl_npxG_p90 - predict(m_xg, newdata = df),
  intl_premium_xA = intl_xAG_p90  - predict(m_xa, newdata = df))

scored <- bind_rows(
  resid_for(attackers, model_xG, model_xA),
  resid_for(defenders, model_def_xG, model_def_xA)
) %>% mutate(
  intl_premium_score = clamp(zscore(intl_premium_xG + intl_premium_xA))
)

# ── SECTION E — impute low-cap players (merge back, flag) ──────────────────────
results <- mp %>%
  left_join(scored %>% select(id, intl_premium_xG, intl_premium_xA, intl_premium_score), by = "id") %>%
  mutate(
    insufficient = !enough,
    intl_premium_xG    = ifelse(insufficient, 0, intl_premium_xG),
    intl_premium_xA    = ifelse(insufficient, 0, intl_premium_xA),
    intl_premium_score = ifelse(insufficient, 0, intl_premium_score),
    # ── SECTION D — mispricing flag ──
    mispricing_flag = case_when(
      insufficient                              ~ "INSUFFICIENT_DATA",
      intl_premium_score >  1.0 & own < 20      ~ "UNDERRATED",
      intl_premium_score < -1.0 & own < 20      ~ "OVERRATED",
      TRUE                                      ~ "FAIR"),
    mispricing_direction = case_when(
      mispricing_flag == "UNDERRATED" ~ "+",
      mispricing_flag == "OVERRATED"  ~ "-",
      TRUE                            ~ "0")
  )

saveRDS(results, file.path(DATA_DIR, "role_regression_results.rds"))

cat("\nSECTION D: mispricing breakdown\n"); print(table(results$mispricing_flag))
cat("\nTop underrated (intl_premium_score):\n")
results %>% arrange(desc(intl_premium_score)) %>%
  select(name, team, pos, own, intl_premium_score, mispricing_flag) %>% head(10) %>% print()
cat("\nTop overrated:\n")
results %>% arrange(intl_premium_score) %>%
  select(name, team, pos, own, intl_premium_score, mispricing_flag) %>% head(10) %>% print()
cat("✓ 02_role_regression.R complete\n")
