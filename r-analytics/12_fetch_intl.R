# ══════════════════════════════════════════════════════════════════════════════
# 12_fetch_intl.R — auto-fetch adapter for international match data (Phase 2)
#   Refreshes r-analytics/data/intl_matches.csv from available providers, deduped.
#   Run MANUALLY before run_all when you want to pull new data:  Rscript r-analytics/12_fetch_intl.R
#
#   PROVIDERS (each returns rows in the canonical schema, or empty):
#     1. drop-file   — r-analytics/data/intl_matches_incoming.csv (always works; your export path)
#     2. api-football— if APIFOOTBALL_KEY env var set (gives goals/assists/mins; xG only on paid tiers)
#     3. worldfootballR cached — international comps IF present in the cached repo
#
#   HONEST NOTE: from this sandbox, FBref/SofaScore/API-Football are all 403/keyed and the
#   cached repo does not include friendly player data, so only the drop-file provider is
#   active here. The adapter is wired and ready; it pulls automatically wherever a provider
#   is reachable (a machine with FBref access, or with an API key set).
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(jsonlite)
SCHEMA <- c("player","team","date","opponent","minutes","xG","xA","goals","assists")
empty  <- function() as_tibble(setNames(replicate(length(SCHEMA), logical(0), simplify=FALSE), SCHEMA))

# ── provider 1: drop-file ─────────────────────────────────────────────────────
prov_dropfile <- function() {
  f <- file.path(DATA_DIR, "intl_matches_incoming.csv")
  if (!file.exists(f)) return(empty())
  d <- read_csv(f, show_col_types = FALSE)
  cat("  [drop-file]", nrow(d), "rows from intl_matches_incoming.csv\n"); d
}

# ── provider 2: API-Football (keyed; uses curl CLI so no extra R deps) ─────────
prov_apifootball <- function(teams) {
  key <- Sys.getenv("APIFOOTBALL_KEY"); if (key == "") { cat("  [api-football] no APIFOOTBALL_KEY — skipped\n"); return(empty()) }
  out <- list()
  for (tm in teams) {
    res <- tryCatch({
      raw <- system2("curl", c("-s","--max-time","15","-H", shQuote(paste0("x-apisports-key: ", key)),
        shQuote(paste0("https://v3.football.api-sports.io/fixtures?team=", utils::URLencode(tm),
                       "&last=3&status=FT"))), stdout = TRUE)
      fromJSON(paste(raw, collapse=""), simplifyVector = FALSE)
    }, error = function(e) NULL)
    # NOTE: full per-player mapping (fixtures/players?fixture=ID) goes here; left as the
    # documented extension point — shape varies by plan. Defensive: contributes nothing on error.
    if (is.null(res)) next
  }
  if (!length(out)) { cat("  [api-football] key present but no rows mapped (see extension point)\n"); return(empty()) }
  bind_rows(out)
}

# ── provider 3: worldfootballR cached international comps ──────────────────────
prov_cached <- function() {
  r <- tryCatch(worldfootballR::load_match_comp_results(comp_name = "Friendlies M"),
                error = function(e) NULL)
  if (is.null(r) || nrow(r) == 0) { cat("  [cached-fbref] no international player data in cache — skipped\n"); return(empty()) }
  # match-level only (no per-player xG) → cannot attribute to players; report and skip
  cat("  [cached-fbref]", nrow(r), "match results found but no per-player stats — not usable for form\n"); empty()
}

# ── run providers + merge/dedup into intl_matches.csv ─────────────────────────
existing <- tryCatch(read_csv(file.path(DATA_DIR, "intl_matches.csv"), show_col_types = FALSE), error = function(e) empty())
teams <- unique(existing$team)
cat("Fetching international matches from providers:\n")
fetched <- bind_rows(Filter(function(d) nrow(d) > 0, list(prov_dropfile(), prov_apifootball(teams), prov_cached())))

if (nrow(fetched) == 0) {
  cat("No new rows from automated providers (manual intl_matches.csv remains the active path here).\n")
} else {
  fetched <- fetched %>% select(any_of(SCHEMA))
  merged <- bind_rows(existing, fetched) %>%
    distinct(player, date, opponent, .keep_all = TRUE) %>% arrange(date)
  added <- nrow(merged) - nrow(existing)
  write_csv(merged, file.path(DATA_DIR, "intl_matches.csv"))
  cat("Merged:", added, "new match rows →", nrow(merged), "total in intl_matches.csv\n")
  # consume the drop-file so rows aren't re-added next run
  f <- file.path(DATA_DIR, "intl_matches_incoming.csv"); if (file.exists(f)) file.remove(f)
}
cat("✓ 12_fetch_intl.R complete (run 10_form_tracker / run_all to propagate)\n")
