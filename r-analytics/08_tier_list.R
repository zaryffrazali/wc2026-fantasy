# ══════════════════════════════════════════════════════════════════════════════
# 08_tier_list.R — gambling/ceiling tier list (S/A/B/C/D) with narratives
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(jsonlite)

os <- readRDS(file.path(DATA_DIR, "optimal_squads.rds"))
rr <- readRDS(file.path(DATA_DIR, "role_regression_results.rds")) %>%
        select(id, roleShiftNote)   # intl_premium_score/mispricing_flag already on all_players
P  <- os$all_players %>% left_join(rr, by = "id") %>%
  mutate(pts_p90 = pts_diff, pts_median = pts_safe, intl_premium_score = coalesce(intl_premium_score, 0))

# ── SECTION A — tier score ────────────────────────────────────────────────────
P <- P %>% mutate(
  scouting_bonus_ev    = if_else(own < 5, 2, if_else(own < 10, 1, 0)),
  captain_slot_3_bonus = if_else(captainSlot == 3, 1, 0),
  set_piece_involvement= if_else(fkTaker | cornerTaker | penTaker, 1, 0),
  tier_raw = pts_p90*0.45 + (pts_p90 - pts_median)*0.20 + scouting_bonus_ev*0.15 +
             intl_premium_score*0.10 + captain_slot_3_bonus*0.05 + set_piece_involvement*0.05 -
             if_else(cardRisk == "high", 0.8, 0) -
             if_else(startProb < 0.80, 1.5, 0) -
             if_else(advP < 50, 1.0, 0)
)
# normalise within position (0-100), then blend with overall rank for cross-position parity
P <- P %>% group_by(pos) %>% mutate(pos_norm = 100*percent_rank(tier_raw)) %>% ungroup() %>%
  mutate(overall_norm = 100*percent_rank(tier_raw),
         tier_score = round(0.6*pos_norm + 0.4*overall_norm, 1))

# ── SECTION B — tier assignment + hard overrides ──────────────────────────────
P <- P %>% arrange(desc(tier_score)) %>% mutate(
  pctl = percent_rank(tier_score),
  tier0 = case_when(pctl >= 0.92 ~ "S", pctl >= 0.75 ~ "A",
                    pctl >= 0.50 ~ "B", pctl >= 0.25 ~ "C", TRUE ~ "D"))
tier_rank <- c(S=1,A=2,B=3,C=4,D=5); rank_tier <- names(tier_rank)
bump <- function(t, by) { r <- pmin(pmax(tier_rank[t] + by, 1), 5); rank_tier[r] }
P <- P %>% mutate(
  tier = tier0,
  tier = if_else(startProb < 0.70 & tier %in% c("S","A"), "B", tier),          # floor too shaky
  tier = if_else(advP < 40 & tier == "S", "A", tier),                          # short lifespan
  tier = if_else(own > 55, bump(tier, 1), tier),                               # template downgrade
  tier = if_else(intl_premium_score > 1.5 & own < 10, bump(tier, -1), tier)    # edge upgrade
)
cat("SECTION B: tier counts\n"); print(table(factor(P$tier, c("S","A","B","C","D"))))

# ── SECTION C — narratives ────────────────────────────────────────────────────
mk_narr <- function(p) {
  E <- 3 + (p$advP/100)*5
  list(
    id=p$id, name=p$name, team=p$team, pos=p$pos, price=p$price, own=p$own,
    tier=p$tier, tier_score=p$tier_score,
    headline = if (p$tier=="S") "A build-around ceiling pick for the differential squad."
               else "A strong core piece with real haul potential.",
    ceiling_case = paste0(sprintf("Up to %.1f pts across %.1f expected matches. ", p$pts_p90, E),
      if (p$penTaker) "Penalty duty adds a floor. " else "",
      if (p$fkTaker) "Direct FK threat adds bonus upside. " else "",
      if (p$captainSlot==3) "Late kickoff maximises captain switch value." else ""),
    differential_edge = if (p$own < 10)
        sprintf("Only %g%% owned — Scouting Bonus eligible (+2 when they haul). A 15-20 rank swing in one matchday.", p$own)
      else if (p$own < 25) sprintf("%g%% owned — moderate differential edge in smaller leagues.", p$own)
      else sprintf("%g%% owned — template; value is not falling behind, not gaining.", p$own),
    mispricing_angle = if (!is.na(p$mispricing_flag) && p$mispricing_flag=="UNDERRATED")
        sprintf("Model detects underpricing (intl_premium +%.2fσ). %s Market prices the club role.",
                p$intl_premium_score, coalesce(p$roleShiftNote,"")) else NA_character_,
    floor_warning = paste0("Floor risk: ", dplyr::case_when(
        p$cardRisk=="high" ~ "high card rate (yellow -1, red -2 + ban). ",
        p$startProb<0.90 ~ sprintf("start uncertainty (%d%%). ", round(p$startProb*100)),
        p$advP<65 ~ sprintf("advancement risk (%d%%). ", p$advP),
        TRUE ~ "minimal for a gambling build.")),
    captain_verdict = if (p$captainSlot==3) "CAPTAIN TIER: late kickoff preserves switch options."
        else if (p$captainSlot==2) "MID-ROUND: reasonable switch destination."
        else "EARLY KICKOFF: captain lock-in risk.",
    one_line_verdict = paste0(p$tier, "-TIER | $", p$price, "m | ", p$own, "% own | ",
        round(p$pts_p90,1), " ceiling | ",
        if (!is.na(p$mispricing_flag) && p$mispricing_flag=="UNDERRATED") "MODEL EDGE ↑ | " else "",
        if (p$own < 10) "SCOUT | " else "",
        if (p$roleShift != "SAME") paste0("ROLE: ", p$roleShift, " | ") else "")
  )
}
# cap narrative generation to top 40 per tier (pool is ~1481; full ranking kept in `scores`)
top_ids <- P %>% filter(tier %in% c("S","A","B")) %>% group_by(tier) %>%
  slice_max(tier_score, n = 40, with_ties = FALSE) %>% pull(id)
narrs <- lapply(which(P$id %in% top_ids), function(i) mk_narr(P[i,]))

# ── SECTION D — print tier list ───────────────────────────────────────────────
print_tier <- function(t, title) {
  cat("\n", strrep("=",55), "\n", t, " TIER — ", title, "\n", strrep("=",55), "\n", sep="")
  P %>% filter(tier==t) %>% arrange(desc(tier_score)) %>% rowwise() %>% do({
    p <- .; cat(sprintf("[%s] %s (%s, %s, $%sm, %g%% own)%s — score: %.1f\n",
      p$tier, p$name, substr(p$team,1,3), p$pos, p$price, p$own,
      if (!is.na(p$mispricing_flag)&&p$mispricing_flag=="UNDERRATED") " ★ MODEL EDGE" else "", p$tier_score)); tibble() }) %>% invisible()
}
print_tier("S","BUILD AROUND"); print_tier("A","STRONG CORE"); print_tier("B","WATCHLIST")

tier_list <- list(
  S = Filter(function(x) x$tier=="S", narrs),
  A = Filter(function(x) x$tier=="A", narrs),
  B = Filter(function(x) x$tier=="B", narrs),
  scores = P %>% select(id, name, team, pos, tier, tier_score, own) %>% arrange(desc(tier_score)))
saveRDS(tier_list, file.path(DATA_DIR, "tier_list.rds"))
write_json(tier_list, file.path(OUTPUT_DIR, "tier_list.json"), auto_unbox=TRUE, pretty=TRUE, na="null")
cat("\n✓ 08_tier_list.R complete\n")
