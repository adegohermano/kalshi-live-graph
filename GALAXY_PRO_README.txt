GALAXY PRO — BTC / ETH / SOL

Replace both server.js and index.html in the same GitHub repository and commit. Render should redeploy. Keep package.json unchanged.

New: market quality ranking, volatility regime, entry quote quality, local paper-trading ledger ($25 initial), Kalshi settlement checking, BTC prediction statistics, feed health, customizable threshold/motion/refresh. Discord webhook notifications disabled; Support tab username remains.

IMPORTANT:
- Paper trades are saved ONLY in the current browser's localStorage. Clearing site data loses the ledger; they do not sync between devices.
- Paper entry uses the latest observed best ask and a manually supplied fee estimate, NOT a guaranteed fill. Liquidity and slippage are not modeled.
- Paper settlement only updates after Kalshi reports an official YES/NO result; missing results remain pending.
- Historical performance on the server currently tracks BTC only. ETH/SOL are NOT represented as having validated prediction histories.
- Scanner strength is heuristic agreement, not a probability of winning or expected value.
- Render ephemeral filesystem can lose server prediction history after restarts without persistent disk.
- KALSHI_ETH_SERIES_TICKER and KALSHI_SOL_SERIES_TICKER may require verification against live Kalshi listings.
- No automatic trades or Discord alerts.

Run node --check server.js; extract inline script and run node --check on it before deploying.
