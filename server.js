const express = require("express");
const { createServer } = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = createServer(app);
const browserSockets = new WebSocket.Server({ server, path: "/stream" });

const PORT = process.env.PORT || 10000;
const SERIES = process.env.KALSHI_SERIES_TICKER || "KXBTC15M";
const API_KEY_ID = process.env.KALSHI_API_KEY_ID;
const PRIVATE_KEY = (process.env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const KALSHI_REST = "https://external-api.kalshi.com/trade-api/v2";
const KALSHI_WS = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const WS_PATH = "/trade-api/ws/v2";

let activeTicker = null;
let kalshiSocket = null;
let reconnectTimer = null;

app.get("/", (_req, res) => {
  res.send("Kalshi live-price relay is running.");
});

browserSockets.on("connection", client => {
  client.send(JSON.stringify({ type: "status", status: "connected" }));
});

function sendToBrowsers(data) {
  const message = JSON.stringify(data);

  for (const client of browserSockets.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function makeAuthHeaders() {
  const timestamp = Date.now().toString();
  const message = timestamp + "GET" + WS_PATH;

  const signature = crypto.sign("sha256", Buffer.from(message), {
    key: PRIVATE_KEY,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }).toString("base64");

  return {
    "KALSHI-ACCESS-KEY": API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature
  };
}

async function findCurrentMarket() {
  const url = new URL(KALSHI_REST + "/markets");
  url.searchParams.set("series_ticker", SERIES);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "200");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Market lookup failed: HTTP " + response.status);
  }

  const data = await response.json();
  const now = Date.now();

  return (data.markets || [])
    .filter(m => m.close_time && new Date(m.close_time).getTime() > now)
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))[0] || null;
}

function connectToKalshi(ticker) {
  if (!ticker || (ticker === activeTicker && kalshiSocket)) return;

  activeTicker = ticker;

  if (kalshiSocket) {
    const oldSocket = kalshiSocket;
    kalshiSocket = null;
    oldSocket.close();
  }

  const socket = new WebSocket(KALSHI_WS, {
    headers: makeAuthHeaders()
  });

  kalshiSocket = socket;

  socket.on("open", () => {
    if (kalshiSocket !== socket) return;

    socket.send(JSON.stringify({
      id: 1,
      cmd: "subscribe",
      params: {
        channels: ["ticker"],
        market_tickers: [ticker]
      }
    }));

    sendToBrowsers({ type: "market", market_ticker: ticker });
    console.log("Subscribed to Kalshi market:", ticker);
  });

  socket.on("message", raw => {
    if (kalshiSocket !== socket) return;

    try {
      const data = JSON.parse(raw.toString());
      if (data.type !== "ticker" || !data.msg) return;

      const m = data.msg;
      const bid = Number(m.yes_bid_dollars);
      const ask = Number(m.yes_ask_dollars);
      const last = Number(m.price_dollars);

      let yesMid = null;

      if (Number.isFinite(bid) && Number.isFinite(ask)) {
        yesMid = (bid + ask) / 2;
      } else if (Number.isFinite(last)) {
        yesMid = last;
      }

      if (yesMid === null) return;

      sendToBrowsers({
        type: "ticker",
        market_ticker: m.market_ticker,
        ts_ms: Number(m.ts_ms) || Date.now(),
        yes_mid: yesMid
      });
    } catch (err) {
      console.error("Could not process Kalshi message:", err.message);
    }
  });

  socket.on("error", err => {
    console.error("Kalshi WebSocket error:", err.message);
  });

  socket.on("close", () => {
    if (kalshiSocket !== socket) return;

    kalshiSocket = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (activeTicker) connectToKalshi(activeTicker);
    }, 3000);
  });
}

async function checkMarket() {
  try {
    const market = await findCurrentMarket();

    if (market && market.ticker !== activeTicker) {
      connectToKalshi(market.ticker);
    }
  } catch (err) {
    console.error("Market lookup error:", err.message);
  }
}

if (!API_KEY_ID || !PRIVATE_KEY) {
  console.error("Missing Kalshi API key environment variables.");
  process.exit(1);
}

checkMarket();
setInterval(checkMarket, 10000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("Relay listening on port " + PORT);
});
