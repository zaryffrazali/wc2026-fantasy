# ══════════════════════════════════════════════════════════════════════════════
# 10_form_tracker.R — Bayesian international-form tracker (Phase 1)
#   prior  = club xG-involvement/90 (from FBref big5, via 01)
#   update = precision-weighted blend of recent international matches (minutes +
#            45-day recency decay). Recompute from the full match log each run so
#            appending a friendly to intl_matches.csv → re-run → form propagates.
#   output = form_multiplier per player, applied to xG/xA in 04 (replaces static proxy).
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse)

mp <- readRDS(file.path(DATA_DIR, "master_players.rds"))
mlog <- tryCatch(read_csv(file.path(DATA_DIR, "intl_matches.csv"), show_col_types = FALSE),
                 error = function(e) tibble())

K0 <- 4          # prior strength in match-equivalents
HALF_LIFE <- 45  # days

norm <- function(x) x |> tolower() |> stringi::stri_trans_general("Latin-ASCII") |>
  str_replace_all("[^a-z ]"," ") |> str_squish()

# club baseline μ0 = npxG/90 + xAG/90 (attacking involvement); GKs excluded from form
mp <- mp %>% mutate(mu0 = pmax(coalesce(club_npxG_p90, xGp90) + coalesce(club_xAG_p90, xAp90), 0.02))

form <- mp %>% transmute(id, name, team, pos, mu0, form_mult = 1.0, form_mean = mu0, form_n = 0L, last_date = NA_character_)

if (nrow(mlog) > 0) {
  ref <- max(as.Date(mlog$date), na.rm = TRUE)
  # attach each match to a player id via team + normalised-name token overlap
  mp$nn <- norm(mp$name)
  matchId <- function(pl, tm) {
    cand <- which(mp$team == tm)
    if (!length(cand)) return(NA_integer_)
    toks <- strsplit(norm(pl), " ")[[1]]
    sc <- sapply(cand, function(k) sum(strsplit(mp$nn[k]," ")[[1]] %in% toks))
    if (max(sc) > 0) mp$id[cand[which.max(sc)]] else NA_integer_
  }
  mlog <- mlog %>% mutate(
    pid = mapply(matchId, player, team),
    mins90 = pmax(minutes/90, 0.001),
    obs = (xG + xA) / mins90,                            # per-90 involvement that match
    w   = pmin(minutes/90, 1) * 0.5^(as.numeric(ref - as.Date(date))/HALF_LIFE))
  agg <- mlog %>% filter(!is.na(pid)) %>% group_by(pid) %>%
    summarise(sw = sum(w), swo = sum(w*obs), n = n(), last_dt = as.character(max(as.Date(date))), .groups="drop")
  form <- form %>% select(-last_date) %>% left_join(agg, by = c("id"="pid")) %>%
    mutate(
      form_mean = ifelse(is.na(sw), mu0, (K0*mu0 + swo)/(K0 + sw)),
      raw_mult  = form_mean / pmax(mu0, 0.05),
      form_mult = ifelse(pos == "GK" | is.na(sw), 1.0, pmax(0.5, pmin(2.0, raw_mult))),
      form_n    = coalesce(n, 0L),
      last_date = last_dt
    ) %>% select(id, name, team, pos, mu0, form_mean, form_mult, form_n, last_date)
  unmatched <- mlog %>% filter(is.na(pid))
  if (nrow(unmatched)) cat("⚠ unmatched match rows:", paste(unmatched$player, collapse=", "), "\n")
  # per-player match series for the UI sparkline (Phase 3)
  saveRDS(mlog %>% filter(!is.na(pid)) %>%
            transmute(id = pid, date = as.character(date), opp = opponent,
                      gi = round(xG + xA, 2), mins = minutes) %>% arrange(date),
          file.path(DATA_DIR, "form_log.rds"))
}

saveRDS(form %>% select(id, form_mult, form_mean, form_n, last_date), file.path(DATA_DIR, "player_form.rds"))
cat("SECTION: form updated from", nrow(mlog), "international match rows\n")
moved <- form %>% filter(form_n > 0) %>% arrange(desc(form_mult)) %>%
  mutate(across(c(mu0, form_mean), ~round(.,2)), form_mult = round(form_mult, 2))
if (nrow(moved)) { cat("Players with updated form:\n"); print(moved %>% select(name, team, mu0, form_mean, form_mult, form_n)) }
cat("✓ 10_form_tracker.R complete\n")
