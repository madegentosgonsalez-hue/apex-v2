# APEX v3

`APEX v3` is the clean rebuild of the APEX trading system using the original blueprint strategy as the core and selected research learnings from `apex-v2` as optional overlays.

## What is included

- Blueprint-first signal engine in `backend/engines`
- Backtest engine with replay diagnostics in `backend/backtest.js`
- Optional policy overlays in `backend/overlays`
- Railway deployment files in `backend/railway.json` and `backend/nixpacks.toml`
- Rebuild notes in `docs/V3-REBUILD-PLAN.md`

## Current best research state

Best research snapshot so far:

- Strategy profile: `anchor_turbo`
- Policy: `quality_prune`
- Synthetic intermarket enabled
- Concurrent-trade research mode enabled

Research output lives outside the repo in the local Codex workspace and was used to rank configurations before pushing this snapshot.

## Run locally

From `backend`:

```powershell
npm install
npm start
```

## Backtest

From `backend`:

```powershell
npm run backtest
```

For custom research runs, use the local helper scripts in the Codex workspace.

## Environment

See `backend/.env.example` for required variables.
