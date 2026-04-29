# APEX v3

APEX v3 is a forex/gold signal system rebuilt around the original blueprint strategy, with selected APEX V2 research overlays used only where the data supported them.

## Features

- Brain1 signal engine with multi-timeframe bias, confluence, session timing, and H4 close discipline.
- Brain2/Brain3 guardian and exit modules for active signal monitoring.
- Claude AI validation layer for signal review when `ANTHROPIC_API_KEY` is configured.
- Live dashboard served by the backend at `/`.
- Telegram alerts for full signals, ready alerts, and demo connectivity checks.
- Real market data adapters for Twelve Data, Taapi, and Polygon/Massive.
- Railway-ready root deployment config.

## Current Live Profile

- Policy: `audit_focus_v5`
- Live pairs: `EURUSD, USDCHF, GBPJPY, EURJPY, XAUUSD`
- Mode: paper trading by default
- Best current research snapshot after the April 2026 audit: `174` raw trades, `7.24` signals/month, `70.1%` win rate, `194.84R`. With real tier risk, 5 max open trades, 5 max entries per pair, and 0.15R execution drag, the portfolio simulation ended around `+98%` over 2 years. This is safer than the older high-volume profile, but it does not honestly meet a 10-15% monthly target.

## Setup

```powershell
npm run install:all
Copy-Item backend\.env.example backend\.env
```

Fill `backend\.env` with:

- `ANTHROPIC_API_KEY`
- `TWELVE_DATA_API_KEY`
- `TAAPI_API_KEY`
- `POLYGON_API_KEY` optional backup
- `FINNHUB_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` or `TELEGRAM_GROUP_ID`
- `DATABASE_URL` optional but recommended for persistent history

Telegram note: the bot must be started in DM or added to the target group/channel before alerts can send. If `/api/telegram/test` returns `chat not found`, the token is valid but the chat ID is wrong or the bot is not in that chat.

## Run Locally

```powershell
npm run build
npm start
```

Open:

- Dashboard: `http://localhost:3001/`
- Health: `http://localhost:3001/health`
- Status: `http://localhost:3001/api/status`

## Live Checks

```powershell
Invoke-RestMethod http://localhost:3001/api/market/EURUSD
Invoke-RestMethod -Method Post http://localhost:3001/api/telegram/test -ContentType 'application/json' -Body '{"symbol":"EURUSD"}'
Invoke-RestMethod -Method Post http://localhost:3001/api/pipeline/EURJPY
```

## Railway

Deploy from the repo root. Railway should use:

- Build command from `nixpacks.toml`
- Start command: `node backend/server.js`
- Health path: `/health`

Set the same environment variables in Railway as in `backend\.env`. Keep `PAPER_TRADE=true` for demo testing.
