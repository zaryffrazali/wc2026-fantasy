# ══════════════════════════════════════════════════════════════════════════════
# 06_starting_xi.R — "Econometrics Predicts the Starting XI": best XI + narratives + pitch
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(ggplot2); library(ggrepel)

os       <- readRDS(file.path(DATA_DIR, "optimal_squads.rds"))
rr       <- readRDS(file.path(DATA_DIR, "role_regression_results.rds")) %>%
              select(id, roleShiftNote)   # intl_premium_score/mispricing_flag already on all_players
clusters <- readRDS(file.path(DATA_DIR, "team_clusters.rds")) %>% select(team, team_cluster)
players  <- os$all_players %>% left_join(rr, by = "id") %>% left_join(clusters, by = "team")

# ── SECTION A — pick formation that maximises pts_balanced from the full pool ──
FORMATIONS <- list("3-4-3"=c(3,4,3), "3-5-2"=c(3,5,2), "4-3-3"=c(4,3,3),
                   "4-4-2"=c(4,4,2), "4-5-1"=c(4,5,1), "5-3-2"=c(5,3,2))
top_by_pos <- function(pos, n) players %>% filter(pos == !!pos) %>% arrange(desc(pts_balanced)) %>% head(n)
best <- NULL
for (fn in names(FORMATIONS)) {
  d <- FORMATIONS[[fn]]
  xi <- bind_rows(top_by_pos("GK",1), top_by_pos("DEF",d[1]), top_by_pos("MID",d[2]), top_by_pos("FWD",d[3]))
  tot <- sum(xi$pts_balanced)
  if (is.null(best) || tot > best$tot) best <- list(formation = fn, dims = d, xi = xi, tot = tot)
}
xi <- best$xi
captain_id <- xi$id[which.max(xi$pts_diff)]
cat(sprintf("SECTION A: formation %s — total %.1f pts\n", best$formation, best$tot))

# ── SECTION C — formation layout coords (GK row, DEF, MID, FWD rows) ───────────
row_x <- function(n) if (n == 0) numeric(0) else seq(15, 85, length.out = n)
d <- best$dims
layout <- tibble(
  id  = xi$id,
  pos = xi$pos,
  x   = c(50, row_x(d[1]), row_x(d[2]), row_x(d[3])),
  y   = c(6, rep(28, d[1]), rep(55, d[2]), rep(82, d[3]))
)
xi <- xi %>% left_join(layout, by = c("id","pos"))

# ── SECTION B — per-player narratives ─────────────────────────────────────────
ROLE_MULT <- list(SAME=c(1,1), DEF_to_ATT=c(1.40,1.60), ATT_to_DEF=c(0.60,0.70),
                  MID_to_ATT=c(1.25,1.20), MID_to_DEF=c(0.75,0.80), WING_to_STRIKER=c(1.30,0.80))
narr <- lapply(seq_len(nrow(xi)), function(i) {
  p <- xi[i, ]; fx <- p$fixtures[[1]]
  rm <- ROLE_MULT[[p$roleShift]]; if (is.null(rm)) rm <- c(1,1)
  E_matches <- 3 + (p$advP/100)*5
  is_cap <- p$id == captain_id
  list(
    id = p$id, name = p$name, team = p$team, pos = p$pos,
    formation_slot = p$pos, price = p$price, own = p$own,
    pts_balanced = round(p$pts_balanced,1), pts_p90 = round(p$pts_diff,1),
    value = round(p$pts_balanced / p$price, 2),
    is_captain = is_cap,
    primary_reason = sprintf("%s: %.1f predicted pts across %.1f expected matches at $%sm.",
                             p$name, p$pts_balanced, E_matches, p$price),
    model_signals = c(
      sprintf("xG/90 club %.2f → role-adjusted %.2f", p$xGp90, p$xGp90*rm[1]),
      sprintf("Advancement probability: %d%%", p$advP),
      sprintf("Expected matches: %.1f", E_matches),
      sprintf("Fixtures: MD1 %s (%d%% win), MD2 %s (%d%% win), MD3 %s (%d%% win)",
              fx$opponent[1], round(fx$oddsWin[1]*100), fx$opponent[2],
              round(fx$oddsWin[2]*100), fx$opponent[3], round(fx$oddsWin[3]*100))),
    role_analysis = if (p$roleShift != "SAME")
        sprintf("ROLE SHIFT (%s): %s Applying xG×%.2f / xA×%.2f.", p$roleShift, p$roleShiftNote, rm[1], rm[2])
      else "Club role consistent with international deployment.",
    mispricing_signal = if (!is.na(p$mispricing_flag) && p$mispricing_flag == "UNDERRATED")
        sprintf("MODEL FLAGS UNDERPRICING: intl_premium = +%.2fσ.", p$intl_premium_score)
      else if (!is.na(p$mispricing_flag) && p$mispricing_flag == "OVERRATED")
        sprintf("MODEL FLAGS OVERPRICING: intl_premium = %.2fσ.", p$intl_premium_score)
      else NA_character_,
    risk_flags = na.omit(c(
      if (p$cardRisk == "high") "⚠ HIGH CARD RISK" else NA,
      if (p$startProb < 0.85) sprintf("⚠ START UNCERTAINTY: %d%%", round(p$startProb*100)) else NA,
      if (p$own > 40) "⚠ HIGH TEMPLATE RISK" else NA)),
    value_assessment = sprintf("$%sm → %.1f pts → %.2f pts/$m", p$price, p$pts_balanced, p$pts_balanced/p$price),
    captain_case = if (is_cap)
        sprintf("CAPTAIN PICK: highest ceiling at %.1f pts. Kickoff slot %d/3 — %s",
                p$pts_diff, p$captainSlot,
                if (p$captainSlot==3) "late game maximises switch optionality." else "consider switching if early games disappoint.")
      else NA_character_,
    x = p$x, y = p$y
  )
})

# ── SECTION D — pitch ggplot ──────────────────────────────────────────────────
POS_COL <- c(GK="#a855f7", DEF="#3b82f6", MID="#22c55e", FWD="#f97316")
pitch <- ggplot() +
  annotate("rect", xmin=0, xmax=100, ymin=0, ymax=100, fill="#0a3d1f", color="#1e6b3a") +
  annotate("rect", xmin=30, xmax=70, ymin=0, ymax=16, fill=NA, color="#2e7d4f") +    # pen box
  annotate("segment", x=0, xend=100, y=50, yend=50, color="#2e7d4f") +               # halfway
  geom_point(data=xi, aes(x=x, y=y, color=pos, size=pts_balanced)) +
  geom_text_repel(data=xi, aes(x=x, y=y, label=paste0(name, "\n", round(pts_balanced), "pts")),
                  color="white", size=3, segment.color="grey70") +
  scale_color_manual(values=POS_COL, guide="none") + scale_size(range=c(5,12), guide="none") +
  coord_fixed(ratio=1, xlim=c(0,100), ylim=c(0,100)) +
  labs(title="Econometrics Predicts the Starting XI — WC2026 Fantasy",
       subtitle=sprintf("Formation %s | Predicted total: %.0f pts | Budget context: balanced XI",
                        best$formation, best$tot)) +
  theme_void() + theme(plot.background=element_rect(fill="#060d1a", color=NA),
                       plot.title=element_text(color="white", face="bold", size=13),
                       plot.subtitle=element_text(color="#94a3b8", size=10))
ggsave(file.path(OUTPUT_DIR, "starting_xi_pitch.png"), pitch, width=8, height=10, dpi=100)
cat("SECTION D: pitch saved → outputs/starting_xi_pitch.png\n")

# ── SECTION E — summary HTML table (knitr::kable, no pandoc needed) ────────────
tbl <- xi %>% arrange(factor(pos, c("GK","DEF","MID","FWD")), desc(pts_balanced)) %>%
  transmute(Player=name, Team=team, Pos=pos, Price=price, xPts=round(pts_balanced,1),
            Value=round(pts_balanced/price,2), Role=roleShift,
            Mispricing=coalesce(mispricing_flag,"-"),
            Captain=ifelse(id==captain_id,"©",""))
writeLines(knitr::kable(tbl, format="html"), file.path(OUTPUT_DIR, "starting_xi_table.html"))

starting_xi <- list(formation = best$formation, total_pts = best$tot,
                    captain_id = captain_id, players = narr)
saveRDS(starting_xi, file.path(DATA_DIR, "starting_xi.rds"))
cat("SECTION B: narratives for", length(narr), "players saved\n")
cat("✓ 06_starting_xi.R complete\n")
