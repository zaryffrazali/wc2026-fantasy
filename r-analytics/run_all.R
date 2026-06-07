# ══════════════════════════════════════════════════════════════════════════════
# run_all.R — execute the full pipeline in order, with timing + per-step tryCatch
# ══════════════════════════════════════════════════════════════════════════════
if (file.exists("r-analytics/00_setup.R")) source("r-analytics/00_setup.R") else
if (file.exists("00_setup.R")) source("00_setup.R") else stop("00_setup.R not found")

steps <- c("01_data_pull","10_form_tracker","02_role_regression","03_playstyle_clustering",
           "09_causal_analysis","04_lp_optimizer","05_captain_ev","06_starting_xi",
           "08_tier_list","07_export_json")  # 10 form after 01; 09 causal before 04
base <- if (file.exists("r-analytics/01_data_pull.R")) "r-analytics" else "."

t0 <- Sys.time(); results <- list()
for (s in steps) {
  st <- Sys.time()
  ok <- tryCatch({ source(file.path(base, paste0(s, ".R")), local = new.env()); TRUE },
                 error = function(e) { cat("\n✖ STEP FAILED:", s, "—", conditionMessage(e), "\n"); FALSE })
  dt <- round(as.numeric(difftime(Sys.time(), st, units = "secs")), 1)
  results[[s]] <- list(ok = ok, secs = dt)
  cat(sprintf("  ⏱ %s: %s (%.1fs)\n", s, if (ok) "OK" else "FAILED", dt))
}

cat("\n", strrep("═", 60), "\n  PIPELINE SUMMARY\n", strrep("═", 60), "\n", sep = "")
for (s in steps) cat(sprintf("  %-24s %s  %5.1fs\n", s,
                             if (results[[s]]$ok) "✓" else "✖", results[[s]]$secs))
cat(sprintf("  TOTAL: %.1fs\n", as.numeric(difftime(Sys.time(), t0, units = "secs"))))

if (all(sapply(results, function(r) r$ok))) {
  library(jsonlite)
  a <- fromJSON(file.path(PUBLIC_DATA_DIR, "analytics.json"))
  cat("\n  Starting XI formation:", a$starting_xi$formation, "| total",
      round(a$starting_xi$total_pts), "pts\n")
  cat("  Model summary: ", a$model_summary$n_underrated, "underrated,",
      a$model_summary$n_overrated, "overrated | top value:",
      a$model_summary$top_value_pick, "| top diff:", a$model_summary$top_differential, "\n")
}
cat("\nPipeline complete. analytics.json written to public/data/\n")
