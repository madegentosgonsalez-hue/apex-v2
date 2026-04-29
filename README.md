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

- Policy: `target_growth_v6`
- Live pairs: `EURUSD, USDCHF, GBPJPY, EURJPY, XAUUSD`
- Mode: paper trading by default
- Best 2-year research snapshot: `376` trades, `15.67` signals/month, `54.0%` win rate, `255.41R`, about `13.50%` simple monthly growth before real-world slippage/spread degradation.

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
