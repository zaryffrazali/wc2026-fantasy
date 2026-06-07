# ══════════════════════════════════════════════════════════════════════════════
# 00_setup.R — package management + path constants
# Sourced by every other script. Safe to run standalone to verify the install.
# ══════════════════════════════════════════════════════════════════════════════

# ── pacman bootstrap ──────────────────────────────────────────────────────────
if (!requireNamespace("pacman", quietly = TRUE)) {
  install.packages("pacman", repos = "https://cloud.r-project.org")
}

# CRAN packages. p_load installs-if-missing then loads. We wrap each in a try so a
# single failed compile does not abort the whole setup — failures are reported at
# the end and downstream scripts degrade gracefully.
cran_pkgs <- c(
  "tidyverse", "janitor", "lubridate",   # wrangling
  "lpSolve",                              # integer programming optimiser
  "lme4", "broom", "broom.mixed",         # regression
  "factoextra", "cluster", "NbClust",     # clustering
  "jsonlite",                             # JSON IO
  "ggplot2", "ggrepel",                   # viz
  "corrplot"                              # correlation
)

failed <- character(0)
for (pkg in cran_pkgs) {
  ok <- suppressWarnings(suppressMessages(
    tryCatch(pacman::p_load(char = pkg, character.only = TRUE), error = function(e) FALSE)
  ))
  if (isFALSE(ok) || !requireNamespace(pkg, quietly = TRUE)) failed <- c(failed, pkg)
}

# ── worldfootballR (GitHub) — OPTIONAL ────────────────────────────────────────
# FBref is unreachable from this environment (HTTP 403), so live pulls will fall
# back to seed data regardless. We still attempt the install but never make it
# fatal: the pipeline runs fully on seed data without this package.
HAS_WORLDFOOTBALLR <- requireNamespace("worldfootballR", quietly = TRUE)
if (!HAS_WORLDFOOTBALLR) {
  tryCatch({
    if (!requireNamespace("devtools", quietly = TRUE))
      install.packages("devtools", repos = "https://cloud.r-project.org")
    devtools::install_github("JaseZiv/worldfootballR", upgrade = "never", quiet = TRUE)
    HAS_WORLDFOOTBALLR <- requireNamespace("worldfootballR", quietly = TRUE)
  }, error = function(e) message("worldfootballR install skipped: ", conditionMessage(e)))
}

# ── Path constants (robust to running from project root or r-analytics/) ──────
.find_root <- function() {
  if (dir.exists("public/data")) return(normalizePath("."))
  if (dir.exists("../public/data")) return(normalizePath(".."))
  stop("Cannot locate project root (no public/data found from cwd: ", getwd(), ")")
}
PROJECT_ROOT    <- .find_root()
DATA_DIR        <- file.path(PROJECT_ROOT, "r-analytics", "data")
OUTPUT_DIR      <- file.path(PROJECT_ROOT, "r-analytics", "outputs")
PUBLIC_DATA_DIR <- file.path(PROJECT_ROOT, "public", "data")
dir.create(DATA_DIR,   showWarnings = FALSE, recursive = TRUE)
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)

# FBref reachability flag — scripts check this before attempting live pulls.
FBREF_AVAILABLE <- FALSE  # known-blocked here; flip to TRUE if network opens up

# ── Report ────────────────────────────────────────────────────────────────────
cat("\n── 00_setup.R ──\n")
cat("PROJECT_ROOT    :", PROJECT_ROOT, "\n")
cat("worldfootballR  :", if (HAS_WORLDFOOTBALLR) "loaded" else "absent (seed fallback)", "\n")
cat("FBREF_AVAILABLE :", FBREF_AVAILABLE, "\n")
if (length(failed)) {
  cat("⚠ FAILED CRAN packages:", paste(failed, collapse = ", "), "\n")
} else {
  cat("All CRAN packages available.\n")
}
cat("✓ 00_setup.R complete\n")
