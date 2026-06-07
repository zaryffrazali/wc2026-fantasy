# ══════════════════════════════════════════════════════════════════════════════
# 11_matchday_squads.R — group-stage squad PLAN by fixtures:
#   optimal 15 for MD1 (budget), then best ≤2 transfers for MD2, then MD3.
#   Per-matchday points use that matchday's real fixture odds. Knockouts ignored.
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")
library(tidyverse); library(lpSolve); library(jsonlite)
`%||%` <- function(a,b) if (is.null(a)||length(a)==0||is.na(a)) b else a

P <- fromJSON(file.path(PUBLIC_DATA_DIR, "players.json"))
ROLE_MULT <- list(SAME=c(1,1),DEF_to_ATT=c(1.40,1.60),ATT_to_DEF=c(0.60,0.70),
                  MID_to_ATT=c(1.25,1.20),MID_to_DEF=c(0.75,0.80),WING_to_STRIKER=c(1.30,0.80))

# ── per-matchday expected points (single match, minute-scaled, causal/3) ──────
md_points <- function(i, md) {
  fx <- P$fixtures[[i]]; if (is.null(fx) || nrow(fx) < md) return(0)
  f <- fx[md, ]; rm <- ROLE_MULT[[P$roleShift[i]]]; if (is.null(rm)) rm <- c(1,1)
  xG <- (P$xGp90[i]%||%0)*rm[1]*(1+(P$intl_premium_xG[i]%||%0)*0.3); xA <- (P$xAp90[i]%||%0)*rm[2]
  csP <- f$oddsWin*0.72 + f$oddsDraw*0.28; goalP <- f$oddsWin*1.4 + f$oddsDraw*0.5
  pos <- P$pos[i]
  returns <- if (pos=="GK") csP*5 + ((P$savesP90[i]%||%3.2)/3) - (1-csP)*0.8
    else if (pos=="DEF") csP*5 + xG*7*goalP + xA*3 - (1-csP)*0.5
    else if (pos=="MID") xG*6*goalP + xA*3 + csP + (xA*2.5/2) + 0.4
    else xG*5*goalP + xA*3 + (P$SoTp90[i]%||%0)/2
  if (isTRUE(P$penTaker[i]))    returns <- returns + 0.5
  if (isTRUE(P$fkTaker[i]))     returns <- returns + 0.4
  if (isTRUE(P$cornerTaker[i])) returns <- returns + 0.3
  returns <- returns - switch(P$cardRisk[i] %||% "low", high=0.4, medium=0.2, 0)
  mf <- (P$startProb[i]%||%0.85) * (P$minsIfStarted[i]%||%90) / 90
  (P$startProb[i]%||%0.85)*2 + returns*mf + 0.5*(P$causal_pts_adjustment[i]%||%0)/3
}
mdMat <- sapply(1:3, function(md) sapply(seq_len(nrow(P)), md_points, md = md))  # players × 3
colnames(mdMat) <- c("MD1","MD2","MD3")

# ── LP: best 15 for an objective, optional ≤2 changes vs a previous squad ──────
teams <- unique(P$team); pos <- P$pos
base_cons <- rbind(P$price, as.integer(pos=="GK"), as.integer(pos=="DEF"),
  as.integer(pos=="MID"), as.integer(pos=="FWD"),
  t(sapply(teams, function(tm) as.integer(P$team==tm))))
base_dir <- c("<=","=","=","=","=", rep("<=", length(teams)))
base_rhs <- c(100, 2, 5, 5, 3, rep(3, length(teams)))
solve_md <- function(obj, prev_ids = NULL, max_transfers = 2) {
  cons <- base_cons; dir <- base_dir; rhs <- base_rhs
  if (!is.null(prev_ids)) {                       # cap new players (≤ transfers)
    cons <- rbind(cons, as.integer(!(P$id %in% prev_ids))); dir <- c(dir, "<="); rhs <- c(rhs, max_transfers)
  }
  s <- lp("max", obj, cons, dir, rhs, all.bin = TRUE)
  P[s$solution > 0.5, ]
}
best_xi_pts <- function(sq, md) {                 # field best legal XI from the 15
  o <- sq[[paste0("md",md)]]
  pk <- function(k,n) head(sort(o[sq$pos==k], decreasing=TRUE), n)
  forms <- list(c(3,4,3),c(3,5,2),c(4,3,3),c(4,4,2),c(4,5,1),c(5,3,2))
  max(sapply(forms, function(f) sum(pk("GK",1), pk("DEF",f[1]), pk("MID",f[2]), pk("FWD",f[3]))))
}

P$md1 <- mdMat[,1]; P$md2 <- mdMat[,2]; P$md3 <- mdMat[,3]
sq1 <- solve_md(P$md1)
sq2 <- solve_md(P$md2, sq1$id, 2)
sq3 <- solve_md(P$md3, sq2$id, 2)

show <- function(sq, md, prev=NULL) {
  cat(sprintf("\n═══ MATCHDAY %d ═══  squad $%.1fm/100 · best-XI %.1f pts\n", md, sum(sq$price), best_xi_pts(sq, md)))
  if (!is.null(prev)) {
    out <- prev %>% filter(!(id %in% sq$id)); ins <- sq %>% filter(!(id %in% prev$id))
    if (nrow(ins)==0) cat("  transfers: none\n")
    else for (k in seq_len(nrow(ins))) cat(sprintf("  OUT %s ($%sm) → IN %s ($%sm, %s)\n",
      out$name[k], out$price[k], ins$name[k], ins$price[k], ins$team[k]))
  }
  sq %>% mutate(p=round(.data[[paste0("md",md)]],1), tier=ifelse(data_tier=="curated","✓","·")) %>%
    arrange(factor(pos,c("GK","DEF","MID","FWD")), desc(p)) %>%
    transmute(line=sprintf("  %s %-3s %-18s %-11s $%sm  %s", tier, pos, name, team, price, p)) %>% pull(line) %>% cat(sep="\n"); cat("\n")
}
show(sq1, 1)
show(sq2, 2, sq1)
show(sq3, 3, sq2)

plan <- list(MD1=sq1 %>% transmute(id,name,team,pos,price,pts=round(md1,1),data_tier),
             MD2=sq2 %>% transmute(id,name,team,pos,price,pts=round(md2,1),data_tier),
             MD3=sq3 %>% transmute(id,name,team,pos,price,pts=round(md3,1),data_tier),
             transfers=list(
               MD2=list(out=setdiff(sq1$id,sq2$id), `in`=setdiff(sq2$id,sq1$id)),
               MD3=list(out=setdiff(sq2$id,sq3$id), `in`=setdiff(sq3$id,sq2$id))))
saveRDS(plan, file.path(DATA_DIR, "matchday_plan.rds"))
write_json(plan, file.path(PUBLIC_DATA_DIR, "matchday_plan.json"), auto_unbox=TRUE, pretty=TRUE, na="null")
cat("\n✓ 11_matchday_squads.R complete\n")
