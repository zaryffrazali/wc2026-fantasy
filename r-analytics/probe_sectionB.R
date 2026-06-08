# probe_sectionB.R — run SECTION B + the match step in isolation and report exactly
# where real club data is (or isn't) reaching players. Read-only.
# Run:  Rscript r-analytics/probe_sectionB.R
suppressMessages({ library(tidyverse); library(janitor); library(worldfootballR); library(jsonlite) })

norm_name <- function(x) x |> tolower() |> stringi::stri_trans_general("Latin-ASCII") |>
  str_replace_all("[^a-z ]", " ") |> str_squish()
last_tok  <- function(x) word(norm_name(x), -1)

# ── replicate SECTION B exactly ───────────────────────────────────────────────
std <- load_fb_big5_advanced_season_stats(season_end_year = 2025, stat_type = "standard", team_or_player = "player") |> clean_names()
Sys.sleep(3)
sht <- load_fb_big5_advanced_season_stats(season_end_year = 2025, stat_type = "shooting", team_or_player = "player") |> clean_names()
sot_col <- intersect(c("sh_t_per_90_standard","s_o_t_per_90_standard","sot_per_90_standard"), names(sht))
cat("sot_col matched:", if (length(sot_col)) sot_col else "NONE (SoT will be NA — known, non-fatal)", "\n")

club_real <- std |> transmute(player, squad,
      club_npxG_p90 = npx_g_per, club_xAG_p90 = x_ag_per, club_mins = min_playing) |>
  left_join(sht |> transmute(player, squad,
      club_sot_p90 = if (length(sot_col)) .data[[sot_col[1]]] else NA_real_), by = c("player","squad")) |>
  mutate(nname = norm_name(player), lname = last_tok(player))

cat("\nclub_real rows:", nrow(club_real), "\n")
cat("club_npxG_p90 class:", class(club_real$club_npxG_p90), "| n NA:", sum(is.na(club_real$club_npxG_p90)), "\n")
cat("sample:\n"); print(head(club_real |> select(player, squad, club_npxG_p90, club_xAG_p90), 5))

# ── test the match against the actual seed names ──────────────────────────────
raw <- fromJSON("public/data/players.json")
seed <- if (!is.null(raw$players)) raw$players else raw
match_one <- function(nm, src) {
  n <- norm_name(nm); l <- last_tok(nm)
  hit <- src |> filter(nname == n)
  if (!nrow(hit)) hit <- src |> filter(str_detect(nname, fixed(n)) | str_detect(n, fixed(nname)))
  if (!nrow(hit)) hit <- src |> filter(lname == l)
  if (nrow(hit)) hit[1, ] else NULL
}
cat("\n── targeted matches ──\n")
for (nm in c("Mohammed Amoura","Amine Gouiri","Achraf Hakimi","Jude Bellingham")) {
  cr <- match_one(nm, club_real)
  if (is.null(cr)) cat(sprintf("  %-18s NO MATCH (norm: '%s')\n", nm, norm_name(nm)))
  else cat(sprintf("  %-18s -> %s / %s  npxG_p90=%s\n", nm, cr$player, cr$squad, cr$club_npxG_p90))
}
# overall match rate
n_seed <- nrow(seed)
hits <- sum(vapply(seed$name, function(nm) !is.null(match_one(nm, club_real)), logical(1)))
cat(sprintf("\nseed players matched in club_real: %d / %d\n", hits, n_seed))
