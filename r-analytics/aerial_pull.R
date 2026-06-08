# aerial_pull.R — add aerial-threat data to public/data/players.json
#
# Source: FBref "Miscellaneous" club stats via worldfootballR's GitHub-CACHED loader
# (load_fb_big5_advanced_season_stats) — real FBref numbers, no live scraping, no 403.
# Minutes are joined from the STANDARD table (confirmed column `min_playing`); the misc
# table's own minutes column name is unstable across versions, so we don't rely on it.
#
# Season: 2025 (complete 2024-25). The cache snapshot (2025-09-18) has only ~5 games of
# 2025-26, so 2025 is the freshest COMPLETE season — same choice as 01_data_pull.R.
#
# Adds to each matched player in players.json:
#   aerial_won_pct   — % of aerial duels won (won_percent_aerial)
#   aerial_won_p90   — aerials WON per 90 (volume × success — the real "threat" signal)
#   aerial_threat    — boolean: top quartile of aerial_won_p90 among players with data
#
# Coverage: Big-5 European leagues only. Players outside them get no aerial fields.
# Run:  Rscript r-analytics/aerial_pull.R

suppressMessages({ library(tidyverse); library(jsonlite); library(janitor); library(worldfootballR) })

norm_name <- function(x) x |> tolower() |> stringi::stri_trans_general("Latin-ASCII") |>
  str_replace_all("[^a-z ]", " ") |> str_squish()
last_tok  <- function(x) word(norm_name(x), -1)

PLAYERS <- "public/data/players.json"
SEASON  <- 2025

# ── 1. misc (aerial duels) + standard (minutes), both cached ──────────────────
misc <- load_fb_big5_advanced_season_stats(season_end_year = SEASON, stat_type = "misc",
                                            team_or_player = "player") |> clean_names()
Sys.sleep(4)
std  <- load_fb_big5_advanced_season_stats(season_end_year = SEASON, stat_type = "standard",
                                           team_or_player = "player") |> clean_names()
cat("misc rows:", nrow(misc), "| standard rows:", nrow(std), "\n")
stopifnot(nrow(misc) > 100, nrow(std) > 100,
          all(c("won_aerial", "won_percent_aerial") %in% names(misc)),
          "min_playing" %in% names(std))

aer <- misc |>
  transmute(player, squad,
            won = suppressWarnings(as.numeric(won_aerial)),
            pct = suppressWarnings(as.numeric(won_percent_aerial))) |>
  left_join(std |> transmute(player, squad, mins = suppressWarnings(as.numeric(min_playing))),
            by = c("player", "squad")) |>
  filter(!is.na(won), !is.na(mins), mins >= 270) |>            # ≥ ~3 full matches for a stable rate
  mutate(p90 = won / (mins / 90),
         nname = norm_name(player), lname = last_tok(player)) |>
  group_by(nname) |> slice_max(mins, n = 1, with_ties = FALSE) |> ungroup()

thr <- as.numeric(quantile(aer$p90, 0.75, na.rm = TRUE))
cat("players with aerial rate:", nrow(aer), "| top-quartile p90 threshold:", round(thr, 2), "\n")

# ── 2. match into players.json by surname, disambiguated by token overlap ──────
pj <- fromJSON(PLAYERS, simplifyVector = FALSE)
players <- if (!is.null(pj$players)) pj$players else pj
matched <- 0
players <- lapply(players, function(p) {
  pn <- norm_name(p$name); pl <- last_tok(p$name)
  cand <- aer[aer$lname == pl, ]
  if (nrow(cand) == 0) return(p)
  if (nrow(cand) > 1) {
    toks <- str_split(pn, " ")[[1]]
    cand$score <- vapply(cand$nname, function(n) sum(toks %in% str_split(n, " ")[[1]]), numeric(1))
    cand <- cand[order(-cand$score), ]
  }
  hit <- cand[1, ]
  p$aerial_won_pct <- round(hit$pct, 1)
  p$aerial_won_p90 <- round(hit$p90, 2)
  p$aerial_threat  <- isTRUE(hit$p90 >= thr)
  matched <<- matched + 1
  p
})
cat("players matched with aerial data:", matched, "/", length(players), "\n")

if (!is.null(pj$players)) pj$players <- players else pj <- players
write_json(pj, PLAYERS, auto_unbox = TRUE, pretty = TRUE, digits = 4)
cat("wrote", PLAYERS, "\n")
