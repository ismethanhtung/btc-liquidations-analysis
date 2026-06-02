import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const API_KEY = process.env.COINGLASS_API_KEY;
if (!API_KEY) throw new Error("Missing COINGLASS_API_KEY");

const CG_BASE = "https://open-api-v4.coinglass.com/api";
const BINANCE_BASE = "https://api.binance.com/api/v3/klines";
const MS = {
  min: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function intervalToMs(interval) {
  switch (String(interval || "1h")) {
    case "30m":
      return 30 * MS.min;
    case "4h":
      return 4 * MS.hour;
    case "1d":
      return MS.day;
    default:
      return MS.hour;
  }
}

function roundToIntervalMs(ts, intervalMs) {
  return Math.floor(ts / intervalMs) * intervalMs;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function pickTimestamp(row) {
  const raw = row?.time ?? row?.t ?? row?.timestamp ?? row?.ts ?? row?.[0];
  const n = safeNum(raw, NaN);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function pickOhlc(row) {
  const value = safeNum(
    row?.close ?? row?.c ?? row?.value ?? row?.rate ?? row?.fundingRate ?? row?.oi ?? row?.openInterestUsd ?? row?.openInterest,
    0,
  );
  return {
    open: safeNum(row?.open ?? row?.o ?? value, value),
    high: safeNum(row?.high ?? row?.h ?? value, value),
    low: safeNum(row?.low ?? row?.l ?? value, value),
    close: safeNum(row?.close ?? row?.c ?? value, value),
  };
}

function normalizeLiquidation(row) {
  const ts = pickTimestamp(row);
  const longUsd = safeNum(
    row?.longLiquidationUsd ??
      row?.longUsd ??
      row?.long ??
      row?.aggregated_long_liquidation_usd ??
      row?.long_liquidation_usd,
    0,
  );
  const shortUsd = safeNum(
    row?.shortLiquidationUsd ??
      row?.shortUsd ??
      row?.short ??
      row?.aggregated_short_liquidation_usd ??
      row?.short_liquidation_usd,
    0,
  );
  return {
    timestamp: ts,
    longUsd,
    shortUsd,
    totalUsd: longUsd + shortUsd,
  };
}

function normalizeOhlc(row) {
  const ts = pickTimestamp(row);
  return { timestamp: ts, ...pickOhlc(row) };
}

function parseEarliestStartTimeFromMessage(message) {
  const text = String(message || "");
  const match = text.match(/earliest allowed start_time is\s+(\d{10,13})/i);
  if (!match) return null;
  const n = safeNum(match[1], NaN);
  return Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "CG-API-KEY": API_KEY,
    },
    cache: "no-store",
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || payload?.success === false || String(payload?.code ?? "0") !== "0") {
    const msg = payload?.msg || payload?.message || text.slice(0, 300);
    throw new Error(`Coinglass API error from ${url}: ${msg}`);
  }
  return payload;
}

async function fetchChunkedSeries({ name, baseUrl, params, normalize, interval, startMs, endMs, limit = 1000 }) {
  const intervalMs = intervalToMs(interval);
  const chunkSpanMs = intervalMs * limit;
  const rows = [];
  const meta = { name, earliestAcceptedStartTime: null, rows: 0 };

  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(endMs, cursor + chunkSpanMs);
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    url.searchParams.set("interval", interval);
    url.searchParams.set("start_time", String(cursor));
    url.searchParams.set("end_time", String(chunkEnd));
    url.searchParams.set("limit", String(limit));

    let payload;
    try {
      payload = await fetchJson(url.toString());
    } catch (error) {
      const earliest = parseEarliestStartTimeFromMessage(error?.message || "");
      if (earliest && earliest > cursor && earliest < endMs) {
        meta.earliestAcceptedStartTime = earliest;
        cursor = roundToIntervalMs(earliest, intervalMs);
        continue;
      }
      throw error;
    }

    const chunkRows = rowsFromPayload(payload).map(normalize).filter((r) => Number.isFinite(r.timestamp));
    rows.push(...chunkRows);
    cursor = chunkEnd + intervalMs;
  }

  const dedup = new Map();
  for (const row of rows) dedup.set(row.timestamp, row);
  const sorted = [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
  meta.rows = sorted.length;
  meta.firstTimestamp = sorted[0]?.timestamp ?? null;
  meta.lastTimestamp = sorted.at(-1)?.timestamp ?? null;
  meta.firstIso = sorted[0] ? new Date(sorted[0].timestamp).toISOString() : null;
  meta.lastIso = sorted.at(-1) ? new Date(sorted.at(-1).timestamp).toISOString() : null;
  return { rows: sorted, meta };
}

async function fetchBinanceCandles({ startMs, endMs, interval }) {
  const intervalMs = intervalToMs(interval);
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(endMs, cursor + intervalMs * 1000);
    const url = new URL(BINANCE_BASE);
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(chunkEnd));
    url.searchParams.set("limit", "1000");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      out.push({
        timestamp: safeNum(row[0], NaN),
        open: safeNum(row[1], 0),
        high: safeNum(row[2], 0),
        low: safeNum(row[3], 0),
        close: safeNum(row[4], 0),
      });
    }
    cursor = safeNum(rows.at(-1)?.[0], cursor) + intervalMs;
    if (rows.length < 1000) break;
  }
  const dedup = new Map();
  for (const row of out) dedup.set(row.timestamp, row);
  const sorted = [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
  return {
    rows: sorted,
    meta: {
      rows: sorted.length,
      firstTimestamp: sorted[0]?.timestamp ?? null,
      lastTimestamp: sorted.at(-1)?.timestamp ?? null,
      firstIso: sorted[0] ? new Date(sorted[0].timestamp).toISOString() : null,
      lastIso: sorted.at(-1) ? new Date(sorted.at(-1).timestamp).toISOString() : null,
    },
  };
}

function mergeSeries({ liquidation, funding, oi, oiWeight, cvd, price, interval }) {
  const intervalMs = intervalToMs(interval);
  const asMap = (rows) => new Map(rows.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));
  const maps = {
    liquidation: asMap(liquidation),
    funding: asMap(funding),
    oi: asMap(oi),
    oiWeight: asMap(oiWeight),
    cvd: asMap(cvd),
    price: asMap(price),
  };

  const keys = [...maps.price.keys()].sort((a, b) => a - b);
  const merged = [];
  for (const ts of keys) {
    const row = {
      liquidation: maps.liquidation.get(ts),
      funding: maps.funding.get(ts),
      oi: maps.oi.get(ts),
      oiWeight: maps.oiWeight.get(ts),
      cvd: maps.cvd.get(ts),
      price: maps.price.get(ts),
    };
    if (!row.liquidation || !row.funding || !row.oi || !row.oiWeight || !row.cvd || !row.price) continue;
    merged.push({
      timestamp: ts,
      datetime_utc: new Date(ts).toISOString(),
      price_open: row.price.open,
      price_high: row.price.high,
      price_low: row.price.low,
      price_close: row.price.close,
      liquidation_long_usd: row.liquidation.longUsd,
      liquidation_short_usd: row.liquidation.shortUsd,
      liquidation_total_usd: row.liquidation.totalUsd,
      funding_open: row.funding.open,
      funding_high: row.funding.high,
      funding_low: row.funding.low,
      funding_close: row.funding.close,
      oi_open: row.oi.open,
      oi_high: row.oi.high,
      oi_low: row.oi.low,
      oi_close: row.oi.close,
      oi_weight_open: row.oiWeight.open,
      oi_weight_high: row.oiWeight.high,
      oi_weight_low: row.oiWeight.low,
      oi_weight_close: row.oiWeight.close,
      cvd_open: row.cvd.open,
      cvd_high: row.cvd.high,
      cvd_low: row.cvd.low,
      cvd_close: row.cvd.close,
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
  const interval = process.argv[2] || "1h";
  const years = Math.max(0.05, safeNum(process.argv[3], 1));
  const exchangeList = process.argv[4] || "Binance,Bybit,OKX";
  const now = Date.now();
  const startMs = now - years * 365 * MS.day;

  const [liquidation, oi, funding, oiWeight, cvd, price] = await Promise.all([
    fetchChunkedSeries({
      name: "liquidation",
      baseUrl: `${CG_BASE}/futures/liquidation/aggregated-history`,
      params: { exchange_list: exchangeList, symbol: "BTC", unit: "usd" },
      normalize: normalizeLiquidation,
      interval,
      startMs,
      endMs: now,
    }),
    fetchChunkedSeries({
      name: "oi",
      baseUrl: `${CG_BASE}/futures/open-interest/history`,
      params: { exchange: "Binance", symbol: "BTCUSDT", unit: "usd" },
      normalize: normalizeOhlc,
      interval,
      startMs,
      endMs: now,
    }),
    fetchChunkedSeries({
      name: "funding",
      baseUrl: `${CG_BASE}/futures/funding-rate/history`,
      params: { exchange: "Binance", symbol: "BTCUSDT" },
      normalize: normalizeOhlc,
      interval,
      startMs,
      endMs: now,
    }),
    fetchChunkedSeries({
      name: "oiWeight",
      baseUrl: `${CG_BASE}/futures/funding-rate/oi-weight-history`,
      params: { symbol: "BTC" },
      normalize: normalizeOhlc,
      interval,
      startMs,
      endMs: now,
    }),
    fetchChunkedSeries({
      name: "cvd",
      baseUrl: `${CG_BASE}/futures/aggregated-cvd/history`,
      params: { exchange_list: exchangeList, symbol: "BTC", unit: "usd" },
      normalize: normalizeOhlc,
      interval,
      startMs,
      endMs: now,
    }),
    fetchBinanceCandles({ startMs, endMs: now, interval }),
  ]);

  const merged = mergeSeries({
    liquidation: liquidation.rows,
    funding: funding.rows,
    oi: oi.rows,
    oiWeight: oiWeight.rows,
    cvd: cvd.rows,
    price: price.rows,
    interval,
  });

  await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
  const csvPath = path.join(process.cwd(), "data", `coinglass_BTC_regime_${interval}_${years}y.csv`);
  const metaPath = path.join(process.cwd(), "data", `coinglass_BTC_regime_${interval}_${years}y.meta.json`);

  await fs.writeFile(csvPath, toCsv(merged), "utf8");
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        requested: {
          interval,
          years,
          exchangeList,
          startMs,
          endMs: now,
          startIso: new Date(startMs).toISOString(),
          endIso: new Date(now).toISOString(),
        },
        sources: {
          liquidation: liquidation.meta,
          oi: oi.meta,
          funding: funding.meta,
          oiWeight: oiWeight.meta,
          cvd: cvd.meta,
          price: price.meta,
        },
        merged: {
          rows: merged.length,
          firstTimestamp: merged[0]?.timestamp ?? null,
          lastTimestamp: merged.at(-1)?.timestamp ?? null,
          firstIso: merged[0]?.datetime_utc ?? null,
          lastIso: merged.at(-1)?.datetime_utc ?? null,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        csvPath,
        metaPath,
        rows: merged.length,
        firstIso: merged[0]?.datetime_utc ?? null,
        lastIso: merged.at(-1)?.datetime_utc ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
