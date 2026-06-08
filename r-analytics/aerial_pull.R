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
# first names compatible? (equal or shared 3-letter prefix) — stops surname collisions
# like Viktor/Herman Johansson both matching one Big-5 "Johansson".
fn_ok <- function(a, b) { a <- word(a, 1); b <- word(b, 1)
  isTRUE(a == b || (nchar(a) >= 3 && nchar(b) >= 3 &&
    (startsWith(a, substr(b, 1, 3)) || startsWith(b, substr(a, 1, 3))))) }

PLAYERS <- "public/data/players.json"
SEASON  <- 2025

# ── 1. misc (aerial duels) — minutes taken from the SAME table for snapshot consistency ──
# The misc cache can lag the standard cache (e.g. a mid-season snapshot). Dividing misc's
# aerial counts by full-season minutes from the standard table would bias the per-90 rate.
# So we use misc's own "90s" playing-time column → numerator and denominator are one snapshot.
misc <- load_fb_big5_advanced_season_stats(season_end_year = SEASON, stat_type = "misc",
                                            team_or_player = "player") |> clean_names()
nineties_col <- intersect(c("mins_per_90", "x90s", "x90s_playing_time", "mins_per_90_playing"), names(misc))
if (!length(nineties_col)) nineties_col <- grep("(^x?90s$)|(^mins_per_90$)", names(misc), value = TRUE)
cat("misc rows:", nrow(misc), "| 90s column:", if (length(nineties_col)) nineties_col[1] else "NOT FOUND", "\n")
stopifnot(nrow(misc) > 100, length(nineties_col) >= 1,
          all(c("won_aerial", "won_percent_aerial") %in% names(misc)))

aer <- misc |>
  transmute(player, squad, fpos = pos,                         # FBref position, for position-aware matching
            won = suppressWarnings(as.numeric(won_aerial)),
            pct = suppressWarnings(as.numeric(won_percent_aerial)),
            nineties = suppressWarnings(as.numeric(.data[[nineties_col[1]]]))) |>
  filter(!is.na(won), !is.na(nineties), nineties >= 3) |>      # ≥ ~3 full matches for a stable rate
  mutate(p90 = won / nineties,
         nname = norm_name(player), lname = last_tok(player)) |>
  group_by(nname) |> slice_max(nineties, n = 1, with_ties = FALSE) |> ungroup()

thr <- as.numeric(quantile(aer$p90, 0.75, na.rm = TRUE))
cat("players with aerial rate:", nrow(aer), "| top-quartile p90 threshold:", round(thr, 2), "\n")

# ── 2. match into players.json by surname, disambiguated by token overlap ──────
pj <- fromJSON(PLAYERS, simplifyVector = FALSE)
players <- if (!is.null(pj$players)) pj$players else pj
# seed pos → FBref pos token. GKs are not an aerial *attacking* threat and map to nothing,
# so they're skipped. Position-matching also resolves same-name collisions (two "Carlos
# Sánchez" only match the Big-5 row whose position matches theirs).
POSMAP <- list(DEF = "DF", MID = "MF", FWD = "FW")
matched <- 0
players <- lapply(players, function(p) {
  p$aerial_won_pct <- NULL; p$aerial_won_p90 <- NULL; p$aerial_threat <- NULL  # CLEAR stale values first
  ptok <- POSMAP[[p$pos]]; if (is.null(ptok)) return(p)        # GK / unmapped → no aerial (now truly absent)
  pn <- norm_name(p$name); pl <- last_tok(p$name)
  exact <- aer[aer$nname == pn, ]                              # 1. exact full name
  if (nrow(exact)) { cand <- exact } else {                   # 2. surname ONLY if unambiguous AND first name compatible
    sn <- aer[aer$lname == pl, ]
    if (nrow(sn) == 1 && fn_ok(pn, sn$nname[1])) cand <- sn else return(p)
  }
  cand <- cand[grepl(ptok, cand$fpos, ignore.case = TRUE), , drop = FALSE]  # position-compatible only
  if (!nrow(cand)) return(p)
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
