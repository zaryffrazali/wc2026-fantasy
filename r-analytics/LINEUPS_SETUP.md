# Predicted Lineups — setup

The LINEUPS tab reads `public/data/lineups.json`. That file is produced **server-side**
by `r-analytics/lineups_fetch.cjs` (Claude + web search). The browser never holds the
API key and never calls Anthropic directly (CORS + security).

## 1. Add the API key as a GitHub Actions secret
Repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `ANTHROPIC_API_KEY`
- Value: your `sk-ant-…` key (bare key only)

## 2. Run locally
```bash
ANTHROPIC_API_KEY=sk-ant-... npm run fetch-lineups
```
Loops all 48 teams (2s between calls, ~2–3 min), writes `public/data/lineups.json`.
Per-team failures are logged and stored as `null`; the run continues.

## 3. Manual refresh via GitHub Actions
Repo → **Actions → "Update Predicted Lineups" → Run workflow**.
Also runs automatically every 6 hours (`cron: 0 */6 * * *`) and commits the file if it changed.

## 4. Verify it worked
- `public/data/lineups.json` has `generated_at` (recent) and a `teams` object.
- Console ends with `✓ Lineups fetched: X/48 teams`.
- In the app, the LINEUPS tab shows ✓ on fetched teams; clicking one renders the XI
  and the "FANTASY PICKS FROM THIS XI" cross-reference against `players.json`.
- A team showing `confidence: "SEED_DATA"` is the placeholder seed (Spain) — it's replaced
  on the first real fetch.

## Model / tool versions
`claude-sonnet-4-6` + `web_search_20260209` (current). The old `claude-sonnet-4-20250514`
in the original spec is deprecated — do not use it.
