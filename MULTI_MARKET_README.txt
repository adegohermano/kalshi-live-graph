KALSHI GALAXY — BTC / ETH / SOL UPDATE

Replace index.html and server.js in your GitHub repository with the files in this ZIP.
Render should redeploy automatically if connected to GitHub.

New read-only endpoints:
  /api/markets
  /api/snapshot/BTC
  /api/snapshot/ETH
  /api/snapshot/SOL
Existing /api/snapshot remains supported for older clients.

Coinbase market data: BTC-USD, ETH-USD, SOL-USD.
Kalshi series defaults:
  BTC KXBTC15M (existing)
  ETH KXETH15M (override with KALSHI_ETH_SERIES_TICKER)
  SOL KXSOL15M (override with KALSHI_SOL_SERIES_TICKER)

IMPORTANT: ETH/SOL series tickers have NOT been independently verified against the live Kalshi API. If Kalshi uses different series tickers, set the two Render environment variables above to the correct active 15-minute series. A market without an active contract or fresh quotes will show NO LIVE LEAN, not fabricated data.

The existing BTC Discord alert/prediction tracking pipeline is preserved. ETH and SOL are dashboard analysis only (no added Discord alerts or trade execution).
Directional strength is heuristic indicator agreement, not win probability or validated trading edge. Fees and settlement details must be verified on Kalshi.

Testing: node --check passes for server.js and extracted browser script. Live Coinbase/Kalshi feeds and Render deployment have not been verified in this environment.
