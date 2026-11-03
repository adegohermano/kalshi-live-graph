# Kalshi BTC 15-minute dashboard — v4 multi-opinion

This replaces the existing v3 `index.html`, `server.js`, and `package.json`. Node.js 20+ and Render Web Service compatible. **Alerts only; never places trades.**

## Opinions

- **Existing Lean:** the v3 weighted multi-factor heuristic.
- **OpenAI Analysis:** a separate paid Responses API model interprets a whitelist of current numeric market facts and returns UP/DOWN/WAIT with one sentence. It is not the live ChatGPT conversation. The model has no direct Kalshi connection; data is supplied by this server. Results are not calibrated probabilities.
- **Momentum Model:** 60-second and 180-second BTC momentum, EMA9/EMA21, RSI14; requires at least three agreeing votes.
- **Order Book Model:** near-best-bid YES/NO depth imbalance; requires >=30% imbalance and <=5¢ YES spread. Order book can be manipulated and does not reliably predict settlement.

All models show WAIT on insufficient or stale inputs. Opinions can be correlated. Agreement count is not a win probability.

## GitHub + Render deployment

1. Replace the three files at the root of your existing GitHub repo (`index.html`, `server.js`, `package.json`). Commit to the branch your Render service deploys.
2. Render → existing **Web Service** → Settings: Build Command `npm install`; Start Command `npm start`; runtime Node.js 20+.
3. Render → Web Service → Environment: add `OPENAI_API_KEY` as a **secret environment variable**. Create it at https://platform.openai.com/api-keys . Never paste it into GitHub, frontend HTML, screenshots, or this chat. ChatGPT subscription is separate from API billing.
4. Optional: `OPENAI_MODEL=gpt-6-luna` (default, subject to your API account's access), `AI_INTERVAL_MS=90000` (at least 60000), `AI_MAX_CALLS_PER_DAY=100`, `DISCORD_WEBHOOK_URL` (secret), `KALSHI_SERIES_TICKER=KXBTC15M`, `FRONTEND_ORIGIN=https://kalshi-live-graph-2.onrender.com`.
5. For persistent prediction tracking, attach a Render persistent disk (if supported by your plan) and set `DATA_DIR` to the mounted directory. Otherwise history is ephemeral across deploys/restarts.
6. Deploy latest commit. If your frontend is a **separate Static Site**, redeploy it too. In `index.html`, `API_BASE` currently points to `https://kalshi-live-graph.onrender.com` only when the frontend hostname is `kalshi-live-graph-2.onrender.com`; adjust that constant if your service names differ.
7. Test backend `/healthz`, `/api/config`, and `/api/snapshot`. `/api/config` exposes only whether the API key is configured, never the key. `/api/snapshot` includes `opinions`. Wait for candle and momentum history to warm up.

## Costs and reliability

The OpenAI analysis calls the Responses API on the server no more often than every 90 seconds by default (and at most 100 attempted calls per UTC day **per running instance**). API usage is billed separately. Set spending limits in your OpenAI API account. The per-instance cap resets on restart and is not a global billing guarantee. Use one Render instance to avoid duplicate calls and alerts. Disable AI by removing `OPENAI_API_KEY`.

The OpenAI output is requested as JSON and validated; errors fall back to WAIT. If the selected model is unavailable to your account, set `OPENAI_MODEL` to a model you can access. The OpenAI API may change; test with a live account. No credentials are ever returned to the browser.

BTC spot data comes from Coinbase, but the official Kalshi settlement source/rules may differ. Do not assume the Coinbase spot/strike comparison exactly matches the contract's settlement. These are **experimental heuristic opinions**, not investment advice, not independently calibrated forecasts, and not proof of profitability. The existing order book, charts, bankroll calculator, Discord alerts, and prediction tracking remain from v3.

## Validation

Run `npm install && npm start`. JavaScript syntax was checked, but external API integration and a Render deployment were **not** exercised in the build environment.
