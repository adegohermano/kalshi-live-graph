KALSHI GALAXY PRO — ACCURACY LAB + PERFORMANCE UPDATE

INSTALL
1. Replace index.html and server.js in your GitHub repository.
2. Keep the existing package.json with express and npm start configuration.
3. Commit and deploy on Render; frontend and backend may be separate Render services.
4. Test /healthz, /api/snapshot/BTC, /api/snapshot/ETH, /api/snapshot/SOL, and /api/accuracy-lab/BTC.
5. In the frontend, open the Accuracy Lab tab for each coin.

WHAT'S NEW
- Historical nearest-neighbor pattern matching on complete Coinbase 1m candles.
- 1m/5m/15m momentum alignment.
- Time-to-expiry Gaussian-volatility baseline (UNCALIBRATED).
- Kalshi orderbook spread, visible top-five bid depth, and pressure.
- Volatility regime detection.
- Stale-feed, trend-conflict, wide-spread, and thin-book guardrails.
- Chronological 70/30 holdout backtest of 15-minute Coinbase spot direction.
- Illustrative price-vs-model edge, with a placeholder 2-cent fee (NOT a verified fee).
- Separate Accuracy Lab tab, visual polish, responsive layout, reduced-motion support,
  background polling throttling, resize throttling, and less chart work on other tabs.

CRITICAL LIMITATIONS
- The spot-direction backtest is NOT a backtest of Kalshi settlement outcomes.
- The model is NOT calibrated to actual Kalshi contract settlement probabilities.
- Neighbor samples and rolling backtest observations overlap; their counts are not
  independent samples. Never treat hit rates as guaranteed accuracy.
- For these reasons, Accuracy Lab deliberately shows WAIT / NO VERIFIED EDGE.
- A live positive-value recommendation requires real historical Kalshi settlement
  datasets, non-overlapping validation, verified fees, and probability calibration.
- Existing legacy pick panel remains unchanged; it has separate conservative gates.
- Coinbase candles may be limited/unavailable; the lab fails closed to WAIT.
- W/L prediction history requires persistent DATA_DIR storage on Render.
- ETH/SOL series ticker IDs should be checked against the live Kalshi API.
- No automatic trading. Discord alerts remain disabled.

VALIDATION
- node --check passed for backend and extracted frontend JavaScript.
- No external network/live Render end-to-end tests were performed here.
