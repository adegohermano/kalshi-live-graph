"use strict";

const express = require("express");

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const SERIES = process.env.KALSHI_SERIES_TICKER || "KXBTC15M";

const KALSHI_API =
  process.env.KALSHI_API_BASE ||
  "https://external-api.kalshi.com/trade-api/v2";

const COINBASE_API =
  process.env.COINBASE_API_BASE ||
  "https://api.exchange.coinbase.com/products/BTC-USD";

const DEFAULT_FRONTEND_ORIGIN =
  "https://kalshi-live-graph-2.onrender.com";

const MARKET_REFRESH_MS = 30_000;
const BTC_REFRESH_MS = 10_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MARKET_STALE_AFTER_MS = 90_000;
const BTC_STALE_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

function parseOrigins() {
  const configured =
    process.env.FRONTEND_ORIGINS ||
    process.env.FRONTEND_ORIGIN ||
    DEFAULT_FRONTEND_ORIGIN;

  return new Set(
    configured
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => {
        try {
          return new URL(value).origin;
        } catch {
          console.warn(`Ignoring invalid frontend origin: ${value}`);
          return null;
        }
      })
      .filter(Boolean)
  );
}

const ALLOWED_ORIGINS = parseOrigins();

let cachedMarket = null;
let cachedBtcPrice = null;

let marketUpdatedAt = null;
let btcUpdatedAt = null;
let lastMarketCheckAt = null;
let lastBtcCheckAt = null;

let lastMarketError = null;
let lastBtcError = null;

let marketFailures = 0;
let btcFailures = 0;

let marketTimer = null;
let btcTimer = null;
let server = null;
let shuttingDown = false;

app.disable("x-powered-by");
app.disable("etag");

app.use((req, res, next) => {
  const origin = req.get("Origin");

  res.set("Vary", "Origin");
  res.set("X-Content-Type-Options", "nosniff");

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function getRetryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);

  if (Number.isFinite(seconds)) {
    return Math.min(
      MAX_RETRY_AFTER_MS,
      Math.max(1_000, seconds * 1_000)
    );
  }

  const retryDate = Date.parse(header);

  if (Number.isFinite(retryDate)) {
    return Math.min(
      MAX_RETRY_AFTER_MS,
      Math.max(1_000, retryDate - Date.now())
    );
  }

  return null;
}

function getBackoffMs(failures, baseDelayMs, retryAfterMs = null) {
  const exponent = Math.min(Math.max(failures - 1, 0), 10);
  const exponential = Math.min(
    baseDelayMs * (2 ** exponent),
    MAX_BACKOFF_MS
  );

  const minimumDelay = Math.max(exponential, retryAfterMs || 0);
  const jitter = Math.floor(
    Math.random() * Math.min(10_000, minimumDelay * 0.2)
  );

  return minimumDelay + jitter;
}

async function fetchJSON(url, source) {
  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "btc-kalshi-dashboard/1.0"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new UpstreamError(
      `${source} network request failed: ${error.message}`
    );
  }

  if (response.status === 429) {
    const retryAfterMs = getRetryAfterMs(response);

    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore response-body cleanup errors.
      }
    }

    throw new UpstreamError(
      `${source} rate-limited the request (HTTP 429).`,
      { status: 429, retryAfterMs }
    );
  }

  if (!response.ok) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore response-body cleanup errors.
      }
    }

    throw new UpstreamError(
      `${source} request failed (HTTP ${response.status}).`,
      { status: response.status }
    );
  }

  try {
    return await response.json();
  } catch {
    throw new UpstreamError(`${source} returned invalid JSON.`);
  }
}

async function findCurrentMarket() {
  const url = new URL(`${KALSHI_API}/markets`);
  url.searchParams.set("series_ticker", SERIES);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "200");

  const data = await fetchJSON(url, "Kalshi");

  if (!data || !Array.isArray(data.markets)) {
    throw new UpstreamError("Kalshi returned an unexpected markets response.");
  }

  const now = Date.now();

  const markets = data.markets
    .filter(market => {
      const closeTime = Date.parse(market?.close_time || "");
      return Number.isFinite(closeTime) && closeTime > now;
    })
    .sort(
      (a, b) =>
        Date.parse(a.close_time) - Date.parse(b.close_time)
    );

  return markets[0] || null;
}

function scheduleMarketRefresh(delayMs) {
  if (shuttingDown) return;
  clearTimeout(marketTimer);
  marketTimer = setTimeout(refreshMarket, delayMs);
}

function scheduleBtcRefresh(delayMs) {
  if (shuttingDown) return;
  clearTimeout(btcTimer);
  btcTimer = setTimeout(refreshBtc, delayMs);
}

async function refreshMarket() {
  let nextDelayMs = MARKET_REFRESH_MS;
  lastMarketCheckAt = Date.now();

  try {
    const market = await findCurrentMarket();
    lastMarketCheckAt = Date.now();

    if (!market) {
      cachedMarket = null;
      marketUpdatedAt = null;
      lastMarketError = `No open market found for series ${SERIES}.`;
      marketFailures = 0;
      console.warn("Kalshi refresh:", lastMarketError);
    } else {
      cachedMarket = market;
      marketUpdatedAt = Date.now();
      lastMarketError = null;
      marketFailures = 0;
    }
  } catch (error) {
    lastMarketCheckAt = Date.now();
    marketFailures += 1;
    lastMarketError = error.message;
    nextDelayMs = getBackoffMs(
      marketFailures,
      MARKET_REFRESH_MS,
      error.retryAfterMs
    );

    console.error(
      `Kalshi refresh failed; retrying in ${Math.ceil(nextDelayMs / 1000)}s:`,
      error.message
    );
  } finally {
    scheduleMarketRefresh(nextDelayMs);
  }
}

async function refreshBtc() {
  let nextDelayMs = BTC_REFRESH_MS;
  lastBtcCheckAt = Date.now();

  try {
    const ticker = await fetchJSON(`${COINBASE_API}/ticker`, "Coinbase");
    const price = Number(ticker?.price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new UpstreamError("Coinbase returned an invalid BTC price.");
    }

    cachedBtcPrice = price;
    btcUpdatedAt = Date.now();
    lastBtcCheckAt = btcUpdatedAt;
    lastBtcError = null;
    btcFailures = 0;
  } catch (error) {
    lastBtcCheckAt = Date.now();
    btcFailures += 1;
    lastBtcError = error.message;
    nextDelayMs = getBackoffMs(
      btcFailures,
      BTC_REFRESH_MS,
      error.retryAfterMs
    );

    console.error(
      `Coinbase refresh failed; retrying in ${Math.ceil(nextDelayMs / 1000)}s:`,
      error.message
    );
  } finally {
    scheduleBtcRefresh(nextDelayMs);
  }
}

function makeSnapshot() {
  const now = Date.now();

  const marketAgeMs =
    marketUpdatedAt == null ? null : Math.max(0, now - marketUpdatedAt);

  const btcAgeMs =
    btcUpdatedAt == null ? null : Math.max(0, now - btcUpdatedAt);

  const closeTime = cachedMarket
    ? Date.parse(cachedMarket.close_time || "")
    : NaN;

  const marketExpired =
    !Number.isFinite(closeTime) || closeTime <= now;

  const marketStale =
    !cachedMarket ||
    marketAgeMs == null ||
    marketAgeMs > MARKET_STALE_AFTER_MS;

  const btcStale =
    cachedBtcPrice == null ||
    btcAgeMs == null ||
    btcAgeMs > BTC_STALE_AFTER_MS;

  return {
    snapshotVersion: 1,
    timestamp: now,
    seriesTicker: SERIES,

    market: cachedMarket,
    btcPrice: cachedBtcPrice,

    marketUpdatedAt,
    btcUpdatedAt,
    lastMarketCheckAt,
    lastBtcCheckAt,
    marketAgeMs,
    btcAgeMs,

    marketStale,
    btcStale,
    marketExpired,
    marketUsable:
      Boolean(cachedMarket) &&
      cachedBtcPrice != null &&
      !marketStale &&
      !btcStale &&
      !marketExpired,

    marketError: lastMarketError,
    btcError: lastBtcError
  };
}

app.get("/", (_req, res) => {
  res
    .set("Cache-Control", "no-store")
    .type("text")
    .send("Kalshi BTC relay is running.");
});

app.get("/healthz", (_req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    marketLoaded: Boolean(cachedMarket),
    btcLoaded: cachedBtcPrice != null,
    marketUpdatedAt,
    btcUpdatedAt,
    marketError: lastMarketError,
    btcError: lastBtcError
  });
});

app.get("/api/snapshot", (_req, res) => {
  res.set("Cache-Control", "no-store");

  const snapshot = makeSnapshot();

  if (!snapshot.market || snapshot.btcPrice == null) {
    return res.status(503).json({
      ...snapshot,
      error:
        lastMarketError ||
        lastBtcError ||
        "Market data is loading. Try again shortly."
    });
  }

  return res.json(snapshot);
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled server error:", error);
  res.status(500).json({ error: "Internal server error." });
});

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`${signal} received; shutting down.`);

  clearTimeout(marketTimer);
  clearTimeout(btcTimer);

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => process.exit(0));

  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Relay listening on port ${PORT}`);
  console.log(`Kalshi series: ${SERIES}`);
  console.log(`Allowed frontend origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
});

refreshMarket();
refreshBtc();
