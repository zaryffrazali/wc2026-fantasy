# probe_fbref.R — read-only check of WHICH seasons the GitHub-cached FBref loaders
# actually contain in THIS environment. Nothing is written.
# Run AFTER updating worldfootballR:  Rscript r-analytics/probe_fbref.R
cat("── probe_fbref.R ──\n")

has_wfr <- requireNamespace("worldfootballR", quietly = TRUE)
if (!has_wfr) { cat("✖ worldfootballR not installed: devtools::install_github('JaseZiv/worldfootballR')\n"); quit(status = 1) }
suppressMessages({ library(worldfootballR); library(janitor); library(dplyr) })
cat("worldfootballR version :", as.character(packageVersion("worldfootballR")), "\n\n")

probe_year <- function(yr) {
  r <- tryCatch(load_fb_big5_advanced_season_stats(season_end_year = yr, stat_type = "standard", team_or_player = "player") |> clean_names(),
                error = function(e) { cat(sprintf("  %d standard : ERROR %s\n", yr, conditionMessage(e))); NULL })
  if (!is.null(r)) cat(sprintf("  %d standard : %5d rows\n", yr, nrow(r)))
  Sys.sleep(3); invisible(r)
}

cat("Standard big5 rows by season (watch the 'Data last updated' line above):\n")
for (yr in c(2024, 2025, 2026)) probe_year(yr)

cat("\nDECISION:\n")
cat("  • Pick the most recent season with thousands of rows = freshest COMPLETE FBref data.\n")
cat("  • If only 2024/2025 have rows, we re-point the pipeline's season_end_year to that.\n")
cat("  • If 2026 has rows now, the pipeline runs as-is and gets the 2025-26 season.\n")
