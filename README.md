# Kalshi BTC 15-minute dashboard — advanced prediction engine v3

**Alerts only. No account credentials, order submission, or automatic betting.**

## Replace files on GitHub
Upload the three root files `index.html`, `server.js`, and `package.json` from this archive to your existing GitHub repository, replacing the old versions. Keep `.gitignore`. Commit to the branch connected to Render.

## Render deployment
1. Open Render → your existing **Web Service** (Node backend) → **Manual Deploy → Deploy latest commit**. With auto-deploy enabled, the commit may deploy automatically.
2. Build command: `npm install` (or `npm ci` if you have a current package-lock.json). Start command: `npm start`. Node 20+.
3. The Node service serves both the dashboard at `/` and API at `/api/snapshot`. Open `/healthz` to see whether feeds loaded; `/api/predictions` shows history. Initial indicator warm-up may take 20–30 minutes because EMA21 uses minute candles and 3-minute trend requires collected spot history.
4. If using a separate Render Static Site, deploy the updated `index.html` there too. The file currently has `API_BASE = "https://kalshi-live-graph.onrender.com"`; change it if your backend hostname differs. If your frontend is separate, set `FRONTEND_ORIGINS` on the backend to its exact HTTPS origin.
5. Optional backend environment variables: `KALSHI_SERIES_TICKER=KXBTC15M`, `DISCORD_WEBHOOK_URL` (private Discord webhook), `DATA_DIR=/var/data` (only if you mounted a persistent disk there), `FRONTEND_ORIGINS` (comma-separated HTTPS origins). Render supplies `PORT`. Never commit webhook secrets.
6. On a sleeping Render instance, data collection and alerts stop while asleep. A persistent disk is needed for prediction history to survive restarts/deploys.

## What changed in v3
- A stricter experimental multi-factor signal combines 60/180-second momentum, strike distance normalized by estimated remaining volatility, EMA9/EMA21, RSI14, and near-best order-book pressure.
- Signal agreement is a **heuristic indicator score**, **not** a win probability. The dashboard deliberately reports `probability: null` and `edge: null`: there is no defensible calibrated model yet.
- WAIT is mandatory when data are stale, indicators haven't warmed up, the book is wide, expiry is too near, BTC is too close to the strike, or signals conflict. The model avoids alerts on extremely expensive contracts but does not prove value.
- Signals include indicator diagnostics and record the observed entry ask. Historical signals settle using Kalshi's published yes/no result when available.
- The original order book, candlestick chart, Discord alerts, prediction tracking, and $25 hypothetical bankroll calculator remain.

## Important caveats
- This uses **REST polling**, not tick-level WebSockets; spot refresh is approximately 5 seconds, Kalshi market/book 10 seconds, candles 60 seconds, subject to delays/rate limits.
- Coinbase BTC-USD is not guaranteed to be the official settlement index for a Kalshi market. Validate the **specific contract terms, strike field, settlement source, and YES/NO direction** before trusting signals. The generic strike reader assumes an above/below binary contract; do not use for range contracts.
- RSI/EMA are calculated from available Coinbase minute candles, which can have gaps. Volatility is estimated from recent spot returns, not a guaranteed future range.
- Recorded hit rate is descriptive, may include correlated alerts, and is **not** probability calibration, a forward backtest, or evidence of profitability. Proper calibration requires independent, held-out historical contracts, explicit fee/execution assumptions, and out-of-sample testing.
- $25 calculator is hypothetical and fee input defaults to zero. Actual Kalshi fees, depth, and fills may differ.
- No real-money trades are placed.
