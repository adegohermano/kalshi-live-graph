"use strict";
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const app = express();
const PORT = Number(process.env.PORT) || 10000;
const SERIES = process.env.KALSHI_SERIES_TICKER || "KXBTC15M";
const KALSHI = process.env.KALSHI_API_BASE || "https://external-api.kalshi.com/trade-api/v2";
const COINBASE = process.env.COINBASE_API_BASE || "https://api.exchange.coinbase.com/products/BTC-USD";
const ORIGINS = new Set((process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || "https://kalshi-live-graph-2.onrender.com").split(",").map(s => s.trim()).filter(Boolean));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "predictions.json");
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";
const BTC_INTERVAL = 5000, MARKET_INTERVAL = 10000, CANDLES_INTERVAL = 60000;
const FRESH_BTC = 20000, FRESH_MARKET = 35000;
const state = {btcPrice:null,btcUpdatedAt:0,market:null,marketUpdatedAt:0,orderbook:null,bookUpdatedAt:0,candles:[],candlesUpdatedAt:0,btcHistory:[],yesHistory:[],errors:{},signals:[],predictions:[],lastAlertKey:"",marketTicker:null};
let stopped = false;
app.disable("x-powered-by");
app.use((_req,res,next)=>{res.set("Referrer-Policy","no-referrer");res.set("X-Frame-Options","DENY");res.set("Cache-Control","no-store");next();});
app.use((req,res,next)=>{ const origin=req.get("origin");res.set("Vary","Origin");res.set("X-Content-Type-Options","nosniff");if(origin && ORIGINS.has(origin)){res.set("Access-Control-Allow-Origin",origin);res.set("Access-Control-Allow-Methods","GET,OPTIONS");res.set("Access-Control-Allow-Headers","Content-Type");}if(req.method==="OPTIONS")return res.sendStatus(204);next();});
app.use("/data", (_req,res)=>res.status(404).end());
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/index.html", (_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
function numeric(x){if(x===null||x===undefined||x==="")return null;const n=Number(x);return Number.isFinite(n)?n:null;}
function first(o,keys){for(const k of keys){const n=numeric(o?.[k]);if(n!==null)return n;}return null;}
function quote(m,side,kind){const dollars=first(m,[`${side}_${kind}_dollars`]);return dollars!==null?dollars:(()=>{const cents=first(m,[`${side}_${kind}`]);return cents===null?null:cents/100;})();}
function strikeOf(m){return first(m,["floor_strike","strike_price","strike","custom_strike","cap_strike"]);}
function timeNow(){return Date.now();}
function pushHistory(arr,value,ts,windowMs=3600000){if(value===null)return;arr.push({t:ts,value});while(arr.length && (arr[0].t<ts-windowMs||arr.length>1500))arr.shift();}
function trend(history,now,ms){const latest=history.at(-1);const older=[...history].reverse().find(p=>p.t<=now-ms && p.t>=now-ms-20000);return latest&&older&&older.value>0?(latest.value/older.value-1)*10000:null;}
function volatility(history){const h=history.slice(-60);if(h.length<12)return null;const returns=[];for(let i=1;i<h.length;i++)if(h[i-1].value>0)returns.push(Math.log(h[i].value/h[i-1].value));if(!returns.length)return null;const mean=returns.reduce((a,b)=>a+b,0)/returns.length;return Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length)*10000;}
function parseBook(data){const raw=data?.orderbook_fp;if(!raw)return null;const levels=(side)=>Array.isArray(raw[side])?raw[side].map(row=>({price:numeric(row?.[0]),size:numeric(row?.[1])})).filter(x=>x.price!==null&&x.price>=0&&x.price<=1&&x.size!==null&&x.size>=0).sort((a,b)=>b.price-a.price).slice(0,12):[];const yes=levels("yes_dollars"),no=levels("no_dollars");const yesBid=yes[0]?.price??null,noBid=no[0]?.price??null;return {yes,no,yesBid,noBid,yesAsk:noBid===null?null:1-noBid,noAsk:yesBid===null?null:1-yesBid};}
async function getJSON(url){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"btc-kalshi-dashboard/3.0"},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);return r.json();}
function safeTicker(t){return /^[A-Za-z0-9_-]{3,120}$/.test(t||"")?t:null;}
async function refreshBTC(){const data=await getJSON(`${COINBASE}/ticker`);const n=numeric(data?.price);if(n===null||n<=0)throw Error("Invalid Coinbase price");state.btcPrice=n;state.btcUpdatedAt=timeNow();pushHistory(state.btcHistory,n,state.btcUpdatedAt);}
async function refreshMarket(){const url=new URL(`${KALSHI}/markets`);url.searchParams.set("series_ticker",SERIES);url.searchParams.set("status","open");url.searchParams.set("limit","200");const data=await getJSON(url);if(!Array.isArray(data.markets))throw Error("Unexpected Kalshi markets response");const now=timeNow();const candidates=data.markets.filter(m=>safeTicker(m.ticker)&&Date.parse(m.close_time)>now&&Date.parse(m.open_time||0)<=now).sort((a,b)=>Date.parse(a.close_time)-Date.parse(b.close_time));const next=candidates[0]||null;if(next?.ticker!==state.marketTicker){state.marketTicker=next?.ticker||null;state.orderbook=null;state.bookUpdatedAt=0;state.yesHistory=[];state.lastAlertKey="";}state.market=next;state.marketUpdatedAt=now;if(next){const mid=first(next,["yes_bid_dollars"]);if(mid!==null)pushHistory(state.yesHistory,mid,now);}}
async function refreshBook(){const ticker=safeTicker(state.market?.ticker);if(!ticker){state.orderbook=null;return;}const data=await getJSON(`${KALSHI}/markets/${encodeURIComponent(ticker)}/orderbook`);if(state.market?.ticker!==ticker)return;const book=parseBook(data);if(!book)throw Error("Order book missing fixed-point bids");state.orderbook=book;state.bookUpdatedAt=timeNow();const mid=book.yesBid!==null&&book.yesAsk!==null?(book.yesBid+book.yesAsk)/2:null;pushHistory(state.yesHistory,mid,state.bookUpdatedAt);}
async function refreshCandles(){const end=Math.floor(timeNow()/1000),start=end-3600;const u=new URL(`${COINBASE}/candles`);u.searchParams.set("granularity","60");u.searchParams.set("start",new Date(start*1000).toISOString());u.searchParams.set("end",new Date(end*1000).toISOString());const rows=await getJSON(u);if(!Array.isArray(rows))throw Error("Coinbase candles unavailable");state.candles=rows.filter(r=>Array.isArray(r)&&r.length>=6).map(r=>({t:r[0]*1000,low:numeric(r[1]),high:numeric(r[2]),open:numeric(r[3]),close:numeric(r[4]),volume:numeric(r[5])})).filter(r=>r.t&&[r.low,r.high,r.open,r.close].every(x=>x!==null)).sort((a,b)=>a.t-b.t);state.candlesUpdatedAt=timeNow();}
function snapshot(){const now=timeNow(),m=state.market,b=state.orderbook;const marketAgeMs=state.marketUpdatedAt?now-state.marketUpdatedAt:null,btcAgeMs=state.btcUpdatedAt?now-state.btcUpdatedAt:null,bookAgeMs=state.bookUpdatedAt?now-state.bookUpdatedAt:null;const marketStale=marketAgeMs===null||marketAgeMs>FRESH_MARKET||!m;const btcStale=btcAgeMs===null||btcAgeMs>FRESH_BTC;const bookStale=bookAgeMs===null||bookAgeMs>FRESH_MARKET;return {snapshotVersion:3,timestamp:now,seriesTicker:SERIES,market:m,btcPrice:state.btcPrice,marketUpdatedAt:state.marketUpdatedAt||null,btcUpdatedAt:state.btcUpdatedAt||null,marketAgeMs,btcAgeMs,marketStale,btcStale,bookStale,bookAgeMs,marketExpired:!m||Date.parse(m.close_time)<=now,marketUsable:!marketStale&&!btcStale&&!!m&&Date.parse(m.close_time)>now,marketError:state.errors.market||null,btcError:state.errors.btc||null,bookError:state.errors.book||null,orderbook:b,btcHistory:state.btcHistory.slice(-750),yesHistory:state.yesHistory.slice(-750),candles:state.candles.slice(-60),candlesUpdatedAt:state.candlesUpdatedAt||null,signal:calculateSignal(now),directionalLean:calculateDirectionalLean(now)};}
// All signal scores are heuristic agreement scores, NEVER calibrated probabilities.
// Calibration requires independent historical outcomes and held-out validation.
function ema(values,period){
  if(values.length<period)return null;
  const k=2/(period+1);let value=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(const price of values.slice(period))value=price*k+value*(1-k);
  return value;
}
function rsi(values,period=14){
  if(values.length<period+1)return null;
  const recent=values.slice(-(period+1));let gain=0,loss=0;
  for(let i=1;i<recent.length;i++){const diff=recent[i]-recent[i-1];gain+=Math.max(diff,0);loss+=Math.max(-diff,0);}
  if(gain===0&&loss===0)return 50;
  if(loss===0)return 100;
  return 100-100/(1+gain/loss);
}
function bookPressure(book){
  if(!book?.yes?.length||!book?.no?.length)return null;
  // Compare contracts near best bids; only a weak signal, not directional probability.
  const yesBest=book.yes[0].price,noBest=book.no[0].price;
  const y=book.yes.filter(x=>yesBest-x.price<=0.05).reduce((n,x)=>n+x.size,0);
  const n=book.no.filter(x=>noBest-x.price<=0.05).reduce((n,x)=>n+x.size,0);
  return y+n>0?(y-n)/(y+n):null;
}
function realizedBpsPerSqrtSecond(history,now){
  const points=history.filter(x=>x.t>=now-300000&&x.t<=now);
  if(points.length<24||points.at(-1).t-points[0].t<120000)return null;
  let variance=0,elapsed=0;
  for(let i=1;i<points.length;i++){
    const dt=(points[i].t-points[i-1].t)/1000;
    if(dt<=0||dt>30)continue;
    const ret=Math.log(points[i].value/points[i-1].value)*10000;
    variance+=ret*ret;elapsed+=dt;
  }
  return elapsed>=90?Math.sqrt(variance/elapsed):null;
}
function calculateSignal(now){
  const m=state.market,b=state.orderbook,spot=state.btcPrice,strike=strikeOf(m);
  const secondsLeft=m?(Date.parse(m.close_time)-now)/1000:null;
  const momentum60=trend(state.btcHistory,now,60000);
  const momentum180=trend(state.btcHistory,now,180000);
  const volatilityBps=volatility(state.btcHistory);
  const sigmaPerSqrtSecond=realizedBpsPerSqrtSecond(state.btcHistory,now);
  const distanceBps=strike&&spot?(spot/strike-1)*10000:null;
  const yesBid=b?.yesBid??null,yesAsk=b?.yesAsk??null;
  const noBid=b?.noBid??null,noAsk=b?.noAsk??null;
  const spread=yesBid!==null&&yesAsk!==null?yesAsk-yesBid:null;
  const candles=state.candles.filter(c=>c.t<=now&&c.t>=now-3600000);
  const closes=candles.map(c=>c.close);
  const ema9=ema(closes,9),ema21=ema(closes,21),rsi14=rsi(closes);
  const pressure=bookPressure(b);
  const expectedMoveBps=sigmaPerSqrtSecond!==null&&secondsLeft>0?sigmaPerSqrtSecond*Math.sqrt(secondsLeft):null;
  const normalizedDistance=expectedMoveBps>0&&distanceBps!==null?distanceBps/expectedMoveBps:null;
  const reasons=[];
  if(!m||!spot||!strike||strike<=0)reasons.push("Missing market, spot or structured strike");
  if(m?.market_type&&m.market_type!=="binary")reasons.push("Unsupported market type");
  if(!state.btcUpdatedAt||now-state.btcUpdatedAt>FRESH_BTC||!state.marketUpdatedAt||now-state.marketUpdatedAt>FRESH_MARKET)reasons.push("BTC or market data stale");
  if(!b||now-state.bookUpdatedAt>FRESH_MARKET)reasons.push("Order book stale or unavailable");
  if(secondsLeft===null||secondsLeft<=120||secondsLeft>900)reasons.push("Outside supported 2–15 minute window");
  if([momentum60,momentum180,sigmaPerSqrtSecond,normalizedDistance,ema9,ema21,rsi14,pressure].some(x=>x===null))reasons.push("Building sufficient indicator history");
  if(spread===null||spread<0||spread>0.05||yesAsk===null||noAsk===null)reasons.push("Missing executable asks or spread above 5¢");
  if(normalizedDistance!==null&&Math.abs(normalizedDistance)<0.35)reasons.push("Too close to strike relative to estimated remaining volatility");
  // No quote-based win-probability: market prices are not ground-truth probabilities.
  // Both sides must have valid executable asks; do not alert at extreme prices.
  const scores={UP:0,DOWN:0};const votes=[];
  function vote(label,value,weight){votes.push({label,value,weight});if(value>0)scores.UP+=weight;else if(value<0)scores.DOWN+=weight;}
  if(distanceBps!==null)vote("Strike distance",Math.sign(distanceBps),3);
  if(momentum60!==null)vote("60s momentum",Math.abs(momentum60)<1?0:Math.sign(momentum60),2);
  if(momentum180!==null)vote("180s momentum",Math.abs(momentum180)<2?0:Math.sign(momentum180),2);
  if(ema9!==null&&ema21!==null)vote("EMA 9/21",Math.sign(ema9-ema21),1);
  if(rsi14!==null)vote("RSI 14",rsi14>55?1:rsi14<45?-1:0,1);
  if(pressure!==null)vote("Order-book pressure",pressure>0.2?1:pressure< -0.2?-1:0,1);
  const totalWeight=10;const leader=scores.UP>scores.DOWN?"UP":"DOWN";
  const strength=Math.round(100*scores[leader]/totalWeight);
  const opposing=scores[leader==="UP"?"DOWN":"UP"];
  let direction="WAIT";
  if(!reasons.length){
    if(strength<80||opposing>1)reasons.push("Independent indicators do not agree strongly enough");
    else if(leader==="UP"&&yesAsk>=0.90)reasons.push("YES ask is too expensive for an uncalibrated signal");
    else if(leader==="DOWN"&&noAsk>=0.90)reasons.push("NO ask is too expensive for an uncalibrated signal");
    else direction=leader;
  }
  return {direction,strength,reasons,momentum60,momentum180,volatilityBps,
    sigmaPerSqrtSecond,expectedMoveBps,normalizedDistance,distanceBps,
    ema9,ema21,rsi14,bookPressure:pressure,votes,scores,spread,secondsLeft,
    yesBid,yesAsk,noBid,noAsk,model:"multi-factor-heuristic-v3",probability:null,
    probabilityStatus:"Not calibrated; insufficient independent holdout validation",
    edge:null,edgeStatus:"Unavailable without a validated probability model and actual fees"};
}
// Directional research lean: independent of conservative WAIT, never an order instruction.
// Scores represent weighted indicator votes, not empirical win probabilities.
function calculateDirectionalLean(now=Date.now()) {
  const base=calculateSignal(now), m=state.market;
  const fresh=!!m && !!state.btcPrice && !!state.btcUpdatedAt && now-state.btcUpdatedAt<=FRESH_BTC &&
    !!state.marketUpdatedAt && now-state.marketUpdatedAt<=FRESH_MARKET &&
    Date.parse(m.close_time)>now && base.secondsLeft>0 && base.secondsLeft<=900;
  if(!fresh)return {direction:null,action:"DATA UNAVAILABLE",strength:null,risk:"Unknown",reasons:["Fresh BTC and open Kalshi market data required"],tradable:false,model:"directional-v1"};
  const factors=[];
  const add=(label,value,weight,explanation)=>{if(value===null||!Number.isFinite(value))return;factors.push({label,side:value>0?"UP":value<0?"DOWN":"NEUTRAL",weight,explanation});};
  if(base.distanceBps!==null)add("Strike position",Math.abs(base.distanceBps)<1?0:base.distanceBps,3,`BTC ${base.distanceBps>=0?"above":"below"} strike by ${Math.abs(base.distanceBps).toFixed(1)} bps`);
  if(base.momentum60!==null)add("1m momentum",Math.abs(base.momentum60)<1?0:base.momentum60,2,`1m momentum ${base.momentum60.toFixed(1)} bps`);
  if(base.momentum180!==null)add("3m momentum",Math.abs(base.momentum180)<2?0:base.momentum180,2,`3m momentum ${base.momentum180.toFixed(1)} bps`);
  if(base.ema9!==null&&base.ema21!==null)add("EMA 9/21",base.ema9-base.ema21,1,`EMA 9 ${base.ema9>=base.ema21?"above":"below"} EMA 21`);
  if(base.rsi14!==null)add("RSI 14",base.rsi14>55?1:base.rsi14<45?-1:0,1,`RSI ${base.rsi14.toFixed(0)}`);
  if(base.bookPressure!==null && now-state.bookUpdatedAt<=FRESH_MARKET)add("Order book",Math.abs(base.bookPressure)<0.2?0:base.bookPressure,1,`Order-book imbalance ${(base.bookPressure*100).toFixed(0)}%`);
  const up=factors.filter(f=>f.side==="UP").reduce((n,f)=>n+f.weight,0);
  const down=factors.filter(f=>f.side==="DOWN").reduce((n,f)=>n+f.weight,0);
  const total=factors.reduce((n,f)=>n+f.weight,0);
  if(!total||(!up&&!down))return {direction:null,action:"NO DIRECTION",strength:0,risk:"High",reasons:["Indicators are neutral or not ready"],factors,tradable:false,model:"directional-v1"};
  const direction=up>=down?"UP":"DOWN";
  const strength=Math.round(100*Math.max(up,down)/total);
  const reasons=factors.filter(f=>f.side===direction).sort((a,b)=>b.weight-a.weight).slice(0,3).map(f=>f.explanation);
  const risks=[];
  if(up&&down)risks.push("Conflicting indicators");
  if(base.secondsLeft<=120)risks.push("Under 2 minutes to expiry");
  if(base.normalizedDistance!==null&&Math.abs(base.normalizedDistance)<0.35)risks.push("Near strike relative to volatility");
  if(!state.orderbook||now-state.bookUpdatedAt>FRESH_MARKET)risks.push("Order book unavailable");
  if(base.spread===null||base.spread>0.05)risks.push("Wide or unavailable spread");
  const risk=risks.length>=2||strength<55?"High":risks.length||strength<75?"Elevated":"Moderate";
  // An UP/DOWN lean is always shown when directional evidence exists, even when trading is unwise.
  return {direction,action:`LEAN ${direction}`,strength,risk,reasons:reasons.length?reasons:["Limited directional evidence"],warnings:risks,
    factors,upScore:up,downScore:down,tradable:false,model:"directional-v1",
    note:"Directional research only. Not a trade recommendation, win probability, or verified edge."};
}

// Three distinct perspectives: legacy multi-factor lean, momentum-only, and book-only.
// All directions are heuristics; none is a validated probability.
function independentOpinions(now=Date.now()){
  const base=calculateSignal(now), m=state.market, b=state.orderbook;
  const safe=!!m && base.secondsLeft>120 && base.secondsLeft<=900 &&
    !!state.btcUpdatedAt && now-state.btcUpdatedAt<=FRESH_BTC &&
    !!state.marketUpdatedAt && now-state.marketUpdatedAt<=FRESH_MARKET;
  const momentumInputs=[base.momentum60,base.momentum180,base.ema9,base.ema21,base.rsi14];
  let momentum={direction:"WAIT",reason:"Waiting for fresh momentum indicators"};
  if(safe && momentumInputs.every(x=>x!==null)){
    const v=[Math.sign(base.momentum60),Math.sign(base.momentum180),Math.sign(base.ema9-base.ema21),base.rsi14>55?1:base.rsi14<45?-1:0];
    const score=v.reduce((a,x)=>a+x,0);
    momentum={direction:score>=3?"UP":score<=-3?"DOWN":"WAIT",reason:`Momentum votes ${score>0?"+":""}${score}/4; 60s ${base.momentum60.toFixed(1)} bps, 180s ${base.momentum180.toFixed(1)} bps`};
  }
  let orderbook={direction:"WAIT",reason:"Waiting for fresh order book"};
  if(safe && b && now-state.bookUpdatedAt<=FRESH_MARKET && base.bookPressure!==null && base.spread!==null && base.spread>=0 && base.spread<=0.05){
    const pressure=base.bookPressure;
    orderbook={direction:pressure>=0.30?"UP":pressure<=-0.30?"DOWN":"WAIT",reason:`Near-best-bid depth imbalance ${(pressure*100).toFixed(0)}%; spread ${(base.spread*100).toFixed(1)}¢`};
  }
  const trendOpinion=calculateTrendOpinion(now);
  return {lean:{direction:base.direction,reason:base.reasons[0]||`Heuristic agreement ${base.strength}/100`,strength:base.strength},momentum,orderbook,
    ai:trendOpinion,trend:trendOpinion,aiConfigured:false,aiModel:"Coinbase candle trend (local)",aiCallsToday:0};
}
// Fourth opinion: independent calculation from Coinbase 1-minute candles.
// No external model, credentials, remote inference or paid API calls.
function calculateTrendOpinion(now=Date.now()){
  const m=state.market;
  if(!m || !state.btcUpdatedAt || now-state.btcUpdatedAt>FRESH_BTC ||
     !state.candlesUpdatedAt || now-state.candlesUpdatedAt>120000)
    return {direction:"WAIT",reason:"Waiting for fresh Coinbase candles and market data",status:"waiting",generatedAt:null};
  const remaining=(Date.parse(m.close_time)-now)/1000;
  if(!Number.isFinite(remaining)||remaining<=120||remaining>900)
    return {direction:"WAIT",reason:"Outside 2–15 minute analysis window",status:"waiting",generatedAt:state.candlesUpdatedAt};
  const candles=state.candles.filter(c=>c.t>=now-20*60000&&c.t<=now&&Number.isFinite(c.close));
  if(candles.length<15)
    return {direction:"WAIT",reason:"Building 15-minute candle history",status:"waiting",generatedAt:state.candlesUpdatedAt};
  const closes=candles.map(c=>c.close), last=closes.at(-1), previous=closes.at(-6);
  const fast=ema(closes,5),slow=ema(closes,13),r=rsi(closes,14);
  if(!fast||!slow||!previous||r===null)
    return {direction:"WAIT",reason:"Insufficient trend indicators",status:"waiting",generatedAt:state.candlesUpdatedAt};
  const fiveMinBps=(last/previous-1)*10000;
  const trendBps=(fast/slow-1)*10000;
  const up=(trendBps>2?1:0)+(fiveMinBps>4?1:0)+(r>55?1:0);
  const down=(trendBps< -2?1:0)+(fiveMinBps< -4?1:0)+(r<45?1:0);
  const direction=up>=2&&down===0?"UP":down>=2&&up===0?"DOWN":"WAIT";
  return {direction,reason:`Coinbase 5m ${fiveMinBps>=0?"+":""}${fiveMinBps.toFixed(1)} bps · EMA trend ${trendBps>=0?"+":""}${trendBps.toFixed(1)} bps · RSI ${r.toFixed(0)}`,status:"ready",generatedAt:state.candlesUpdatedAt,model:"coinbase-candle-trend-v1"};
}
function loadPredictions(){try{const rows=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));if(Array.isArray(rows))state.predictions=rows.slice(-1000);}catch(e){if(e.code!=="ENOENT")console.warn("Could not load history:",e.message);}}
function savePredictions(){try{fs.mkdirSync(DATA_DIR,{recursive:true});const tmp=DATA_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(state.predictions.slice(-1000)));fs.renameSync(tmp,DATA_FILE);}catch(e){console.warn("History not persisted:",e.message);}}
async function notifyDiscord(p){if(!WEBHOOK)return;try{const content=`📊 **Kalshi BTC 15m alert (experimental)**\n${p.direction} · ${p.ticker}\nBTC: $${p.btcPrice.toFixed(2)} · Strike: $${p.strike.toFixed(2)}\nYES bid/ask: ${Math.round(p.yesBid*100)}¢ / ${Math.round(p.yesAsk*100)}¢\nHeuristic agreement: ${p.strength}/100 (NOT a win probability)\nNo automatic trades. Verify market rules and fees.`;const r=await fetch(WEBHOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content,allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(8000)});if(!r.ok)console.warn("Discord webhook HTTP",r.status);}catch(e){console.warn("Discord webhook failed:",e.message);}}
async function captureSignal(){const s=calculateSignal(timeNow()),m=state.market;if(s.direction==="WAIT"||!m)return;const key=`${m.ticker}:${s.direction}`;if(state.lastAlertKey===key)return;state.lastAlertKey=key;const record={id:`${m.ticker}:${Date.now()}`,ticker:m.ticker,direction:s.direction,createdAt:Date.now(),closeTime:m.close_time,btcPrice:state.btcPrice,strike:strikeOf(m),yesBid:s.yesBid,yesAsk:s.yesAsk,strength:s.strength,indicators:{momentum60:s.momentum60,momentum180:s.momentum180,rsi14:s.rsi14,normalizedDistance:s.normalizedDistance,bookPressure:s.bookPressure},entryAsk:s.direction==="UP"?s.yesAsk:s.noAsk,result:null,correct:null,status:"pending",model:s.model};state.predictions.push(record);state.predictions=state.predictions.slice(-1000);savePredictions();await notifyDiscord(record);}
async function settlePending(){const pending=state.predictions.filter(p=>p.status==="pending"&&Date.parse(p.closeTime)<timeNow()-60000).slice(0,10);let changed=false;for(const p of pending){try{const d=await getJSON(`${KALSHI}/markets/${encodeURIComponent(p.ticker)}`);const result=d.market?.result;if(result==="yes"||result==="no"){p.result=result;p.correct=(p.direction==="UP"?"yes":"no")===result;p.status="settled";changed=true;}}catch(e){state.errors.settlement=e.message;}}if(changed)savePredictions();}
function schedule(name,ms,fn){async function tick(){if(stopped)return;try{await fn();delete state.errors[name];}catch(e){state.errors[name]=e.message;console.warn(`${name}: ${e.message}`);}if(!stopped)setTimeout(tick,ms);}tick();}
app.get("/healthz",(_req,res)=>res.json({ok:true,uptimeSeconds:Math.floor(process.uptime()),marketLoaded:!!state.market,btcLoaded:!!state.btcPrice,errors:state.errors}));
app.get("/api/snapshot",(_req,res)=>{res.set("Cache-Control","no-store");res.json({...snapshot(),opinions:independentOpinions()});});
app.get("/api/predictions",(_req,res)=>{res.set("Cache-Control","no-store");const rows=state.predictions.slice(-100).reverse();const settled=state.predictions.filter(p=>p.status==="settled");const wins=settled.filter(p=>p.correct).length;res.json({rows,stats:{total:state.predictions.length,settled:settled.length,wins,winRate:settled.length?wins/settled.length:null},persistent:!!process.env.DATA_DIR});});
app.get("/api/ai-status",(_req,res)=>{res.set("Cache-Control","no-store");res.json({configured:false,model:"Coinbase candle trend (local)",status:independentOpinions().trend.status,reason:independentOpinions().trend.reason,callsToday:0});});
app.get("/api/config",(_req,res)=>res.json({alertsConfigured:!!WEBHOOK,mode:"alerts-only",series:SERIES,historyPersistenceConfigured:!!process.env.DATA_DIR,aiConfigured:false,aiModel:"Coinbase candle trend (local)"}));
app.use((_req,res)=>res.status(404).json({error:"Not found"}));
loadPredictions();
schedule("btc",BTC_INTERVAL,refreshBTC);
schedule("market",MARKET_INTERVAL,refreshMarket);
schedule("book",MARKET_INTERVAL,refreshBook);
schedule("candles",CANDLES_INTERVAL,refreshCandles);
schedule("signals",15000,captureSignal);
schedule("settlement",60000,settlePending);

const server=app.listen(PORT,"0.0.0.0",()=>console.log(`BTC Kalshi alerts-only dashboard on port ${PORT}; series ${SERIES}`));
for(const sig of ["SIGTERM","SIGINT"])process.on(sig,()=>{stopped=true;server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref();});