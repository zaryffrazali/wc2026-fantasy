# ══════════════════════════════════════════════════════════════════════════════
# 03_playstyle_clustering.R — cluster all 48 nations by playstyle, build matchup matrix
# FBref/qualifying data unavailable → team style features are a documented blend of
# (a) computed: ELO, set-piece rates; (b) hardcoded style priors per known team.
# Every hardcoded vector is labelled. Matchup multipliers use logical priors (flagged).
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(cluster)
set.seed(42)

elos       <- read_csv(file.path(DATA_DIR, "team_elos.csv"), show_col_types = FALSE)
set_pieces <- read_csv(file.path(DATA_DIR, "set_piece_rates.csv"), show_col_types = FALSE)

# ── SECTION A — team feature engineering ──────────────────────────────────────
# HARDCODED style priors (0-1) for teams with well-known identities; others default
# to balanced midpoints. Documented as priors, not computed from match data.
prior <- tribble(
  ~team,            ~possession, ~press, ~directness,
  "Spain",           0.92, 0.85, 0.20,  "Germany",       0.80, 0.82, 0.30,
  "Netherlands",     0.78, 0.70, 0.35,  "France",        0.68, 0.72, 0.45,
  "England",         0.70, 0.68, 0.42,  "Brazil",        0.74, 0.66, 0.40,
  "Argentina",       0.72, 0.70, 0.40,  "Portugal",      0.74, 0.68, 0.38,
  "Belgium",         0.66, 0.60, 0.45,  "Croatia",       0.72, 0.58, 0.34,
  "Japan",           0.64, 0.74, 0.36,  "Morocco",       0.50, 0.70, 0.55,
  "Senegal",         0.45, 0.66, 0.62,  "Norway",        0.52, 0.58, 0.60,
  "Uruguay",         0.50, 0.64, 0.52,  "Switzerland",   0.58, 0.60, 0.44,
  "United States",   0.56, 0.74, 0.48,  "Mexico",        0.60, 0.66, 0.44,
  "Ecuador",         0.46, 0.62, 0.56,  "Iran",          0.40, 0.50, 0.58,
  "Egypt",           0.50, 0.55, 0.55,  "Colombia",      0.58, 0.62, 0.48,
  "Scotland",        0.46, 0.60, 0.62,  "Saudi Arabia",  0.48, 0.70, 0.50
)
team_feat <- elos %>%
  left_join(prior, by = "team") %>%
  left_join(set_pieces, by = "team") %>%
  mutate(
    possession = coalesce(possession, 0.55),   # default midpoints for unlisted teams
    press      = coalesce(press, 0.58),
    directness = coalesce(directness, 0.50),
    strength   = (elo_approx - min(elo_approx)) / (max(elo_approx) - min(elo_approx)),
    set_piece_goal_rate = corner_rate + fk_goal_rate + pk_rate,  # computed from seed csv
    xG_per_game  = 0.6 + strength * 1.8,        # proxy: stronger teams create more
    xGA_per_game = 1.8 - strength * 1.2         # proxy: stronger teams concede less
  )

feat_mat <- team_feat %>%
  select(possession, press, directness, strength, set_piece_goal_rate, xG_per_game, xGA_per_game) %>%
  scale()
feat_mat[!is.finite(feat_mat)] <- 0   # guard: any join-gap / constant-col NaN → 0

# ── SECTION B — clustering (NbClust for k, fallback k=5) ──────────────────────
k_opt <- tryCatch({
  nb <- NbClust::NbClust(feat_mat, min.nc = 4, max.nc = 6, method = "kmeans", index = "silhouette")
  as.integer(names(sort(table(nb$Best.nc[1, ]), decreasing = TRUE))[1])
}, error = function(e) { message("  NbClust failed (", conditionMessage(e), ") → k=5"); 5L })
if (is.na(k_opt) || k_opt < 4) k_opt <- 5L
cat("SECTION B: optimal k =", k_opt, "\n")

km <- kmeans(feat_mat, centers = k_opt, nstart = 25)
team_feat$cluster_id <- km$cluster

# Name clusters from centroid signatures (possession/press/directness/strength)
cent <- as.data.frame(km$centers)
label_cluster <- function(r) {
  if (r["possession"] > 0.6 && r["press"] > 0.4)        "HIGH_PRESS_POSSESSION"
  else if (r["directness"] > 0.4 && r["strength"] < 0)  "DIRECT_PHYSICAL"
  else if (r["press"] < -0.2 && r["possession"] < 0)    "COUNTER_DEFENSIVE"
  else if (r["possession"] > 0 && r["strength"] < 0)    "TECHNICAL_LOWBLOCK"
  else                                                  "BALANCED_TRANSITIONAL"
}
cluster_names <- sapply(seq_len(nrow(cent)), function(i) label_cluster(cent[i, ]))
# de-duplicate names if two centroids collide
cluster_names <- make.unique(cluster_names, sep = "_")
team_feat$team_cluster <- cluster_names[team_feat$cluster_id]

cat("SECTION B: centroids\n"); print(round(cent, 2))
cat("\nCluster assignments:\n")
team_feat %>% select(team, team_cluster, elo_approx) %>% arrange(team_cluster, desc(elo_approx)) %>% print(n = 48)

# ── SECTION C — matchup matrix (xG multiplier, attacker_cluster × opp_cluster) ─
# Logical priors (FLAGGED ASSUMED — no WC history data available to estimate from).
base_names <- c("HIGH_PRESS_POSSESSION","DIRECT_PHYSICAL","COUNTER_DEFENSIVE",
                "TECHNICAL_LOWBLOCK","BALANCED_TRANSITIONAL")
M <- matrix(1.0, 5, 5, dimnames = list(base_names, base_names))
M["HIGH_PRESS_POSSESSION","COUNTER_DEFENSIVE"] <- 0.85  # space compressed vs low block
M["HIGH_PRESS_POSSESSION","TECHNICAL_LOWBLOCK"] <- 0.88
M["HIGH_PRESS_POSSESSION","DIRECT_PHYSICAL"]    <- 1.05
M["DIRECT_PHYSICAL","HIGH_PRESS_POSSESSION"]    <- 1.10  # transitions punish high lines
M["DIRECT_PHYSICAL","COUNTER_DEFENSIVE"]        <- 0.90
M["COUNTER_DEFENSIVE","HIGH_PRESS_POSSESSION"]  <- 1.12  # counters thrive vs possession
M["COUNTER_DEFENSIVE","DIRECT_PHYSICAL"]        <- 0.95
M["TECHNICAL_LOWBLOCK","HIGH_PRESS_POSSESSION"] <- 1.08
M["BALANCED_TRANSITIONAL", ] <- 1.0
attr(M, "assumed") <- TRUE

saveRDS(team_feat %>% select(team, cluster_id, team_cluster, elo_approx,
                             possession, press, directness, set_piece_goal_rate),
        file.path(DATA_DIR, "team_clusters.rds"))
saveRDS(M, file.path(DATA_DIR, "matchup_matrix.rds"))
cat("\nSECTION C: matchup matrix (ASSUMED priors)\n"); print(M)
cat("✓ 03_playstyle_clustering.R complete\n")
