"use strict";

const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;
const SERIES = process.env.KALSHI_SERIES_TICKER || "KXBTC15M";

const KALSHI_API = "https://external-api.kalshi.com/trade-api/v2";
const COINBASE_API = "https://api.exchange.coinbase.com/products/BTC-USD";
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://kalshi-live-graph-2.onrender.com";

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

async function getJSON(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Upstream request failed (HTTP ${response.status})`);
  }

  return response.json();
}

async function findCurrentMarket() {
  const url = new URL(`${KALSHI_API}/markets`);
  url.searchParams.set("series_ticker", SERIES);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "200");

  const data = await getJSON(url);
  const now = Date.now();

  const markets = (data.markets || [])
    .filter(market => {
      const closeTime = Date.parse(market.close_time || "");
      return Number.isFinite(closeTime) && closeTime > now;
    })
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));

  return markets[0] || null;
}

app.get("/", (_req, res) => {
  res.type("text").send("Kalshi live-price relay is running.");
});

app.get("/api/snapshot", async (_req, res) => {
  try {
    const [market, ticker] = await Promise.all([
      findCurrentMarket(),
      getJSON(`${COINBASE_API}/ticker`)
    ]);

    if (!market) {
      return res.status(404).json({
        error: `No open market found for series ${SERIES}.`
      });
    }

    const btcPrice = Number(ticker.price);

    if (!Number.isFinite(btcPrice)) {
      throw new Error("Coinbase returned an invalid BTC price.");
    }

    res.set("Cache-Control", "no-store");
    res.json({
      timestamp: Date.now(),
      market,
      btcPrice
    });
  } catch (error) {
    console.error("Snapshot error:", error.message);
    res.status(502).json({ error: error.message || "Could not load market data." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Relay listening on port ${PORT}`);
});
