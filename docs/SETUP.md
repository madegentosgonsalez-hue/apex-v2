# APEX SIGNAL SYSTEM — COMPLETE SETUP GUIDE
## From zero to live signals. Step by step.

---

## WHAT YOU NEED (all free or cheap)

| Service | Cost | Purpose |
|---------|------|---------|
| Node.js 18+ | Free | Run the backend |
| Supabase | Free | Database |
| Railway.app | $5/mo | Host the backend 24/7 |
| Vercel | Free | Host the dashboard |
| Taapi.io | Free | Market indicators (2 pairs) |
| Finnhub | Free | Economic calendar |
| Telegram | Free | Signal notifications |
| Anthropic API | ~$5/mo | AI signal validation |

**Total for 2 pairs: ~$10-23/month**

---

## STEP 1 — Install Node.js

Download from https://nodejs.org (version 18+)

```bash
node --version   # should show v18+
npm --version    # should show 9+
```

---

## STEP 2 — Set Up the Backend

```bash
# Navigate to backend folder
cd apex/backend

# Install dependencies
npm install

# Copy environment file
cp .env.example .env
```

Now open `.env` in a text editor and fill in your keys (steps below).

---

## STEP 3 — Get Your API Keys (one at a time)

### A. Anthropic API Key (AI brain)
1. Go to https://console.anthropic.com
2. Sign up / log in
3. Click "API Keys" in left sidebar
4. Click "Create Key"
5. Copy the key → paste into `.env` as `ANTHROPIC_API_KEY=sk-ant-...`

**Without this:** System runs in mock mode. Still works — just no real AI.

---

### B. Telegram Bot (notifications)
1. Open Telegram → search for `@BotFather`
2. Send `/newbot`
3. Choose a name: `APEX Signal Bot`
4. Choose a username: `apex_signals_yourname_bot`
5. Copy the token → paste as `TELEGRAM_BOT_TOKEN=...`
6. Create a new Telegram channel/group (or use your personal chat)
7. Add your bot to the channel as admin
8. Send a test message to the channel
9. Go to: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
10. Find `"chat":{"id":` — copy that number → paste as `TELEGRAM_CHAT_ID=...`

**Without this:** Signals print to console only.

---

### C. Taapi.io (market indicators)
1. Go to https://taapi.io
2. Sign up (free)
3. Go to "API" in dashboard
4. Copy your secret key → paste as `TAAPI_API_KEY=...`

**Without this:** System uses realistic mock data. Good for testing.

---

### D. Supabase (database)
1. Go to https://supabase.com
2. "New Project" → choose region nearest to you
3. Set a strong database password (save it)
4. Wait ~2 minutes for setup
5. Go to: Settings → Database → Connection string
6. Copy the URI format → paste as `DATABASE_URL=postgresql://...`
7. Go to: SQL Editor → New Query
8. Paste the entire contents of `db/schema.sql`
9. Click "Run"

**Without this:** System uses in-memory storage (data lost on restart).

---

### E. Finnhub (economic calendar)
1. Go to https://finnhub.io
2. Sign up (free)
3. Go to dashboard → copy API key
4. Paste as `FINNHUB_API_KEY=...`

**Without this:** Mock news calendar used (has major events pre-loaded).

---

### F. Webhook Secret
Make up any string. Example: `apex_secret_myname_2025`
Paste as `WEBHOOK_SECRET=apex_secret_myname_2025`
You'll use this same string in TradingView.

---

## STEP 4 — Test Locally

```bash
cd apex/backend
npm start
```

You should see:
```
╔═══════════════════════════════════════╗
║      APEX SIGNAL SYSTEM v1.0          ║
╚═══════════════════════════════════════╝

✅ APEX Server running on port 3001
   Database   : ✅ PostgreSQL (or ⚠️  Memory)
   AI         : ✅ Claude API (or ⚠️  Mock mode)
   Telegram   : ✅ Connected (or ⚠️  Not configured)
   Market Data: ✅ Live (or ⚠️  Mock data)
   Mode       : 📋 PAPER
```

Test the API:
```bash
# Health check
curl http://localhost:3001/health

# Get pairs
curl http://localhost:3001/api/pairs

# Manual scan trigger
curl -X POST http://localhost:3001/api/scan/EURUSD
```

---

## STEP 5 — Deploy to Railway.app (24/7 hosting)

1. Go to https://railway.app → Sign up with GitHub
2. "New Project" → "Deploy from GitHub repo"
3. Connect your repository (or upload the backend folder)
4. Set "Root Directory" to `apex/backend`
5. Railway auto-detects Node.js and runs `npm start`
6. Go to "Variables" tab → add all your `.env` values
7. Go to "Settings" → "Networking" → "Generate Domain"
8. Copy your Railway URL: `https://apex-xxx.railway.app`

**Your backend is now live 24/7.**

---

## STEP 6 — Set Up TradingView Pine Script

1. Open TradingView → open any chart (EURUSD, H4)
2. Click "Pine Editor" at the bottom
3. Paste the contents of `pine-scripts/apex-indicator.pine`
4. Click "Add to chart"
5. You'll see Order Blocks, FVGs, EMA 21/50, and the APEX table

### Set up webhook alerts:
1. Click the "Alert" button (clock icon) on any chart
2. Condition: "APEX Signal System" → "APEX BUY Signal"
3. Under "Notifications" → check "Webhook URL"
4. Paste: `https://your-railway-url.railway.app/webhook/tradingview`
5. In "Message" field, paste:
   ```json
   {"symbol":"{{ticker}}","timeframe":"{{interval}}","signal_type":"BUY","price":{{close}},"secret":"your_webhook_secret"}
   ```
6. Under "Additional Settings" → add header: `x-webhook-secret: your_webhook_secret`
7. Save alert
8. Repeat for SELL signal

---

## STEP 7 — Set Up Dashboard (Vercel)

1. Go to https://vercel.com → sign up with GitHub
2. "Import Project" → upload/connect the `apex` folder
3. Set "Root Directory" to `apex/frontend`
4. Add environment variable: `VITE_API_URL=https://your-railway-url.railway.app`
5. Deploy → you get a URL like `https://apex-signals.vercel.app`

---

## STEP 8 — Paper Trade First

The system starts in **PAPER MODE** (`PAPER_TRADE=true` in `.env`).

This means:
- All signals are sent
- No real trades executed
- Everything logged and tracked
- Win rates calculated

**Run paper trading for at least 2-4 weeks before considering live.**

---

## ACTIVATING MORE PAIRS

In the dashboard, simply toggle any pair on.
Or via API:
```bash
curl -X POST https://your-server.railway.app/api/pairs/GBPUSD/toggle \
  -H "Content-Type: application/json" \
  -d '{"active": true}'
```

Cost at 2 pairs: ~$23/month  
Cost at 10 pairs: ~$73/month  
Cost at 20 pairs: ~$97/month

---

## ACTIVATING WHATSAPP

When ready:
1. Go to https://twilio.com → sign up
2. Set up WhatsApp sandbox or business account
3. Add to `.env`:
   ```
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_WHATSAPP_FROM=+14155238886
   WHATSAPP_TO=+your_number
   ```
4. In `notifications/notifier.js`, uncomment the WhatsApp lines
5. Redeploy

---

## TROUBLESHOOTING

**Signals not arriving on Telegram?**
- Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct
- Verify bot is an admin in your channel
- Check Railway logs for errors

**AI always rejecting?**
- Check `ANTHROPIC_API_KEY` is set correctly
- Look for `[AI DRIFT]` warnings in logs
- In mock mode, AI always approves — set key to get real validation

**No market data?**
- Without `TAAPI_API_KEY`, system uses mock data
- Mock data is realistic but not real — set key for live signals

**Database not connecting?**
- Check `DATABASE_URL` format: `postgresql://postgres:password@host:5432/postgres`
- Make sure you ran the schema.sql in Supabase SQL editor
- System falls back to memory mode if DB fails

---

## COST SUMMARY

| Item | Monthly Cost |
|------|-------------|
| Railway.app | $5 |
| Anthropic API (2 pairs, ~3 signals/day) | ~$5-8 |
| Taapi.io (2 pairs, free tier) | $0 |
| Finnhub (free tier) | $0 |
| Supabase (free tier) | $0 |
| Vercel (free tier) | $0 |
| **TOTAL (2 pairs)** | **~$10-13/month** |

---

## THE RULES (NEVER BREAK THESE)

1. **Paper trade first** — minimum 2 weeks, ideally 1 month
2. **Never risk more than the tier allows** — Diamond: 2%, Gold: 1.5%, Silver: 1%
3. **If 3 losses in a day** — the system stops automatically. You stop too.
4. **Never fight the daily trend** — if Weekly and Daily disagree, there's no trade
5. **The AI is a judge, not a boss** — hard rules always override AI

---

*APEX Signal System v1.0 — Built for discipline, not gambling.*
