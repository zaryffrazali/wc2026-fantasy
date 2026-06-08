# probe_cols.R — print the exact standard/shooting column names SECTION B needs.
# Read-only. Run:  Rscript r-analytics/probe_cols.R
suppressMessages({ library(worldfootballR); library(janitor); library(dplyr) })

std <- load_fb_big5_advanced_season_stats(season_end_year = 2025, stat_type = "standard", team_or_player = "player") |> clean_names()
Sys.sleep(3)
sht <- load_fb_big5_advanced_season_stats(season_end_year = 2025, stat_type = "shooting", team_or_player = "player") |> clean_names()

cat("standard rows:", nrow(std), " shooting rows:", nrow(sht), "\n\n")

cat("STANDARD cols matching npxg / xag / per90 / minutes:\n")
print(grep("npx|x_ag|xag|per|min|90", names(std), value = TRUE, ignore.case = TRUE))

cat("\nSECTION B currently reads these — do they exist?\n")
for (c in c("npx_g_per", "x_ag_per", "min_playing")) cat(sprintf("  %-14s %s\n", c, c %in% names(std)))

cat("\nSHOOTING cols matching sot / per90:\n")
print(grep("sh_t|s_o_t|sot|per", names(sht), value = TRUE, ignore.case = TRUE))
