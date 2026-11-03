"use strict";

const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;
const SERIES = process.env.KALSHI_SERIES_TICKER || "KXBTC15M";

const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const COINBASE_API = "https://api.exchange.coinbase.com/products/BTC-USD";
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://kalshi-live-graph-2.onrender.com";

const MARKET_REFRESH_MS = 15_000;
const BTC_REFRESH_MS = 10_000;
const REQUEST_TIMEOUT_MS = 12_000;

let cachedMarket = null;
let cachedBtcPrice = null;
let lastMarketError = null;
let lastBtcError = null;

let marketCooldownUntil = 0;
let btcCooldownUntil = 0;
let marketRefreshRunning = false;
let btcRefreshRunning = false;

app.disable("x-powered-by");

app.use((req, res, next) => {
  const origin = req.get("Origin");

  if (origin === FRONTEND_ORIGIN) {
    res.set("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
    res.set("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    return res.sendStatus(204);
  }

  next();
});

function retryDelayMs(response) {
  const header = response.headers.get("retry-after");

  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.max(1_000, seconds * 1_000);
    }

    const retryDate = Date.parse(header);
    if (Number.isFinite(retryDate)) {
      return Math.max(1_000, retryDate - Date.now());
    }
  }

  // If the upstream doesn't specify a retry time, wait 30 seconds.
  return 30_000;
}

async function fetchJSON(url, source) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (response.status === 429) {
    const delay = retryDelayMs(response);

    if (source === "Kalshi") {
      marketCooldownUntil = Date.now() + delay;
    } else {
      btcCooldownUntil = Date.now() + delay;
    }

    throw new Error(`${source} rate-limited the request (HTTP 429). Waiting before retrying.`);
  }

  if (!response.ok) {
    throw new Error(`${source} request failed (HTTP ${response.status}).`);
  }

  return response.json();
}

async function findCurrentMarket() {
  const url = new URL(`${KALSHI_API}/markets`);
  url.searchParams.set("series_ticker", SERIES);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "200");

  const data = await fetchJSON(url, "Kalshi");
  const now = Date.now();

  const markets = (data.markets || [])
    .filter(market => {
      const closeTime = Date.parse(market.close_time || "");
      return Number.isFinite(closeTime) && closeTime > now;
    })
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));

  return markets[0] || null;
}

async function refreshMarket() {
  if (marketRefreshRunning || Date.now() < marketCooldownUntil) return;

  marketRefreshRunning = true;

  try {
    const market = await findCurrentMarket();

    if (!market) {
      lastMarketError = `No open market found for series ${SERIES}.`;
    } else {
      cachedMarket = market;
      lastMarketError = null;
    }
  } catch (error) {
    lastMarketError = error.message;
    console.error("Kalshi refresh:", error.message);
  } finally {
    marketRefreshRunning = false;
  }
}

async function refreshBtc() {
  if (btcRefreshRunning || Date.now() < btcCooldownUntil) return;

  btcRefreshRunning = true;

  try {
    const ticker = await fetchJSON(`${COINBASE_API}/ticker`, "Coinbase");
    const price = Number(ticker.price);

    if (!Number.isFinite(price)) {
      throw new Error("Coinbase returned an invalid BTC price.");
    }

    cachedBtcPrice = price;
    lastBtcError = null;
  } catch (error) {
    lastBtcError = error.message;
    console.error("Coinbase refresh:", error.message);
  } finally {
    btcRefreshRunning = false;
  }
}

app.get("/", (_req, res) => {
  res.type("text").send("Kalshi live-price relay is running.");
});

app.get("/api/snapshot", (_req, res) => {
  res.set("Cache-Control", "no-store");

  if (!cachedMarket || cachedBtcPrice == null) {
    return res.status(503).json({
      error: lastMarketError || lastBtcError || "Market data is loading. Try again shortly."
    });
  }

  res.json({
    timestamp: Date.now(),
    market: cachedMarket,
    btcPrice: cachedBtcPrice
  });
});

// Do one initial refresh, then maintain shared server-side caches.
refreshMarket();
refreshBtc();

setInterval(refreshMarket, MARKET_REFRESH_MS);
setInterval(refreshBtc, BTC_REFRESH_MS);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Relay listening on port ${PORT}`);
});
