# ══════════════════════════════════════════════════════════════════════════════
# 01_data_pull.R — assemble master_players from REAL club data where reachable.
#   • Club stats: load_fb_big5_advanced_season_stats() → GitHub-cached, no 403
#   • Cross-source: load_understat_league_shots() → GitHub-cached shot data
#   • National-team FBref pages: attempted but FBref blocks (403) → seed/proxy
#   • Non-Big5 players: r-analytics/data/manual_stats.csv fallback
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(jsonlite); library(janitor); library(worldfootballR)
options(HTTPUserAgent = "Mozilla/5.0 (compatible; academic research)")  # (1) custom UA

# normalise names for fuzzy matching across data sources (strip accents/punct/initials)
norm_name <- function(x) x |> tolower() |> stringi::stri_trans_general("Latin-ASCII") |>
  str_replace_all("[^a-z ]", " ") |> str_squish()
last_tok  <- function(x) word(norm_name(x), -1)

# ── SECTION A — seed crosswalk ────────────────────────────────────────────────
raw <- fromJSON(file.path(PUBLIC_DATA_DIR, "players.json"))
# players.json may be a bare array (legacy) or { generated_at, players } (wrapped)
if (is.list(raw) && !is.null(raw$players)) {
  seed_players <- raw$players
} else {
  seed_players <- raw
}
# 07 merges computed analytics back into players.json — strip them so re-runs are
# idempotent (otherwise bind_cols/joins downstream duplicate these columns).
ANALYTICS_COLS <- c("intl_premium_xG","intl_premium_xA","intl_premium_score","mispricing_flag",
  "mispricing_direction","team_cluster","tier","tier_score","pts_safe","pts_balanced","pts_diff",
  "captain_ev","md1_xG_adj","md2_xG_adj","md3_xG_adj","team_overperf_predicted",
  "giant_killer_flag","overvalued_team_flag","causal_pts_adjustment","form_mult","form_n")
seed_players <- seed_players[, setdiff(names(seed_players), ANALYTICS_COLS)]
elos       <- read_csv(file.path(DATA_DIR, "team_elos.csv"), show_col_types = FALSE)
set_pieces <- read_csv(file.path(DATA_DIR, "set_piece_rates.csv"), show_col_types = FALSE)
manual     <- read_csv(file.path(DATA_DIR, "manual_stats.csv"), show_col_types = FALSE)
cat("SECTION A: seed_players =", nrow(seed_players), "\n")

# ── SECTION B — FBref Big-5 club stats (GitHub-cached LOAD, no rate limit) ─────
club_real <- tryCatch({
  std <- load_fb_big5_advanced_season_stats(season_end_year = 2026, stat_type = "standard", team_or_player = "player") |> clean_names()
  Sys.sleep(5)  # (2) be gentle even on cached loads
  sht <- load_fb_big5_advanced_season_stats(season_end_year = 2026, stat_type = "shooting", team_or_player = "player") |> clean_names()
  sot_col <- intersect(c("sh_t_per_90_standard","s_o_t_per_90_standard","sot_per_90_standard"), names(sht))
  std |> transmute(player, squad,
      club_npxG_p90 = npx_g_per, club_xAG_p90 = x_ag_per, club_mins = min_playing) |>
    left_join(sht |> transmute(player, squad,
      club_sot_p90 = if (length(sot_col)) .data[[sot_col[1]]] else NA_real_), by = c("player","squad")) |>
    mutate(nname = norm_name(player), lname = last_tok(player))
}, error = function(e) { message("  FBref big5 load failed: ", conditionMessage(e)); NULL })
cat("SECTION B: FBref big5 club rows =", if (is.null(club_real)) 0 else nrow(club_real), "\n")

# ── SECTION C — Understat shots → player npxG/xA totals (cross-source) ─────────
understat_players <- tryCatch({
  leagues <- c("EPL","La liga","Bundesliga","Serie A","Ligue 1")
  shots <- map_dfr(leagues, function(lg) {
    s <- tryCatch(load_understat_league_shots(league = lg) |> clean_names(), error = function(e) NULL)
    if (is.null(s)) return(tibble()); Sys.sleep(1); s |> filter(season == 2025)
  })
  npx <- shots |> filter(situation != "Penalty") |> group_by(player) |>
    summarise(u_npxG = sum(x_g, na.rm = TRUE), u_shots = n(), .groups = "drop")
  xa  <- shots |> filter(!is.na(player_assisted), player_assisted != "") |>
    group_by(player = player_assisted) |> summarise(u_xA = sum(x_g, na.rm = TRUE), .groups = "drop")
  full_join(npx, xa, by = "player") |> mutate(nname = norm_name(player), lname = last_tok(player))
}, error = function(e) { message("  Understat load failed: ", conditionMessage(e)); NULL })
cat("SECTION C: Understat players =", if (is.null(understat_players)) 0 else nrow(understat_players), "\n")

# ── SECTION D — National-team FBref (rate-limited; test once, skip loop if 403) ─
# FBref national pages 403 from this environment. We probe once rather than burn
# ~48×(5-30s) on guaranteed failures, then fall back. (Loop logic kept, gated.)
intl_ok <- FALSE
if (FBREF_AVAILABLE) {
  test <- tryCatch({ Sys.sleep(5); fb_season_team_stats(country = "ENG", gender = "M", season_end_year = 2026, tier = "1st", stat_type = "standard") },
                   error = function(e) { message("  FBref team-stats probe failed: ", conditionMessage(e)); NULL })
  intl_ok <- !is.null(test)
}
cat("SECTION D: FBref national-team pulls", if (intl_ok) "available" else "UNAVAILABLE (403) → intl proxied", "\n")

# ── SECTION D2 — WC history (GitHub-cached results) ───────────────────────────
wc_history <- tryCatch(load_match_comp_results(comp_name = "FIFA World Cup"),
                       error = function(e) { message("  WC history load failed: ", conditionMessage(e)); tibble() })
cat("SECTION D2: WC history rows =", nrow(wc_history), "\n")

# ── SECTION E — match seed players to real data, layered fallback ─────────────
match_one <- function(nm, src) {
  if (is.null(src)) return(NULL)
  n <- norm_name(nm); l <- last_tok(nm)
  hit <- src |> filter(nname == n)
  if (!nrow(hit)) hit <- src |> filter(str_detect(nname, fixed(n)) | str_detect(n, fixed(nname)))
  if (!nrow(hit)) hit <- src |> filter(lname == l)
  if (nrow(hit)) hit[1, ] else NULL
}
rows <- lapply(seq_len(nrow(seed_players)), function(i) {
  p <- seed_players[i, ]
  cr <- match_one(p$name, club_real); us <- match_one(p$name, understat_players)
  mn <- manual |> filter(name == p$name, team == p$team)
  src <- "seed_proxy"; npxg <- max(p$xGp90 - ifelse(p$penTaker, 0.06, 0), 0); xag <- p$xAp90; sot <- p$SoTp90
  if (!is.null(cr) && !is.na(cr$club_npxG_p90)) { npxg <- cr$club_npxG_p90; xag <- cr$club_xAG_p90
    if (!is.na(cr$club_sot_p90)) sot <- cr$club_sot_p90; src <- "fbref_big5" }
  else if (nrow(mn)) { npxg <- mn$npxG_p90; xag <- mn$xAG_p90; sot <- mn$SoT_p90; src <- "manual" }
  tibble(id = p$id, club_npxG_p90 = npxg, club_xAG_p90 = xag, club_sot_p90 = sot,
         data_source = src, in_fbref = !is.null(cr), in_understat = !is.null(us))
})
real_stats <- bind_rows(rows)

master_players <- seed_players |>
  left_join(real_stats, by = "id") |>
  left_join(elos, by = "team") |> left_join(set_pieces, by = "team") |>
  mutate(
    natl_team_elo = coalesce(elo_approx, 1600),
    league_tier   = if_else(price >= 5 | own >= 10, 1L, 2L),
    npxG_p90_club = club_npxG_p90, xAG_p90_club = club_xAG_p90,
    # intl proxy (national-team data still unreachable): scale club by intlGR + advancement
    intl_scale    = 0.75 + 0.5 * pmin(intlGR / pmax(xGp90, 0.01), 1.5) * (advP / 100),
    npxG_p90_intl = club_npxG_p90 * intl_scale,
    xAG_p90_intl  = club_xAG_p90 * (0.85 + 0.3 * advP / 100),
    intl_npxG_p90 = npxG_p90_intl, intl_xAG_p90 = xAG_p90_intl,  # aliases for 02_role_regression
    intl_apps_24m = round(startProb * 18),
    mins_ratio    = (startProb * minsIfStarted) / 90,
    role_shift    = roleShift,
    # push REAL club output into the points-model inputs for pool players matched in
    # FBref (curated stars keep their hand-vetted values; small-sample FBref kept off them)
    xGp90  = if_else(data_tier != "curated" & data_source == "fbref_big5", club_npxG_p90, xGp90),
    xAp90  = if_else(data_tier != "curated" & data_source == "fbref_big5", club_xAG_p90, xAp90),
    SoTp90 = if_else(data_tier != "curated" & data_source == "fbref_big5" & !is.na(club_sot_p90), club_sot_p90, SoTp90)
  )
saveRDS(master_players, file.path(DATA_DIR, "master_players.rds"))

# ── SECTION F — data quality report ───────────────────────────────────────────
nf <- sum(real_stats$in_fbref); nu <- sum(real_stats$in_understat)
nm <- sum(real_stats$data_source == "manual"); ns <- sum(real_stats$data_source == "seed_proxy")
cat("\n── DATA QUALITY ──\n")
cat("  matched in FBref big5 :", nf, "/ 58\n")
cat("  matched in Understat  :", nu, "/ 58\n")
cat("  manual fallback       :", nm, "\n")
cat("  seed proxy (no match) :", ns, "\n")
cat("  NOTE: Understat/FBref-load cover Big-5 club leagues only. Saudi Pro League\n")
cat("        (Bounou), Liga MX (R. Jimenez is EPL→ok), Greek/Eredivisie/domestic GKs\n")
cat("        fall to manual/seed. National-team (intl) stats remain proxied (FBref 403).\n")
unmatched <- master_players |> filter(data_source == "seed_proxy") |> pull(name)
if (length(unmatched)) cat("  seed-proxy players:", paste(unmatched, collapse = ", "), "\n")
cat("✓ 01_data_pull.R complete\n")
