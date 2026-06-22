import fs from "node:fs";
import path from "node:path";

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (!arr.length) return 1;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(v) || 1;
}

function sampleStd(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v) || 0;
}

function quantile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function logSumExp(values) {
  const max = Math.max(...values);
  if (!Number.isFinite(max)) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum || 1);
}

function roundToIntervalMs(ts, intervalMs) {
  if (!Number.isFinite(ts) || !Number.isFinite(intervalMs) || intervalMs <= 0) return ts;
  return Math.floor(ts / intervalMs) * intervalMs;
}

function intervalToMs(interval) {
  const str = String(interval || "1h").trim().toLowerCase();
  const match = str.match(/^(\d+)([mhd])$/);
  if (match) {
    const val = Number(match[1]);
    const unit = match[2];
    if (unit === "m") return val * MS.min;
    if (unit === "h") return val * MS.hour;
    if (unit === "d") return val * MS.day;
  }
  if (str === "30m") return 30 * MS.min;
  if (str === "4h") return 4 * MS.hour;
  if (str === "1d") return MS.day;
  return MS.hour;
}

function intervalBarsPerDay(interval) {
  return Math.max(1, Math.round(MS.day / intervalToMs(interval)));
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.history)) return payload.history;
  return [];
}

function pickTimestamp(row) {
  const raw = row?.time ?? row?.t ?? row?.timestamp ?? row?.ts ?? row?.x ?? row?.[0];
  const n = safeNum(raw, NaN);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function pickOhlc(row) {
  const value = safeNum(
    row?.close ?? row?.c ?? row?.value ?? row?.rate ?? row?.fundingRate ?? row?.oi ?? row?.openInterestUsd ?? row?.openInterest ?? row?.v,
    0,
  );
  const open = safeNum(row?.open ?? row?.o ?? value, value);
  const high = safeNum(row?.high ?? row?.h ?? value, value);
  const low = safeNum(row?.low ?? row?.l ?? value, value);
  const close = safeNum(row?.close ?? row?.c ?? value, value);
  return { open, high, low, close };
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
  const totalRaw = safeNum(
    row?.totalLiquidationUsd ?? row?.totalUsd ?? row?.total ?? row?.sum,
    longUsd + shortUsd,
  );
  return {
    timestamp: ts,
    longUsd,
    shortUsd,
    totalUsd: Number.isFinite(totalRaw) ? totalRaw : longUsd + shortUsd,
  };
}

function normalizeOhlc(row) {
  const ts = pickTimestamp(row);
  const { open, high, low, close } = pickOhlc(row);
  return { timestamp: ts, open, high, low, close };
}

async function fetchJson(url, apiKey) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "CG-API-KEY": apiKey,
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
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
  if (payload?.success === false || String(payload?.code ?? "0") !== "0") {
    throw new Error(`Coinglass API error from ${url}: ${payload?.msg || payload?.message || "unknown"}`);
  }
  return payload;
}

function parseEarliestStartTimeFromMessage(message) {
  const text = String(message || "");
  const match = text.match(/earliest allowed start_time is\s+(\d{10,13})/i);
  if (!match) return null;
  const n = safeNum(match[1], NaN);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? n : n * 1000;
}

async function fetchChunkedSeries({
  apiKey,
  baseUrl,
  params,
  interval,
  startMs,
  endMs,
  limit = 1000,
  normalize,
}) {
  const intervalMs = intervalToMs(interval);
  const chunkSpanMs = intervalMs * limit;
  const out = [];

  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(endMs, cursor + chunkSpanMs);
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("start_time", String(cursor));
    url.searchParams.set("end_time", String(chunkEnd));
    let payload;
    try {
      payload = await fetchJson(url.toString(), apiKey);
    } catch (error) {
      const message = error?.message || "";
      const earliest = parseEarliestStartTimeFromMessage(message);
      if (earliest && earliest > cursor && earliest < endMs) {
        cursor = roundToIntervalMs(earliest, intervalMs);
        continue;
      }
      throw error;
    }
    const rows = rowsFromPayload(payload).map(normalize).filter((r) => Number.isFinite(r.timestamp));
    out.push(...rows);
    cursor = chunkEnd + intervalMs;
  }

  const dedup = new Map();
  for (const row of out) dedup.set(row.timestamp, row);
  return [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
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
    const res = await fetch(url.toString(), { cache: "no-store" });
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
    cursor = safeNum(rows[rows.length - 1][0], cursor) + intervalMs;
    if (rows.length < 1000) break;
  }
  const dedup = new Map();
  for (const row of out) dedup.set(row.timestamp, row);
  return [...dedup.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function pctMove(from, to) {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return 0;
  return (to - from) / from;
}

function rollingMean(values, idx, window) {
  const start = Math.max(0, idx - window + 1);
  const slice = values.slice(start, idx + 1);
  return mean(slice);
}

function rollingStd(values, idx, window) {
  const start = Math.max(0, idx - window + 1);
  const slice = values.slice(start, idx + 1);
  return std(slice);
}

function rollingCorr(xs, ys, idx, window) {
  const start = Math.max(0, idx - window + 1);
  const a = [];
  const b = [];
  for (let i = start; i <= idx; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    a.push(x);
    b.push(y);
  }
  if (a.length < 4) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ax = a[i] - ma;
    const by = b[i] - mb;
    num += ax * by;
    da += ax * ax;
    db += by * by;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

function mergeSeries({ liquidation, funding, oi, oiWeight, cvd, candles, interval }) {
  const intervalMs = intervalToMs(interval);
  const liqMap = new Map(liquidation.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));
  const fundingMap = new Map(funding.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));
  const oiMap = new Map(oi.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));
  const oiWeightMap = new Map(oiWeight.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));
  const cvdMap = new Map(cvd.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));
  const priceMap = new Map(candles.map((r) => [roundToIntervalMs(r.timestamp, intervalMs), r]));

  const keys = [...priceMap.keys()].sort((a, b) => a - b);
  const rows = [];
  for (const ts of keys) {
    const price = priceMap.get(ts);
    const liqRow = liqMap.get(ts);
    const fundingRow = fundingMap.get(ts);
    const oiRow = oiMap.get(ts);
    const oiWeightRow = oiWeightMap.get(ts);
    const cvdRow = cvdMap.get(ts);
    if (!price || !liqRow || !fundingRow || !oiRow || !oiWeightRow || !cvdRow) continue;
    rows.push({
      ts,
      timestamp: new Date(ts).toISOString(),
      price,
      liquidation: liqRow,
      funding: fundingRow,
      oi: oiRow,
      oiWeight: oiWeightRow,
      cvd: cvdRow,
    });
  }
  return rows;
}

function buildFeatureRows(rows, interval) {
  const barsPerDay = Math.min(48, intervalBarsPerDay(interval));
  const priceCloses = rows.map((r) => safeNum(r.price.close, 0));
  const oiCloses = rows.map((r) => safeNum(r.oi.close, 0));
  const fundingCloses = rows.map((r) => safeNum(r.funding.close, 0));
  const oiWeightCloses = rows.map((r) => safeNum(r.oiWeight.close, 0));
  const cvdCloses = rows.map((r) => safeNum(r.cvd.close, 0));
  const liqTotals = rows.map((r) => safeNum(r.liquidation.totalUsd, 0));
  const liqLongs = rows.map((r) => safeNum(r.liquidation.longUsd, 0));
  const liqShorts = rows.map((r) => safeNum(r.liquidation.shortUsd, 0));

  const priceRets = priceCloses.map((close, i) => (i === 0 ? 0 : pctMove(priceCloses[i - 1], close)));
  const oiRets = oiCloses.map((close, i) => (i === 0 ? 0 : pctMove(oiCloses[i - 1], close)));
  const oiWeightRets = oiWeightCloses.map((close, i) => (i === 0 ? 0 : pctMove(oiWeightCloses[i - 1], close)));
  const cvdRets = cvdCloses.map((close, i) => (i === 0 ? 0 : pctMove(cvdCloses[i - 1], close)));

  const featureRows = rows.map((row, idx) => {
    const liqTotal = safeNum(liqTotals[idx], 0);
    const liqLong = safeNum(liqLongs[idx], 0);
    const liqShort = safeNum(liqShorts[idx], 0);
    const fundingClose = safeNum(fundingCloses[idx], 0);
    const oiClose = safeNum(oiCloses[idx], 0);
    const oiWeightClose = safeNum(oiWeightCloses[idx], 0);
    const cvdClose = safeNum(cvdCloses[idx], 0);
    const priceClose = safeNum(priceCloses[idx], 0);

    const liqWindow24 = Math.max(4, barsPerDay);
    const liqMean24 = rollingMean(liqTotals, idx, liqWindow24);
    const liqStd24 = rollingStd(liqTotals, idx, liqWindow24);
    const oiWindow24 = Math.max(4, barsPerDay);
    const fundingWindow48 = Math.max(8, barsPerDay * 2);
    const priceWindow24 = Math.max(4, barsPerDay);
    const priceWindow72 = Math.max(priceWindow24, barsPerDay * 3);
    const retWindow24 = Math.max(4, barsPerDay);

    const priceRet24 = idx >= priceWindow24 ? pctMove(priceCloses[idx - priceWindow24], priceClose) : 0;
    const priceRet72 = idx >= priceWindow72 ? pctMove(priceCloses[idx - priceWindow72], priceClose) : 0;
    const oiRet24 = idx >= oiWindow24 ? pctMove(oiCloses[idx - oiWindow24], oiClose) : 0;
    const oiWeightRet24 = idx >= oiWindow24 ? pctMove(oiWeightCloses[idx - oiWindow24], oiWeightClose) : 0;
    const cvdRet24 = idx >= oiWindow24 ? pctMove(cvdCloses[idx - oiWindow24], cvdClose) : 0;

    const priceVol24 = sampleStd(priceRets.slice(Math.max(0, idx - retWindow24 + 1), idx + 1));
    const priceVol72 = sampleStd(priceRets.slice(Math.max(0, idx - priceWindow72 + 1), idx + 1));
    const fundingMean48 = rollingMean(fundingCloses, idx, fundingWindow48);
    const fundingStd48 = rollingStd(fundingCloses, idx, fundingWindow48);
    const fundingShock = fundingStd48 > 0 ? (fundingClose - fundingMean48) / fundingStd48 : 0;
    const liqShock = liqStd24 > 0 ? (liqTotal - liqMean24) / liqStd24 : 0;
    const liqImbalance = liqTotal > 0 ? (liqLong - liqShort) / liqTotal : 0;
    const liqAbsImbalance = liqTotal > 0 ? Math.abs(liqImbalance) : 0;
    const oiMomentum = idx >= 3 * barsPerDay ? pctMove(oiCloses[idx - 3 * barsPerDay], oiClose) : 0;
    const cvdMomentum = idx >= 3 * barsPerDay ? pctMove(cvdCloses[idx - 3 * barsPerDay], cvdClose) : 0;
    const corrOiPrice24 = rollingCorr(oiRets, priceRets, idx, oiWindow24);
    const corrCvdPrice24 = rollingCorr(cvdRets, priceRets, idx, oiWindow24);
    const corrFundingOi24 = rollingCorr(oiWeightRets, fundingCloses, idx, oiWindow24);
    const maxDrawdown24 = (() => {
      const start = Math.max(0, idx - priceWindow24 + 1);
      let peak = -Infinity;
      let worst = 0;
      for (let i = start; i <= idx; i += 1) {
        const v = priceCloses[i];
        if (!Number.isFinite(v) || v <= 0) continue;
        peak = Math.max(peak, v);
        if (peak > 0) worst = Math.min(worst, pctMove(peak, v));
      }
      return worst;
    })();

    return {
      ts: row.ts,
      timestamp: row.timestamp,
      priceClose,
      priceRet24,
      priceRet72,
      priceVol24,
      priceVol72,
      liqTotal,
      liqShock,
      liqImbalance,
      liqAbsImbalance,
      fundingClose,
      fundingShock,
      oiClose,
      oiRet24,
      oiMomentum,
      oiWeightClose,
      oiWeightRet24,
      cvdClose,
      cvdRet24,
      cvdMomentum,
      corrOiPrice24,
      corrCvdPrice24,
      corrFundingOi24,
      maxDrawdown24,
    };
  });

  return featureRows;
}

const ALL_FEATURE_NAMES = [
  "priceRet24",
  "priceRet72",
  "priceVol24",
  "priceVol72",
  "liqShock",
  "liqImbalance",
  "fundingShock",
  "oiRet24",
  "oiMomentum",
  "oiWeightRet24",
  "cvdRet24",
  "cvdMomentum",
  "corrOiPrice24",
  "corrCvdPrice24",
  "corrFundingOi24",
  "maxDrawdown24",
];

function buildFeatureNames(selectedFeatures = null) {
  if (!Array.isArray(selectedFeatures) || selectedFeatures.length === 0) return ALL_FEATURE_NAMES;
  const allowed = new Set(ALL_FEATURE_NAMES);
  const filtered = selectedFeatures
    .map((feature) => String(feature || ""))
    .filter((feature) => allowed.has(feature));
  return filtered.length >= 2 ? filtered : ALL_FEATURE_NAMES;
}

function standardizeMatrix(rows, featureNames) {
  const stats = {};
  for (const f of featureNames) {
    const values = rows.map((r) => safeNum(r[f], 0));
    const q25 = quantile(values, 0.25);
    const q50 = quantile(values, 0.5);
    const q75 = quantile(values, 0.75);
    const robustStd = (q75 - q25) / 1.349;
    const fallbackStd = std(values) || 1;
    stats[f] = {
      mean: q50,
      std: robustStd > 1e-12 ? robustStd : fallbackStd,
      rawMean: mean(values),
      rawStd: fallbackStd,
      q25,
      q75,
    };
  }
  const matrix = rows.map((r) => featureNames.map((f) => {
    const { mean: m, std: s } = stats[f];
    return clamp((safeNum(r[f], 0) - m) / (s || 1), -6, 6);
  }));
  return { matrix, stats };
}

function dot(a, b) {
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out += a[i] * b[i];
  return out;
}

function norm(a) {
  return Math.sqrt(dot(a, a)) || 1;
}

function covarianceMatrix(matrix) {
  const dims = matrix[0]?.length || 0;
  const cov = Array.from({ length: dims }, () => new Array(dims).fill(0));
  if (!matrix.length) return cov;
  for (const row of matrix) {
    for (let i = 0; i < dims; i += 1) {
      for (let j = i; j < dims; j += 1) cov[i][j] += row[i] * row[j];
    }
  }
  const denom = Math.max(1, matrix.length - 1);
  for (let i = 0; i < dims; i += 1) {
    for (let j = i; j < dims; j += 1) {
      cov[i][j] /= denom;
      cov[j][i] = cov[i][j];
    }
  }
  return cov;
}

function matVec(m, v) {
  return m.map((row) => dot(row, v));
}

function powerEigen(matrix, initial, iterations = 80) {
  let v = initial.map((x) => Number(x || 0));
  let vNorm = norm(v);
  v = v.map((x) => x / vNorm);
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = matVec(matrix, v);
    vNorm = norm(next);
    v = next.map((x) => x / vNorm);
  }
  const mv = matVec(matrix, v);
  return { vector: v, value: dot(v, mv) };
}

function buildPcaProjection(matrix, timeline, chosenK) {
  if (!matrix.length || !matrix[0]?.length) {
    return { points: [], explained: [0, 0, 0] };
  }
  const dims = matrix[0].length;
  const cov = covarianceMatrix(matrix);
  const pc1 = powerEigen(cov, Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0)));
  const deflated = cov.map((row, i) => row.map((value, j) => value - pc1.value * pc1.vector[i] * pc1.vector[j]));
  const seed2 = Array.from({ length: dims }, (_, i) => (i === 1 ? 1 : 0));
  const pc2 = powerEigen(deflated, seed2);
  
  const deflated2 = deflated.map((row, i) => row.map((value, j) => value - pc2.value * pc2.vector[i] * pc2.vector[j]));
  let pc3 = { vector: Array.from({ length: dims }, () => 0), value: 0 };
  if (dims > 2) {
    const seed3 = Array.from({ length: dims }, (_, i) => (i === 2 % dims ? 1 : 0));
    pc3 = powerEigen(deflated2, seed3);
  }
  
  const totalVar = cov.reduce((sum, row, i) => sum + row[i], 0) || 1;
  const step = Math.max(1, Math.floor(matrix.length / 1200));
  const points = [];
  for (let i = 0; i < matrix.length; i += step) {
    const row = matrix[i];
    const t = timeline[i];
    points.push({
      state: t.state,
      color: tintColor(t.state, chosenK),
      time: t.time,
      timestamp: t.timestamp,
      x: dot(row, pc1.vector),
      y: dot(row, pc2.vector),
      z: dot(row, pc3.vector),
      confidence: t.confidence,
    });
  }
  return {
    points,
    explained: [
      Math.max(0, pc1.value / totalVar),
      Math.max(0, pc2.value / totalVar),
      Math.max(0, pc3.value / totalVar)
    ],
  };
}

function buildStateDistanceMatrix(matrix, path, chosenK) {
  const dims = matrix[0]?.length || 0;
  const sums = Array.from({ length: chosenK }, () => new Array(dims).fill(0));
  const counts = new Array(chosenK).fill(0);
  for (let i = 0; i < matrix.length; i += 1) {
    const state = path[i];
    counts[state] += 1;
    for (let d = 0; d < dims; d += 1) sums[state][d] += matrix[i][d];
  }
  const centers = sums.map((sum, state) => sum.map((v) => v / Math.max(1, counts[state])));
  const distances = Array.from({ length: chosenK }, (_, i) => (
    Array.from({ length: chosenK }, (_, j) => {
      if (i === j) return 0;
      return Math.sqrt(squaredEuclidean(centers[i], centers[j]));
    })
  ));
  const nearest = centers.map((_, i) => {
    const vals = distances[i].filter((_, j) => j !== i);
    return vals.length ? Math.min(...vals) : 0;
  });
  return { centers, distances, nearest, counts };
}

function squaredEuclidean(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - b[i];
    d += x * x;
  }
  return d;
}

function farthestFirstInit(matrix, k) {
  const centroids = [matrix[Math.floor(matrix.length / 2)]];
  while (centroids.length < k) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < matrix.length; i += 1) {
      let minDist = Infinity;
      for (const c of centroids) {
        const dist = squaredEuclidean(matrix[i], c);
        if (dist < minDist) minDist = dist;
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        bestIdx = i;
      }
    }
    centroids.push(matrix[bestIdx]);
  }
  return centroids.map((c) => [...c]);
}

function kmeans(matrix, k, maxIter = 30) {
  if (!matrix.length) {
    return { labels: [], centroids: [], inertia: 0 };
  }
  const kk = Math.max(1, Math.min(k, matrix.length));
  let centroids = farthestFirstInit(matrix, kk);
  let labels = new Array(matrix.length).fill(0);

  for (let iter = 0; iter < maxIter; iter += 1) {
    let changed = false;
    for (let i = 0; i < matrix.length; i += 1) {
      let best = 0;
      let bestDist = Infinity;
      for (let j = 0; j < centroids.length; j += 1) {
        const dist = squaredEuclidean(matrix[i], centroids[j]);
        if (dist < bestDist) {
          bestDist = dist;
          best = j;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }

    const sums = Array.from({ length: centroids.length }, () => new Array(matrix[0].length).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < matrix.length; i += 1) {
      const label = labels[i];
      counts[label] += 1;
      for (let d = 0; d < matrix[i].length; d += 1) sums[label][d] += matrix[i][d];
    }
    for (let j = 0; j < centroids.length; j += 1) {
      if (!counts[j]) continue;
      centroids[j] = sums[j].map((x) => x / counts[j]);
    }
    if (!changed) break;
  }

  let inertia = 0;
  for (let i = 0; i < matrix.length; i += 1) inertia += squaredEuclidean(matrix[i], centroids[labels[i]]);
  return { labels, centroids, inertia };
}

function silhouetteScore(matrix, labels, k, sampleSize = 600) {
  if (matrix.length < 4 || k < 2) return 0;
  const n = matrix.length;
  const step = Math.max(1, Math.floor(n / sampleSize));
  const indices = [];
  for (let i = 0; i < n; i += step) indices.push(i);
  const scored = [];
  for (const i of indices) {
    const own = labels[i];
    let aSum = 0;
    let aCount = 0;
    const bSum = new Array(k).fill(0);
    const bCount = new Array(k).fill(0);
    for (let j = 0; j < matrix.length; j += step) {
      if (i === j) continue;
      const dist = Math.sqrt(squaredEuclidean(matrix[i], matrix[j]));
      const lab = labels[j];
      bSum[lab] += dist;
      bCount[lab] += 1;
      if (lab === own) {
        aSum += dist;
        aCount += 1;
      }
    }
    const a = aCount ? aSum / aCount : 0;
    let b = Infinity;
    for (let c = 0; c < k; c += 1) {
      if (c === own || !bCount[c]) continue;
      b = Math.min(b, bSum[c] / bCount[c]);
    }
    if (!Number.isFinite(b)) b = 0;
    scored.push(a === 0 && b === 0 ? 0 : (b - a) / Math.max(a, b, 1e-9));
  }
  return mean(scored);
}

function pickBestK(matrix, maxK = 6, hmmIterations = 10) {
  const upper = Math.max(2, Math.min(maxK, matrix.length - 1));
  const candidates = [];
  let prevInertia = null;
  const N = matrix.length;
  const D = matrix[0]?.length || 0;

  for (let k = 2; k <= upper; k += 1) {
    const fit = kmeans(matrix, k, 20);
    const sil = silhouetteScore(matrix, fit.labels, k);
    const drop = prevInertia && prevInertia > 0 ? (prevInertia - fit.inertia) / prevInertia : 0;
    
    // Fit HMM to get actual HMM log-likelihood and transition matrix
    const hmm = fitHmm(matrix, fit.labels, k, hmmIterations);
    const logLik = hmm.logLik;
    const numParams = k * k + 2 * k * D;
    const aic = 2 * numParams - 2 * logLik;
    const bic = numParams * Math.log(N) - 2 * logLik;
    
    let diagonalSum = 0;
    for (let i = 0; i < k; i++) {
      diagonalSum += hmm.trans[i]?.[i] || 0;
    }
    const persistence = diagonalSum / k;
    
	    const counts = new Array(k).fill(0);
	    for (const label of hmm.path) {
	      counts[label]++;
	    }
	    const shares = counts.map((count) => count / N);
	    const minShare = Math.min(...shares);
	    const maxShare = Math.max(...shares);
	    let entropy = 0;
	    for (let i = 0; i < k; i++) {
	      const p = shares[i];
	      if (p > 0) {
	        entropy -= p * Math.log(p);
	      }
	    }
	    const balance = entropy / Math.log(k);
	    const interpretability = persistence * balance;
	    
	    const tinyClusterPenalty = minShare < 0.02 ? (0.02 - minShare) * 20 : 0;
	    const dominantClusterPenalty = maxShare > 0.9 ? (maxShare - 0.9) * 2 : 0;
	    const score = sil + 0.35 * drop + 0.35 * balance + 0.15 * interpretability - tinyClusterPenalty - dominantClusterPenalty;
	    candidates.push({
	      k,
	      inertia: fit.inertia,
	      silhouette: sil,
	      elbowDrop: drop,
      logLik,
      aic,
	      bic,
	      persistence,
	      balance,
	      minShare,
	      maxShare,
	      counts,
	      interpretability,
	      score,
	      labels: fit.labels,
	      centroids: fit.centroids
	    });
    prevInertia = fit.inertia;
  }
	  const usableCandidates = candidates.filter((row) => row.minShare >= 0.02 && row.balance >= 0.25 && row.maxShare <= 0.9);
	  const scorePool = usableCandidates.length ? usableCandidates : candidates;
	  const bestScore = [...scorePool].sort((a, b) => b.score - a.score)[0] || null;
	  const bestSilhouette = [...candidates].sort((a, b) => b.silhouette - a.silhouette)[0] || null;
	  const bestElbow = [...candidates].sort((a, b) => b.elbowDrop - a.elbowDrop)[0] || null;
	  const bestAIC = [...candidates].sort((a, b) => a.aic - b.aic)[0] || null;
	  const bestBIC = [...candidates].sort((a, b) => a.bic - b.bic)[0] || null;
	  const bestInterpretability = [...candidates].sort((a, b) => b.interpretability - a.interpretability)[0] || null;

	  return {
	    best: bestScore || bestSilhouette,
	    bestScore,
	    bestSilhouette,
	    bestElbow,
	    bestAIC,
	    bestBIC,
	    bestInterpretability,
	    usableCandidates,
	    candidates
	  };
	}

function initGaussianParams(matrix, labels, k) {
  const dims = matrix[0]?.length || 0;
  const means = Array.from({ length: k }, () => new Array(dims).fill(0));
  const vars = Array.from({ length: k }, () => new Array(dims).fill(1));
  const counts = new Array(k).fill(0);

  for (let i = 0; i < matrix.length; i += 1) {
    const label = labels[i];
    counts[label] += 1;
    for (let d = 0; d < dims; d += 1) means[label][d] += matrix[i][d];
  }
  for (let j = 0; j < k; j += 1) {
    if (!counts[j]) continue;
    for (let d = 0; d < dims; d += 1) means[j][d] /= counts[j];
  }
  for (let i = 0; i < matrix.length; i += 1) {
    const label = labels[i];
    for (let d = 0; d < dims; d += 1) {
      const x = matrix[i][d] - means[label][d];
      vars[label][d] += x * x;
    }
  }
  for (let j = 0; j < k; j += 1) {
    const denom = Math.max(1, counts[j]);
    for (let d = 0; d < dims; d += 1) vars[j][d] = Math.max(vars[j][d] / denom, 1e-4);
  }

  const start = new Array(k).fill(1 / k);
  const trans = Array.from({ length: k }, () => new Array(k).fill(1 / k));
  for (let i = 1; i < labels.length; i += 1) trans[labels[i - 1]][labels[i]] += 1;
  for (let i = 0; i < k; i += 1) {
    const rowSum = trans[i].reduce((s, x) => s + x, 0) || 1;
    trans[i] = trans[i].map((x) => x / rowSum);
  }
  return { start, trans, means, vars };
}

function gaussianLogPdf(x, meanVec, varVec) {
  let score = 0;
  for (let d = 0; d < x.length; d += 1) {
    const v = Math.max(varVec[d], 1e-4);
    const diff = x[d] - meanVec[d];
    score += -0.5 * (Math.log(2 * Math.PI * v) + (diff * diff) / v);
  }
  return score;
}

function forwardBackward(matrix, start, trans, means, vars) {
  const T = matrix.length;
  const K = start.length;
  const logEmit = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let t = 0; t < T; t += 1) {
    for (let k = 0; k < K; k += 1) logEmit[t][k] = gaussianLogPdf(matrix[t], means[k], vars[k]);
  }

  const logStart = start.map((p) => Math.log(Math.max(p, 1e-12)));
  const logTrans = trans.map((row) => row.map((p) => Math.log(Math.max(p, 1e-12))));

  const alpha = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let k = 0; k < K; k += 1) alpha[0][k] = logStart[k] + logEmit[0][k];
  for (let t = 1; t < T; t += 1) {
    for (let j = 0; j < K; j += 1) {
      const prev = [];
      for (let i = 0; i < K; i += 1) prev.push(alpha[t - 1][i] + logTrans[i][j]);
      alpha[t][j] = logEmit[t][j] + logSumExp(prev);
    }
  }

  const beta = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let t = T - 2; t >= 0; t -= 1) {
    for (let i = 0; i < K; i += 1) {
      const next = [];
      for (let j = 0; j < K; j += 1) next.push(logTrans[i][j] + logEmit[t + 1][j] + beta[t + 1][j]);
      beta[t][i] = logSumExp(next);
    }
  }

  const logLik = logSumExp(alpha[T - 1]);
  const gamma = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let t = 0; t < T; t += 1) {
    let rowSum = 0;
    for (let k = 0; k < K; k += 1) {
      gamma[t][k] = Math.exp(alpha[t][k] + beta[t][k] - logLik);
      rowSum += gamma[t][k];
    }
    if (rowSum > 0) {
      for (let k = 0; k < K; k += 1) gamma[t][k] /= rowSum;
    }
  }

  const xiSum = Array.from({ length: K }, () => new Array(K).fill(0));
  const gammaSum = new Array(K).fill(0);
  for (let t = 0; t < T - 1; t += 1) {
    for (let i = 0; i < K; i += 1) gammaSum[i] += gamma[t][i];
    const vals = [];
    for (let i = 0; i < K; i += 1) {
      for (let j = 0; j < K; j += 1) {
        vals.push(alpha[t][i] + logTrans[i][j] + logEmit[t + 1][j] + beta[t + 1][j] - logLik);
      }
    }
    let idx = 0;
    const max = Math.max(...vals);
    let denom = 0;
    for (const v of vals) denom += Math.exp(v - max);
    const logDenom = max + Math.log(denom || 1);
    for (let i = 0; i < K; i += 1) {
      for (let j = 0; j < K; j += 1) {
        const v = alpha[t][i] + logTrans[i][j] + logEmit[t + 1][j] + beta[t + 1][j] - logLik;
        xiSum[i][j] += Math.exp(v - logDenom);
        idx += 1;
      }
    }
  }
  gamma[T - 1] && (gammaSum[0] += gamma[T - 1][0]); // keep reference alive

  return { logLik, gamma, xiSum, gammaSum, logEmit };
}

function viterbi(matrix, start, trans, means, vars) {
  const T = matrix.length;
  const K = start.length;
  const logStart = start.map((p) => Math.log(Math.max(p, 1e-12)));
  const logTrans = trans.map((row) => row.map((p) => Math.log(Math.max(p, 1e-12))));
  const emit = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let t = 0; t < T; t += 1) {
    for (let k = 0; k < K; k += 1) emit[t][k] = gaussianLogPdf(matrix[t], means[k], vars[k]);
  }
  const dp = Array.from({ length: T }, () => new Array(K).fill(Number.NEGATIVE_INFINITY));
  const back = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let k = 0; k < K; k += 1) dp[0][k] = logStart[k] + emit[0][k];
  for (let t = 1; t < T; t += 1) {
    for (let j = 0; j < K; j += 1) {
      let best = Number.NEGATIVE_INFINITY;
      let bestIdx = 0;
      for (let i = 0; i < K; i += 1) {
        const v = dp[t - 1][i] + logTrans[i][j];
        if (v > best) {
          best = v;
          bestIdx = i;
        }
      }
      dp[t][j] = best + emit[t][j];
      back[t][j] = bestIdx;
    }
  }
  let state = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < K; k += 1) {
    if (dp[T - 1][k] > best) {
      best = dp[T - 1][k];
      state = k;
    }
  }
  const path = new Array(T).fill(0);
  path[T - 1] = state;
  for (let t = T - 1; t > 0; t -= 1) path[t - 1] = back[t][path[t]];
  return path;
}

function fitHmm(matrix, initialLabels, k, maxIter = 10) {
  let { start, trans, means, vars } = initGaussianParams(matrix, initialLabels, k);
  let lastLogLik = Number.NEGATIVE_INFINITY;
  let best = null;

  for (let iter = 0; iter < maxIter; iter += 1) {
    const fb = forwardBackward(matrix, start, trans, means, vars);
    const { gamma, xiSum, logLik } = fb;
    if (!Number.isFinite(logLik)) break;

    if (!best || logLik > best.logLik) {
      best = { start: [...start], trans: trans.map((r) => [...r]), means: means.map((r) => [...r]), vars: vars.map((r) => [...r]), logLik };
    }

    const K = start.length;
    const dims = matrix[0].length;
    const gammaTotals = new Array(K).fill(0);
    const meansNext = Array.from({ length: K }, () => new Array(dims).fill(0));
    const varsNext = Array.from({ length: K }, () => new Array(dims).fill(0));

    for (let t = 0; t < matrix.length; t += 1) {
      for (let kIdx = 0; kIdx < K; kIdx += 1) {
        const g = gamma[t][kIdx];
        gammaTotals[kIdx] += g;
        for (let d = 0; d < dims; d += 1) meansNext[kIdx][d] += g * matrix[t][d];
      }
    }
    for (let kIdx = 0; kIdx < K; kIdx += 1) {
      const denom = Math.max(gammaTotals[kIdx], 1e-9);
      for (let d = 0; d < dims; d += 1) meansNext[kIdx][d] /= denom;
    }
    for (let t = 0; t < matrix.length; t += 1) {
      for (let kIdx = 0; kIdx < K; kIdx += 1) {
        const g = gamma[t][kIdx];
        for (let d = 0; d < dims; d += 1) {
          const diff = matrix[t][d] - meansNext[kIdx][d];
          varsNext[kIdx][d] += g * diff * diff;
        }
      }
    }
    for (let kIdx = 0; kIdx < K; kIdx += 1) {
      const denom = Math.max(gammaTotals[kIdx], 1e-9);
      for (let d = 0; d < dims; d += 1) varsNext[kIdx][d] = Math.max(varsNext[kIdx][d] / denom, 1e-4);
    }

    start = gamma[0].map((g) => Math.max(g, 1e-12));
    const startSum = start.reduce((s, x) => s + x, 0) || 1;
    start = start.map((x) => x / startSum);

    trans = trans.map((row, i) => {
      const denom = Math.max(gammaTotals[i], 1e-9);
      const next = row.map((_, j) => (xiSum[i][j] + 1e-6) / (denom + K * 1e-6));
      const sum = next.reduce((s, x) => s + x, 0) || 1;
      return next.map((x) => x / sum);
    });

    means = meansNext;
    vars = varsNext;
    if (Math.abs(logLik - lastLogLik) < 1e-4) break;
    lastLogLik = logLik;
  }

  const finalModel = best || { start, trans, means, vars, logLik: lastLogLik };
  const gammaRun = forwardBackward(matrix, finalModel.start, finalModel.trans, finalModel.means, finalModel.vars);
  const path = viterbi(matrix, finalModel.start, finalModel.trans, finalModel.means, finalModel.vars);
  const confidence = gammaRun.gamma.map((row) => Math.max(...row));

  return {
    ...finalModel,
    path,
    confidence,
    logLik: gammaRun.logLik,
    gamma: gammaRun.gamma,
  };
}

function stateMeanFeatures(featureRows, path, featureNames, k) {
  const out = Array.from({ length: k }, () => {
    const row = { count: 0 };
    for (const f of featureNames) row[f] = 0;
    return row;
  });
  for (let i = 0; i < featureRows.length; i += 1) {
    const state = path[i];
    const target = out[state];
    if (!target) continue;
    target.count += 1;
    for (const f of featureNames) target[f] += safeNum(featureRows[i][f], 0);
  }
  return out.map((row) => {
    const count = Math.max(1, row.count);
    const averages = {};
    for (const f of featureNames) averages[f] = row[f] / count;
    return { count: row.count, averages };
  });
}

function describeRegime(stateSummary, state) {
  const avg = stateSummary?.averages || {};
  const vol = safeNum(avg.priceVol24, 0);
  const liq = safeNum(avg.liqShock, 0);
  const funding = safeNum(avg.fundingShock, 0);
  const oi = safeNum(avg.oiRet24, 0);
  const cvd = safeNum(avg.cvdRet24, 0);
  const momentum = safeNum(avg.priceRet24, 0);
  const corrOi = safeNum(avg.corrOiPrice24, 0);
  const corrCvd = safeNum(avg.corrCvdPrice24, 0);
  const drawdown = safeNum(avg.maxDrawdown24, 0);
  const absFunding = Math.abs(funding);

  const cascadeScore = Math.max(0, liq) + Math.max(0, vol) + Math.max(0, -momentum) + Math.max(0, -oi) + Math.max(0, -corrOi);
  const trendScore = Math.max(0, momentum) + Math.max(0, oi) + Math.max(0, cvd) + Math.max(0, corrOi) + Math.max(0, corrCvd);
  const chopScore = Math.max(0, -Math.abs(momentum)) + Math.max(0, -Math.abs(oi)) + Math.max(0, -Math.abs(cvd)) + Math.max(0, -Math.abs(funding)) + Math.max(0, -Math.abs(vol - 0.5));
  const crowdLongScore = Math.max(0, funding) + Math.max(0, oi) + Math.max(0, cvd) + Math.max(0, momentum);
  const crowdShortScore = Math.max(0, -funding) + Math.max(0, -momentum) + Math.max(0, -corrOi) + Math.max(0, -corrCvd);

  const scores = {
    cascade: cascadeScore,
    trend: trendScore,
    chop: chopScore,
    crowdLong: crowdLongScore,
    crowdShort: crowdShortScore
  };

  let bestKey = "chop";
  let maxVal = -Infinity;
  for (const [key, val] of Object.entries(scores)) {
    if (val > maxVal) {
      maxVal = val;
      bestKey = key;
    }
  }

  let label = `State ${state + 1}`;
  let strategy = "Không có chiến lược cụ thể được gán";
  let tone = "neutral";

  if (bestKey === "cascade") {
    label = `State ${state + 1} - Cascade Deleveraging (Thanh lý ồ ạt)`;
    strategy = "Thanh lý Long mạnh, biến động cao. Canh mua bắt đáy khi các cú quét thanh lý đạt đỉnh trào cự.";
    tone = "bad";
  } else if (bestKey === "trend") {
    if (momentum > 0) {
      label = `State ${state + 1} - Bullish Momentum (Xu hướng tăng)`;
      strategy = "Xu hướng tăng mạnh. Ưu tiên thuận xu hướng (Trend-following), mua khi giá điều chỉnh (Buy dips).";
      tone = "good";
    } else {
      label = `State ${state + 1} - Bearish Momentum (Xu hướng giảm)`;
      strategy = "Xu hướng giảm mạnh. Ưu tiên thuận xu hướng (Trend-following), bán khi giá hồi phục (Sell rallies).";
      tone = "bad";
    }
  } else if (bestKey === "crowdLong") {
    label = `State ${state + 1} - Overheated Longs (FOMO Long)`;
    strategy = "Tỷ lệ Funding rate dương và OI tăng mạnh. Thận trọng mở thêm vị thế Long; cân nhắc phòng vệ vị thế Spot.";
    tone = "ok";
  } else if (bestKey === "crowdShort") {
    label = `State ${state + 1} - Crowded Shorts (FOMO Short)`;
    strategy = "Tỷ lệ Funding rate âm và lệnh Short tăng quá độ. Có khả năng xảy ra Short Squeeze mạnh; mua lướt sóng nhanh.";
    tone = "ok";
  } else {
    label = `State ${state + 1} - Sideways Chop (Đi ngang biến động thấp)`;
    strategy = "Thị trường đi ngang tích lũy nhiễu. Sử dụng Grid trading hoặc các chỉ báo dao động (Oscillators) mua hỗ trợ bán kháng cự.";
    tone = "neutral";
  }

  return {
    label,
    strategy,
    tone,
    scores: {
      cascadeScore,
      trendScore,
      chopScore,
      crowdLongScore,
      crowdShortScore,
    },
    highlights: {
      vol,
      liq,
      funding,
      oi,
      cvd,
      momentum,
      corrOi,
      corrCvd,
      drawdown,
      absFunding,
    },
  };
}

function tintColor(state, k) {
  const palette = ["#2563eb", "#dc2626", "#16a34a", "#7c3aed", "#d97706", "#0891b2", "#be185d", "#475569"];
  return palette[state % Math.max(1, k)] || "#475569";
}

function buildStateSegments(timeline, chosenK, interval) {
  if (!timeline.length) return { segments: [], durationStats: [] };
  const intervalHours = intervalToMs(interval) / MS.hour;
  const segments = [];
  let startIdx = 0;
  for (let i = 1; i <= timeline.length; i += 1) {
    const changed = i === timeline.length || timeline[i].state !== timeline[startIdx].state;
    if (!changed) continue;
    const start = timeline[startIdx];
    const end = timeline[i - 1];
    const bars = i - startIdx;
    const slice = timeline.slice(startIdx, i);
    const closes = slice.map((row) => safeNum(row.priceClose, NaN)).filter(Number.isFinite);
    const closeRets = closes.map((close, closeIdx) => (
      closeIdx === 0 ? 0 : pctMove(closes[closeIdx - 1], close)
    ));
    const firstClose = closes[0] || 0;
    const lastClose = closes[closes.length - 1] || firstClose;
    const minClose = closes.length ? Math.min(...closes) : 0;
    const maxClose = closes.length ? Math.max(...closes) : 0;
    segments.push({
      state: start.state,
      label: `State ${start.state + 1}`,
      color: tintColor(start.state, chosenK),
      startTime: start.time,
      endTime: end.time,
      startTimestamp: start.timestamp,
      endTimestamp: end.timestamp,
      bars,
      hours: bars * intervalHours,
      share: bars / timeline.length,
      avgConfidence: mean(slice.map((row) => row.confidence)),
      priceReturn: pctMove(firstClose, lastClose),
      closeRange: firstClose ? (maxClose - minClose) / firstClose : 0,
      realizedVol: sampleStd(closeRets),
      avgPriceVol24: mean(slice.map((row) => row.priceVol24)),
      avgLiqShock: mean(slice.map((row) => row.liqShock)),
      avgFundingShock: mean(slice.map((row) => row.fundingShock)),
      avgOiRet24: mean(slice.map((row) => row.oiRet24)),
    });
    startIdx = i;
  }

  const durationStats = Array.from({ length: chosenK }, (_, state) => {
    const items = segments.filter((segment) => segment.state === state);
    const hours = items.map((segment) => segment.hours);
    return {
      state,
      label: `State ${state + 1}`,
      color: tintColor(state, chosenK),
      runs: items.length,
      avgHours: mean(hours),
      medianHours: quantile(hours, 0.5),
      maxHours: hours.length ? Math.max(...hours) : 0,
      totalHours: hours.reduce((sum, value) => sum + value, 0),
    };
  });

  return { segments, durationStats };
}

function parseCsvLine(line) {
  const out = [];
  let curr = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (quoted && line[i + 1] === "\"") {
        curr += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(curr);
      curr = "";
      continue;
    }
    curr += ch;
  }
  out.push(curr);
  return out;
}

function readCsvObjects(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function rowToMergedRegime(row) {
  const tsRaw = row.timestamp || row.time || row.ts || row.datetime_utc;
  const numericTs = safeNum(tsRaw, NaN);
  const ts = Number.isFinite(numericTs)
    ? (numericTs > 1e12 ? numericTs : numericTs * 1000)
    : Date.parse(String(tsRaw || ""));
  if (!Number.isFinite(ts)) return null;

  const price = {
    open: safeNum(row.price_open, 0),
    high: safeNum(row.price_high, 0),
    low: safeNum(row.price_low, 0),
    close: safeNum(row.price_close, 0),
  };
  return {
    ts,
    timestamp: new Date(ts).toISOString(),
    price,
    liquidation: {
      timestamp: ts,
      longUsd: safeNum(row.liquidation_long_usd, 0),
      shortUsd: safeNum(row.liquidation_short_usd, 0),
      totalUsd: safeNum(row.liquidation_total_usd, safeNum(row.liquidation_long_usd, 0) + safeNum(row.liquidation_short_usd, 0)),
    },
    funding: {
      timestamp: ts,
      open: safeNum(row.funding_open, 0),
      high: safeNum(row.funding_high, 0),
      low: safeNum(row.funding_low, 0),
      close: safeNum(row.funding_close, 0),
    },
    oi: {
      timestamp: ts,
      open: safeNum(row.oi_open, 0),
      high: safeNum(row.oi_high, 0),
      low: safeNum(row.oi_low, 0),
      close: safeNum(row.oi_close, 0),
    },
    oiWeight: {
      timestamp: ts,
      open: safeNum(row.oi_weight_open, 0),
      high: safeNum(row.oi_weight_high, 0),
      low: safeNum(row.oi_weight_low, 0),
      close: safeNum(row.oi_weight_close, 0),
    },
    cvd: {
      timestamp: ts,
      open: safeNum(row.cvd_open, 0),
      high: safeNum(row.cvd_high, 0),
      low: safeNum(row.cvd_low, 0),
      close: safeNum(row.cvd_close, 0),
    },
  };
}

function inferIntervalFromRows(rows) {
  if (rows.length < 3) return "1h";
  const deltas = [];
  for (let i = 1; i < rows.length; i += 1) {
    const d = rows[i].ts - rows[i - 1].ts;
    if (d > 0) deltas.push(d);
  }
  const step = quantile(deltas, 0.5);
  if (step <= 1.5 * MS.min) return "1m";
  if (step <= 3.5 * MS.min) return "3m";
  if (step <= 5.5 * MS.min) return "5m";
  if (step <= 15.5 * MS.min) return "15m";
  if (step <= 30.5 * MS.min) return "30m";
  if (step <= 65 * MS.min) return "1h";
  if (step <= 4.1 * MS.hour) return "4h";
  if (step <= 24.5 * MS.hour) return "1d";
  return `${Math.round(step / MS.min)}m`;
}

function hoursToSteps(hours, interval) {
  const ms = intervalToMs(interval);
  if (ms <= 0) return hours;
  return Math.round((hours * MS.hour) / ms);
}

function matrixMultiply(A, B) {
  const K = A.length;
  const C = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      let sum = 0;
      for (let k = 0; k < K; k++) {
        sum += A[i][k] * B[k][j];
      }
      C[i][j] = sum;
    }
  }
  return C;
}

function matrixPower(matrix, power) {
  let result = matrix.map(row => [...row]);
  for (let p = 1; p < power; p++) {
    result = matrixMultiply(result, matrix);
  }
  return result;
}

function computeValidationStats(candles, path, chosenK, interval) {
  const steps24 = intervalBarsPerDay(interval);
  const steps72 = steps24 * 3;
  const N = candles.length;
  
  const closes = candles.map(c => safeNum(c.price?.close ?? c.close, 0));
  const highs = candles.map(c => safeNum(c.price?.high ?? c.high ?? (c.price?.close ?? c.close), 0));
  const lows = candles.map(c => safeNum(c.price?.low ?? c.low ?? (c.price?.close ?? c.close), 0));
  
  const rets = closes.map((close, i) => i === 0 ? 0 : (close - closes[i - 1]) / closes[i - 1]);
  
  const stateData = Array.from({ length: chosenK }, () => ({
    vol24: [],
    vol72: [],
    dd24: [],
    dd72: [],
    range24: [],
    range72: [],
    ret24: [],
    ret72: [],
    liq24: [],
    liq72: []
  }));
  
  for (let idx = 0; idx < N; idx++) {
    const state = path[idx];
    if (state === undefined || state < 0 || state >= chosenK) continue;
    
    if (idx + steps24 < N) {
      const windowRets = rets.slice(idx + 1, idx + steps24 + 1);
      const vol = sampleStd(windowRets);
      stateData[state].vol24.push(vol);
      
      let minLow = Infinity;
      let sumLiq = 0;
      for (let j = idx + 1; j <= idx + steps24; j++) {
        minLow = Math.min(minLow, lows[j]);
        sumLiq += safeNum(candles[j].liquidation?.totalUsd ?? candles[j].liquidation_total_usd, 0);
      }
      const close = closes[idx];
      const dd = close > 0 ? (minLow - close) / close : 0;
      stateData[state].dd24.push(dd);
      
      let maxHigh = -Infinity;
      let minL = Infinity;
      for (let j = idx + 1; j <= idx + steps24; j++) {
        maxHigh = Math.max(maxHigh, highs[j]);
        minL = Math.min(minL, lows[j]);
      }
      const range = close > 0 ? (maxHigh - minL) / close : 0;
      stateData[state].range24.push(range);

      const futRet = close > 0 ? (closes[idx + steps24] - close) / close : 0;
      stateData[state].ret24.push(futRet);
      stateData[state].liq24.push(sumLiq);
    }
    
    if (idx + steps72 < N) {
      const windowRets = rets.slice(idx + 1, idx + steps72 + 1);
      const vol = sampleStd(windowRets);
      stateData[state].vol72.push(vol);
      
      let minLow = Infinity;
      let sumLiq = 0;
      for (let j = idx + 1; j <= idx + steps72; j++) {
        minLow = Math.min(minLow, lows[j]);
        sumLiq += safeNum(candles[j].liquidation?.totalUsd ?? candles[j].liquidation_total_usd, 0);
      }
      const close = closes[idx];
      const dd = close > 0 ? (minLow - close) / close : 0;
      stateData[state].dd72.push(dd);
      
      let maxHigh = -Infinity;
      let minL = Infinity;
      for (let j = idx + 1; j <= idx + steps72; j++) {
        maxHigh = Math.max(maxHigh, highs[j]);
        minL = Math.min(minL, lows[j]);
      }
      const range = close > 0 ? (maxHigh - minL) / close : 0;
      stateData[state].range72.push(range);

      const futRet = close > 0 ? (closes[idx + steps72] - close) / close : 0;
      stateData[state].ret72.push(futRet);
      stateData[state].liq72.push(sumLiq);
    }
  }
  
  const getBoxStats = (arr) => {
    if (!arr.length) return { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, count: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      min: sorted[0],
      q1: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      q3: quantile(sorted, 0.75),
      max: sorted[sorted.length - 1],
      mean: mean(sorted),
      count: sorted.length
    };
  };
  
  return stateData.map((data, state) => {
    const ret24Stats = getBoxStats(data.ret24);
    const ret72Stats = getBoxStats(data.ret72);
    
    ret24Stats.winRate = data.ret24.length ? data.ret24.filter(r => r > 0).length / data.ret24.length : 0;
    ret72Stats.winRate = data.ret72.length ? data.ret72.filter(r => r > 0).length / data.ret72.length : 0;

    return {
      state,
      label: `State ${state + 1}`,
      color: tintColor(state, chosenK),
      vol24: getBoxStats(data.vol24),
      vol72: getBoxStats(data.vol72),
      dd24: getBoxStats(data.dd24),
      dd72: getBoxStats(data.dd72),
      range24: getBoxStats(data.range24),
      range72: getBoxStats(data.range72),
      ret24: ret24Stats,
      ret72: ret72Stats,
      liq24: getBoxStats(data.liq24),
      liq72: getBoxStats(data.liq72),
    };
  });
}

function buildEmpiricalDurationTransitions(path, chosenK, baseTrans) {
  const N = path.length;
  const counts = Array.from({ length: chosenK }, () => ({}));
  const transitions = Array.from({ length: chosenK }, () => ({}));

  let currentRunState = path[0];
  let currentDuration = 1;

  for (let i = 1; i < N; i++) {
    const s = path[i - 1];
    const nextS = path[i];

    if (!counts[s][currentDuration]) {
      counts[s][currentDuration] = 0;
      transitions[s][currentDuration] = Array(chosenK).fill(0);
    }
    counts[s][currentDuration]++;
    transitions[s][currentDuration][nextS]++;

    if (nextS === currentRunState) {
      currentDuration++;
    } else {
      currentRunState = nextS;
      currentDuration = 1;
    }
  }

  // Record final state run step
  const lastS = path[N - 1];
  if (!counts[lastS][currentDuration]) {
    counts[lastS][currentDuration] = 0;
    transitions[lastS][currentDuration] = Array(chosenK).fill(0);
  }
  counts[lastS][currentDuration]++;
  transitions[lastS][currentDuration][lastS]++;

  // Convert to probabilities with Bayesian Laplace smoothing
  const m = 8;
  const empiricalProbs = Array.from({ length: chosenK }, () => ({}));

  for (let s = 0; s < chosenK; s++) {
    const sBaseTrans = baseTrans[s] || Array(chosenK).fill(1 / chosenK);
    const durations = Object.keys(counts[s]).map(Number).sort((a, b) => a - b);

    for (const d of durations) {
      const totalCount = counts[s][d];
      const nextCounts = transitions[s][d];

      const probs = Array(chosenK).fill(0);
      let sum = 0;
      for (let ns = 0; ns < chosenK; ns++) {
        const val = nextCounts[ns] + m * (sBaseTrans[ns] || 0);
        probs[ns] = val;
        sum += val;
      }

      empiricalProbs[s][d] = probs.map(v => sum > 0 ? v / sum : sBaseTrans[ns]);
    }
  }

  return empiricalProbs;
}

function buildRegimeResultFromMerged({
  merged,
  candles,
  interval,
  maxK = 6,
  fitK = null,
  hmmIterations = 10,
  selectedFeatures = null,
  meta = {},
}) {
  if (merged.length < 50) {
    throw new Error("Not enough aligned market data to build regimes.");
  }

  const featureRows = buildFeatureRows(merged, interval);
  const featureNames = buildFeatureNames(selectedFeatures);
  const { matrix, stats } = standardizeMatrix(featureRows, featureNames);
  const kSelection = pickBestK(matrix, maxK, hmmIterations);
  const { best: bestKCandidate, candidates } = kSelection;
  const requestedK = Number(fitK);
  const chosenK = Number.isFinite(requestedK) && requestedK >= 2
    ? Math.max(2, Math.min(Math.round(requestedK), matrix.length))
    : (bestKCandidate?.k || Math.min(4, matrix.length));
  const initialKMeans = candidates.find((c) => c.k === chosenK) || kmeans(matrix, chosenK, 20);
  const hmm = fitHmm(matrix, initialKMeans.labels, chosenK, hmmIterations);
  const path = hmm.path;
  const confidence = hmm.confidence;
  const empiricalTransitions = buildEmpiricalDurationTransitions(path, chosenK, hmm.trans);
  const perState = stateMeanFeatures(featureRows, path, featureNames, chosenK);
  const labels = perState.map((summary, state) => describeRegime(summary, state));

  const steps6 = Math.max(1, hoursToSteps(6, interval));
  const steps12 = Math.max(1, hoursToSteps(12, interval));
  const steps24 = Math.max(1, hoursToSteps(24, interval));

  const T_6 = matrixPower(hmm.trans, steps6);
  const T_12 = matrixPower(hmm.trans, steps12);
  const T_24 = matrixPower(hmm.trans, steps24);

  const transitions = Array.from({ length: chosenK }, (_, i) => {
    const row = hmm.trans[i] || [];
    return row.map((p, j) => ({
      from: i,
      to: j,
      p,
      color: tintColor(j, chosenK),
    }));
  });

  const timeline = featureRows.map((row, idx) => ({
    time: Math.floor(row.ts / 1000),
    timestamp: row.timestamp,
    state: path[idx],
    confidence: confidence[idx],
    stateProbs: hmm.gamma[idx].map((p, state) => ({
      state,
      label: `State ${state + 1}`,
      probability: p,
      color: tintColor(state, chosenK),
    })),
    color: tintColor(path[idx], chosenK),
    priceClose: row.priceClose,
    liqTotal: row.liqTotal,
    fundingClose: row.fundingClose,
    oiClose: row.oiClose,
    cvdClose: row.cvdClose,
    liqShock: row.liqShock,
    fundingShock: row.fundingShock,
    priceVol24: row.priceVol24,
    oiRet24: row.oiRet24,
    cvdRet24: row.cvdRet24,
    corrOiPrice24: row.corrOiPrice24,
    corrCvdPrice24: row.corrCvdPrice24,
  }));

  const stateRows = labels.map((labelMeta, state) => {
    const summary = perState[state] || { count: 0, averages: {} };
    const share = featureRows.length ? summary.count / featureRows.length : 0;
    return {
      state,
      count: summary.count,
      share,
      color: tintColor(state, chosenK),
      label: labelMeta.label,
      strategy: labelMeta.strategy,
      tone: labelMeta.tone,
      scores: labelMeta.scores,
      highlights: labelMeta.highlights,
      averages: summary.averages,
      confidence: mean(timeline.filter((x) => x.state === state).map((x) => x.confidence)),
      avgForwardReturn: 0,
      projections: {
        "6h": T_6[state].map((p, j) => ({
          state: j,
          label: `State ${j + 1}`,
          p,
          color: tintColor(j, chosenK),
        })),
        "12h": T_12[state].map((p, j) => ({
          state: j,
          label: `State ${j + 1}`,
          p,
          color: tintColor(j, chosenK),
        })),
        "24h": T_24[state].map((p, j) => ({
          state: j,
          label: `State ${j + 1}`,
          p,
          color: tintColor(j, chosenK),
        })),
      }
    };
  });

  const latest = timeline[timeline.length - 1];
  const latestState = stateRows[latest?.state] || null;
  const { segments, durationStats } = buildStateSegments(timeline, chosenK, interval);
  const pca = buildPcaProjection(matrix, timeline, chosenK);
  const stateDistances = buildStateDistanceMatrix(matrix, path, chosenK);
  const avgConfidence = mean(timeline.map((row) => row.confidence));
  const lowConfidenceShare = timeline.length
    ? timeline.filter((row) => row.confidence < 0.75).length / timeline.length
    : 0;
  const scatter = timeline
    .filter((_, idx) => idx % Math.max(1, Math.floor(timeline.length / 900)) === 0)
    .map((row) => ({
      state: row.state,
      color: row.color,
      time: row.time,
      timestamp: row.timestamp,
      x: row.priceVol24,
      y: row.liqShock,
      confidence: row.confidence,
    }));

  const validationStats = computeValidationStats(merged, path, chosenK, interval);

  return {
    validationStats,
    empiricalTransitions,
    meta: {
      rows: merged.length,
      featureRows: featureRows.length,
      interval,
      startTime: merged[0]?.timestamp ?? null,
      endTime: merged.at(-1)?.timestamp ?? null,
      chosenK,
      maxK,
      candidateKs: candidates.map((c) => ({
        k: c.k,
        inertia: c.inertia,
        silhouette: c.silhouette,
        elbowDrop: c.elbowDrop,
        logLik: c.logLik,
        aic: c.aic,
	        bic: c.bic,
	        persistence: c.persistence,
	        balance: c.balance,
	        minShare: c.minShare,
	        maxShare: c.maxShare,
	        interpretability: c.interpretability,
	        score: c.score,
	      })),
	      kSelection: {
	        method: Number.isFinite(requestedK) && requestedK >= 2 ? "manual" : "balanced-score",
	        fitK: chosenK,
	        chosenBySilhouette: kSelection.bestSilhouette?.k ?? null,
	        chosenByElbow: kSelection.bestElbow?.k ?? null,
	        chosenByAIC: kSelection.bestAIC?.k ?? null,
	        chosenByBIC: kSelection.bestBIC?.k ?? null,
	        chosenByInterpretability: kSelection.bestInterpretability?.k ?? null,
	        chosenByScore: kSelection.bestScore?.k ?? null,
	        usableK: kSelection.usableCandidates?.map((row) => row.k) || [],
	        note: "Fit K controls the HMM state count. Auto uses a balanced score that penalizes tiny or dominant outlier states; silhouette, elbow, AIC, BIC, and interpretability are diagnostics.",
	      },
      logLik: hmm.logLik,
      iterations: hmmIterations,
      selectedFeatures: featureNames,
      selectedFeatureCount: featureNames.length,
      availableFeatures: ALL_FEATURE_NAMES,
      ...meta,
    },
    featureNames,
    featureStats: stats,
    timeline,
    segments,
    durationStats,
    diagnostics: {
      scatter,
      pca,
      stateDistances,
      quality: {
        avgConfidence,
        lowConfidenceShare,
        minNearestCenterDistance: stateDistances.nearest.length ? Math.min(...stateDistances.nearest) : 0,
      },
      scatterAxes: {
        x: "priceVol24",
        y: "liqShock",
      },
    },
    states: stateRows,
    transitions,
    latest: {
      state: latest?.state ?? 0,
      label: latestState?.label || "Unknown state",
      strategy: latestState?.strategy || "No strategy label assigned",
      confidence: latest?.confidence ?? 0,
      color: latest?.color || "#475569",
      timestamp: latest?.timestamp || null,
      scores: latestState?.scores || null,
      highlights: latestState?.highlights || null,
    },
    chart: {
      candles: candles.map((c) => ({
        time: Math.floor(c.timestamp / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
      markers: timeline
        .filter((row, idx) => idx === 0 || row.state !== timeline[idx - 1].state)
        .map((row) => ({
          time: row.time,
          position: (row.state % 2 === 1) ? "aboveBar" : "belowBar",
          color: row.color,
          shape: "circle",
          text: "",
        })),
    },
  };
}

export function listPhatich4RegimeDatasets() {
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir)
    .filter((file) => /^coinglass_BTC_regime_.*\.csv$/i.test(file))
    .map((file) => {
      try {
        const stat = fs.statSync(path.join(dataDir, file));
        return { file, mtime: stat.mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((item) => item.file);
}

export function buildPhatich4RegimeAnalysisFromDataset({
  dataset,
  maxK = 6,
  fitK = null,
  hmmIterations = 10,
  selectedFeatures = null,
}) {
  const datasets = listPhatich4RegimeDatasets();
  const chosen = dataset && datasets.includes(dataset) ? dataset : datasets[0];
  if (!chosen) {
    throw new Error("No local phatich4 regime dataset found in data/.");
  }

  const filePath = path.join(process.cwd(), "data", chosen);
  const rows = readCsvObjects(filePath)
    .map(rowToMergedRegime)
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);
  const interval = inferIntervalFromRows(rows);
  const candles = rows.map((row) => ({ timestamp: row.ts, ...row.price }));

  return buildRegimeResultFromMerged({
    merged: rows,
    candles,
    interval,
    maxK,
    fitK,
    hmmIterations,
    selectedFeatures,
    meta: {
      source: "local",
      dataset: chosen,
      datasetPath: filePath,
    },
  });
}

export async function buildPhatich4RegimeAnalysis({
  apiKey,
  years = 1,
  interval = "1h",
  exchangeList = "Binance,Bybit,OKX",
  symbol = "BTC",
  maxK = 6,
  fitK = null,
  hmmIterations = 10,
  selectedFeatures = null,
}) {
  if (!apiKey) {
    throw new Error("Missing COINGLASS_API_KEY in environment.");
  }

  const intervalMs = intervalToMs(interval);
  const endMs = Date.now();
  const lookbackYears = Math.max(0.05, safeNum(years, 1));
  const startMs = endMs - lookbackYears * 365 * MS.day;
  const chunkLimit = 1000;

  const liquidationBase = `${CG_BASE}/futures/liquidation/aggregated-history`;
  const oiBase = `${CG_BASE}/futures/open-interest/history`;
  const fundingBase = `${CG_BASE}/futures/funding-rate/history`;
  const oiWeightBase = `${CG_BASE}/futures/funding-rate/oi-weight-history`;
  const cvdBase = `${CG_BASE}/futures/aggregated-cvd/history`;

  const chunks = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(endMs, cursor + intervalMs * chunkLimit);
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = chunkEnd + intervalMs;
  }

  const liquidation = [];
  const oi = [];
  const funding = [];
  const oiWeight = [];
  const cvd = [];
  const candles = [];

  for (const chunk of chunks) {
    const [liqRows, oiRows, fundingRows, oiWeightRows, cvdRows, candleRows] = await Promise.all([
      fetchChunkedSeries({
        apiKey,
        baseUrl: liquidationBase,
        params: { exchange_list: exchangeList, symbol, unit: "usd" },
        interval,
        startMs: chunk.start,
        endMs: chunk.end,
        limit: chunkLimit,
        normalize: normalizeLiquidation,
      }),
      fetchChunkedSeries({
        apiKey,
        baseUrl: oiBase,
        params: { exchange: "Binance", symbol: "BTCUSDT", unit: "usd" },
        interval,
        startMs: chunk.start,
        endMs: chunk.end,
        limit: chunkLimit,
        normalize: normalizeOhlc,
      }),
      fetchChunkedSeries({
        apiKey,
        baseUrl: fundingBase,
        params: { exchange: "Binance", symbol: "BTCUSDT" },
        interval,
        startMs: chunk.start,
        endMs: chunk.end,
        limit: chunkLimit,
        normalize: normalizeOhlc,
      }),
      fetchChunkedSeries({
        apiKey,
        baseUrl: oiWeightBase,
        params: { symbol: "BTC" },
        interval,
        startMs: chunk.start,
        endMs: chunk.end,
        limit: chunkLimit,
        normalize: normalizeOhlc,
      }),
      fetchChunkedSeries({
        apiKey,
        baseUrl: cvdBase,
        params: { exchange_list: exchangeList, symbol: "BTC", unit: "usd" },
        interval,
        startMs: chunk.start,
        endMs: chunk.end,
        limit: chunkLimit,
        normalize: normalizeOhlc,
      }),
      fetchBinanceCandles({ startMs: chunk.start, endMs: chunk.end, interval }),
    ]);

    liquidation.push(...liqRows);
    oi.push(...oiRows);
    funding.push(...fundingRows);
    oiWeight.push(...oiWeightRows);
    cvd.push(...cvdRows);
    candles.push(...candleRows);
  }

  const merged = mergeSeries({ liquidation, funding, oi, oiWeight, cvd, candles, interval });
  return buildRegimeResultFromMerged({
    merged,
    candles,
    interval,
    maxK,
    fitK,
    hmmIterations,
    selectedFeatures,
    meta: {
      source: "api",
      years,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    },
  });
}

export async function ensureDatasetUpToDate(datasetName) {
  const datasets = listPhatich4RegimeDatasets();
  const chosen = datasetName && datasets.includes(datasetName) ? datasetName : datasets[0];
  if (!chosen) return;

  const filePath = path.join(process.cwd(), "data", chosen);
  const metaPath = filePath + ".meta.json";

  // Read current CSV file
  let currentRows = [];
  try {
    currentRows = readCsvObjects(filePath);
  } catch (err) {
    console.error("Error reading current CSV in ensureDatasetUpToDate:", err);
    return;
  }

  if (!currentRows.length) return;

  const lastRow = currentRows[currentRows.length - 1];
  const lastTs = safeNum(lastRow.timestamp, 0);
  const now = Date.now();

  // If the last timestamp is less than 10 minutes old, no need to update
  if (now - lastTs < 10 * MS.min) {
    return;
  }

  console.log(`[Regime Update] Dataset ${chosen} is outdated. Last TS: ${new Date(lastTs).toISOString()}. Fetching incremental data...`);

  try {
    const symbol = "BTCUSDT";
    const interval = "5m";
    const intervalMs = 5 * MS.min;

    // We fetch incremental candles from lastTs to now
    const newCandles = [];
    let fetchStart = lastTs + intervalMs;
    while (fetchStart < now) {
      const url = new URL("https://fapi.binance.com/fapi/v1/klines");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(fetchStart));
      url.searchParams.set("limit", "1000");

      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Binance Futures Klines HTTP ${res.status}: ${await res.text()}`);
      }
      const rawKlines = await res.json();
      if (!Array.isArray(rawKlines) || rawKlines.length === 0) break;

      for (const row of rawKlines) {
        newCandles.push({
          ts: safeNum(row[0], 0),
          open: safeNum(row[1], 0),
          high: safeNum(row[2], 0),
          low: safeNum(row[3], 0),
          close: safeNum(row[4], 0),
          volume: safeNum(row[5], 0),
          takerBuyVolume: safeNum(row[9], 0),
        });
      }

      fetchStart = safeNum(rawKlines[rawKlines.length - 1][0], fetchStart) + intervalMs;
      if (rawKlines.length < 1000) break;
    }

    if (!newCandles.length) {
      console.log("[Regime Update] No new candles returned.");
      return;
    }

    // Now fetch Open Interest history from Binance Futures API
    const newOI = [];
    let oiStart = lastTs + intervalMs;
    while (oiStart < now) {
      const url = new URL("https://fapi.binance.com/futures/data/openInterestHist");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("period", interval);
      url.searchParams.set("startTime", String(oiStart));
      url.searchParams.set("limit", "500");

      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        console.warn(`[Regime Update] Warning: Failed to fetch Binance OI: ${res.status}`);
        break;
      }
      const rawOI = await res.json();
      if (!Array.isArray(rawOI) || rawOI.length === 0) break;

      for (const row of rawOI) {
        newOI.push({
          ts: safeNum(row.timestamp, 0),
          oi: safeNum(row.sumOpenInterestValue, 0),
        });
      }

      oiStart = safeNum(rawOI[rawOI.length - 1].timestamp, oiStart) + intervalMs;
      if (rawOI.length < 500) break;
    }
    const oiMap = new Map(newOI.map(o => [o.ts, o.oi]));

    // Now fetch Funding Rate from Binance Futures API
    const fundingRates = [];
    const fundingUrl = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
    fundingUrl.searchParams.set("symbol", symbol);
    fundingUrl.searchParams.set("startTime", String(lastTs));
    fundingUrl.searchParams.set("limit", "100");
    const fundingRes = await fetch(fundingUrl.toString(), { cache: "no-store" });
    if (fundingRes.ok) {
      const rawFunding = await fundingRes.json();
      if (Array.isArray(rawFunding)) {
        for (const row of rawFunding) {
          fundingRates.push({
            ts: safeNum(row.fundingTime, 0),
            rate: safeNum(row.fundingRate, 0),
          });
        }
      }
    }
    fundingRates.sort((a, b) => a.ts - b.ts);

    // Now fetch 1-hour liquidations from Coinglass if API key is present
    const hourlyLiqMap = new Map();
    const apiKey = process.env.COINGLASS_API_KEY;
    if (apiKey) {
      try {
        const liqUrl = new URL("https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history");
        liqUrl.searchParams.set("exchange_list", "Binance");
        liqUrl.searchParams.set("symbol", "BTC");
        liqUrl.searchParams.set("unit", "usd");
        liqUrl.searchParams.set("interval", "1h");
        liqUrl.searchParams.set("startTime", String(lastTs));
        liqUrl.searchParams.set("endTime", String(now));
        liqUrl.searchParams.set("limit", "1000");

        const liqRes = await fetch(liqUrl.toString(), {
          headers: { "coinglass-secret": apiKey },
          cache: "no-store",
        });
        if (liqRes.ok) {
          const body = await liqRes.json();
          const list = body?.data || [];
          if (Array.isArray(list)) {
            for (const item of list) {
              const itemTs = safeNum(item.createTime || item.ts || item.t, 0);
              const buyQty = safeNum(item.buyQty || item.longVolUsd || item.l, 0);
              const sellQty = safeNum(item.sellQty || item.shortVolUsd || item.s, 0);
              hourlyLiqMap.set(itemTs, { long: buyQty, short: sellQty });
            }
          }
        }
      } catch (err) {
        console.warn("[Regime Update] Warning: Failed to fetch Coinglass hourly liquidations:", err);
      }
    }

    // Now build CVD starting from the lastRow's cvd_close value
    let currentCvd = safeNum(lastRow.cvd_close, 0);

    let lastKnownOi = safeNum(lastRow.oi_close, 7700000000);
    let lastKnownFunding = safeNum(lastRow.funding_close, 0.0001);

    const mergedRows = [];
    for (const candle of newCandles) {
      const oiVal = oiMap.get(candle.ts) ?? lastKnownOi;
      lastKnownOi = oiVal;

      let fundingVal = lastKnownFunding;
      for (const fr of fundingRates) {
        if (fr.ts <= candle.ts) {
          fundingVal = fr.rate;
        } else {
          break;
        }
      }
      lastKnownFunding = fundingVal;

      const hourTs = Math.floor(candle.ts / MS.hour) * MS.hour;
      const hourlyLiq = hourlyLiqMap.get(hourTs) || { long: 0, short: 0 };
      const longLiq = hourlyLiq.long / 12;
      const shortLiq = hourlyLiq.short / 12;
      const totalLiq = longLiq + shortLiq;

      const delta = 2 * candle.takerBuyVolume - candle.volume;
      currentCvd += delta;

      mergedRows.push({
        timestamp: candle.ts,
        datetime_utc: new Date(candle.ts).toISOString(),
        price_open: candle.open,
        price_high: candle.high,
        price_low: candle.low,
        price_close: candle.close,
        liquidation_long_usd: longLiq,
        liquidation_short_usd: shortLiq,
        liquidation_total_usd: totalLiq,
        funding_open: fundingVal,
        funding_high: fundingVal,
        funding_low: fundingVal,
        funding_close: fundingVal,
        oi_open: oiVal,
        oi_high: oiVal,
        oi_low: oiVal,
        oi_close: oiVal,
        oi_weight_open: fundingVal,
        oi_weight_high: fundingVal,
        oi_weight_low: fundingVal,
        oi_weight_close: fundingVal,
        cvd_open: currentCvd,
        cvd_high: currentCvd,
        cvd_low: currentCvd,
        cvd_close: currentCvd,
      });
    }

    console.log(`[Regime Update] Appending ${mergedRows.length} new 5m rows to ${chosen}...`);

    let combined = [...currentRows, ...mergedRows];

    if (combined.length > 5000) {
      combined = combined.slice(-4320);
    }

    const headers = [
      "timestamp", "datetime_utc", "price_open", "price_high", "price_low", "price_close",
      "liquidation_long_usd", "liquidation_short_usd", "liquidation_total_usd",
      "funding_open", "funding_high", "funding_low", "funding_close",
      "oi_open", "oi_high", "oi_low", "oi_close",
      "oi_weight_open", "oi_weight_high", "oi_weight_low", "oi_weight_close",
      "cvd_open", "cvd_high", "cvd_low", "cvd_close"
    ];

    const csvContent = [
      headers.join(","),
      ...combined.map(row => headers.map(h => row[h]).join(","))
    ].join("\n") + "\n";

    fs.writeFileSync(filePath, csvContent, "utf8");

    const meta = {
      generatedAt: new Date().toISOString(),
      requested: {
        interval: "5m",
        days: 14,
        symbol: "BTCUSDT",
        startIso: new Date(safeNum(combined[0].timestamp, 0)).toISOString(),
        endIso: new Date(safeNum(combined[combined.length - 1].timestamp, 0)).toISOString()
      },
      merged: {
        rows: combined.length,
        firstIso: new Date(safeNum(combined[0].timestamp, 0)).toISOString(),
        lastIso: new Date(safeNum(combined[combined.length - 1].timestamp, 0)).toISOString()
      }
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    console.log(`[Regime Update] Successfully updated ${chosen} and its metadata. New last time: ${meta.merged.lastIso}`);
  } catch (err) {
    console.error("[Regime Update] Error updating dataset:", err);
  }
}

export {
  intervalToMs,
  intervalBarsPerDay,
  roundToIntervalMs,
  mean,
  std,
  quantile,
  sigmoid,
};
