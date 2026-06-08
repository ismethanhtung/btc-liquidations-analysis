import fs from "node:fs/promises";
import path from "node:path";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchBinanceKlines(startMs, endMs) {
  const interval = "5m";
  const intervalMs = 5 * 60 * 1000;
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance klines error: ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({
        timestamp: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5])
      });
    }
    cursor = Number(rows[rows.length - 1][0]) + intervalMs;
    if (rows.length < 1500) break;
  }
  const dedup = new Map();
  for (const r of out) dedup.set(r.timestamp, r);
  return [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchBinanceOpenInterest(startMs, endMs) {
  const period = "5m";
  const periodMs = 5 * 60 * 1000;
  const out = [];
  let cursorEnd = endMs;
  while (cursorEnd > startMs) {
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=${period}&startTime=${startMs}&endTime=${cursorEnd}&limit=500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance OI error: ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({
        timestamp: Number(r.timestamp),
        oiUsd: Number(r.sumOpenInterestValue),
        oiBase: Number(r.sumOpenInterest)
      });
    }
    cursorEnd = Number(rows[0].timestamp) - periodMs;
    if (rows.length < 500) break;
  }
  const dedup = new Map();
  for (const r of out) dedup.set(r.timestamp, r);
  return [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchBinanceTakerRatio(startMs, endMs) {
  const period = "5m";
  const periodMs = 5 * 60 * 1000;
  const out = [];
  let cursorEnd = endMs;
  while (cursorEnd > startMs) {
    const url = `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=${period}&startTime=${startMs}&endTime=${cursorEnd}&limit=500`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance Taker ratio error: ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({
        timestamp: Number(r.timestamp),
        buyVol: Number(r.buyVol),
        sellVol: Number(r.sellVol)
      });
    }
    cursorEnd = Number(rows[0].timestamp) - periodMs;
    if (rows.length < 500) break;
  }
  const dedup = new Map();
  for (const r of out) dedup.set(r.timestamp, r);
  return [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchBinanceFundingRate() {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance funding rate error: ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    timestamp: Number(r.fundingTime),
    rate: Number(r.fundingRate)
  })).sort((a, b) => a.timestamp - b.timestamp);
}

function mergeBinanceSeries({ klines, oi, taker, funding }) {
  const oiMap = new Map(oi.map(r => [r.timestamp, r]));
  const takerMap = new Map(taker.map(r => [r.timestamp, r]));
  
  let currentCvd = 0;
  let currentFunding = 0;
  
  const merged = [];
  
  for (const k of klines) {
    const ts = k.timestamp;
    
    // 1. Open Interest
    const oiRow = oiMap.get(ts);
    const oiValue = oiRow ? oiRow.oiUsd : (merged.at(-1)?.oi_close ?? 0);
    
    // 2. CVD (derived from net taker volumes)
    const takerRow = takerMap.get(ts);
    const buyVol = takerRow ? takerRow.buyVol : 0;
    const sellVol = takerRow ? takerRow.sellVol : 0;
    const netVol = buyVol - sellVol;
    currentCvd += netVol;
    
    // 3. Funding rate
    const activeFundingRow = funding.filter(f => f.timestamp <= ts).at(-1);
    if (activeFundingRow) {
      currentFunding = activeFundingRow.rate;
    }
    
    merged.push({
      timestamp: ts,
      datetime_utc: new Date(ts).toISOString(),
      price_open: k.open,
      price_high: k.high,
      price_low: k.low,
      price_close: k.close,
      liquidation_long_usd: 0,
      liquidation_short_usd: 0,
      liquidation_total_usd: 0,
      funding_open: currentFunding,
      funding_high: currentFunding,
      funding_low: currentFunding,
      funding_close: currentFunding,
      oi_open: oiValue,
      oi_high: oiValue,
      oi_low: oiValue,
      oi_close: oiValue,
      oi_weight_open: currentFunding,
      oi_weight_high: currentFunding,
      oi_weight_low: currentFunding,
      oi_weight_close: currentFunding,
      cvd_open: currentCvd,
      cvd_high: currentCvd,
      cvd_low: currentCvd,
      cvd_close: currentCvd,
    });
  }
  
  return merged;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((key) => row[key]).join(",")),
  ].join("\n");
}

async function main() {
  const days = 14;
  const now = Date.now();
  const startMs = now - days * MS_PER_DAY;

  console.log(`Starting fetch of Binance Futures BTCUSDT 5m data for the last ${days} days...`);
  console.log(`Time window: ${new Date(startMs).toISOString()} -> ${new Date(now).toISOString()}`);

  const [klines, oi, taker, funding] = await Promise.all([
    fetchBinanceKlines(startMs, now),
    fetchBinanceOpenInterest(startMs, now),
    fetchBinanceTakerRatio(startMs, now),
    fetchBinanceFundingRate()
  ]);

  console.log(`Successfully fetched klines (${klines.length}), oi (${oi.length}), taker ratio (${taker.length}), funding rate updates (${funding.length})`);

  const merged = mergeBinanceSeries({ klines, oi, taker, funding });
  console.log(`Merged series: ${merged.length} rows.`);

  const dataDir = path.join(process.cwd(), "data");
  await fs.mkdir(dataDir, { recursive: true });

  const fileName = `coinglass_BTC_regime_binance_5m_${days}d.csv`;
  const csvPath = path.join(dataDir, fileName);
  const metaPath = path.join(dataDir, `coinglass_BTC_regime_binance_5m_${days}d.meta.json`);

  await fs.writeFile(csvPath, toCsv(merged), "utf8");
  await fs.writeFile(metaPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    requested: {
      interval: "5m",
      days,
      symbol: "BTCUSDT",
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(now).toISOString()
    },
    merged: {
      rows: merged.length,
      firstIso: merged[0]?.datetime_utc ?? null,
      lastIso: merged.at(-1)?.datetime_utc ?? null
    }
  }, null, 2), "utf8");

  console.log(`Saved successfully to ${csvPath}`);
}

main().catch(e => {
  console.error("Error fetching dataset:", e);
  process.exit(1);
});
