# ══════════════════════════════════════════════════════════════════════════════
# 05_captain_ev.R — captaincy expected value (points double for the captain)
# Captain EV blends ceiling (pts_diff), advancement longevity, and slot optionality.
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse)

os <- readRDS(file.path(DATA_DIR, "optimal_squads.rds"))
players <- os$all_players

captain_ev <- players %>% mutate(
  slot_mult   = recode(as.character(captainSlot), `3` = 1.15, `2` = 1.08, .default = 1.00),
  # Captain doubles points; EV weights ceiling heavily and discounts start/exit risk.
  captain_ev  = (pts_diff * 2) * startProb * (0.7 + 0.3 * advP/100) * slot_mult,
  captain_floor = pts_safe * 2 * startProb
) %>% arrange(desc(captain_ev))

cat("SECTION: Top 12 captain picks by EV\n")
captain_ev %>% select(name, team, pos, price, own, captainSlot, pts_diff,
                      captain_ev, captain_floor) %>%
  mutate(across(c(pts_diff, captain_ev, captain_floor), ~round(.,1))) %>% head(12) %>% print()

saveRDS(captain_ev %>% select(id, name, captain_ev, captain_floor, slot_mult),
        file.path(DATA_DIR, "captain_ev.rds"))
cat("✓ 05_captain_ev.R complete\n")
