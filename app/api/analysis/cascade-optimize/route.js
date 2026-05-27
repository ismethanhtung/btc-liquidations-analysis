import { NextResponse } from "next/server";

function quantile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
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

function frange(start, end, step) {
  const out = [];
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0) return out;
  for (let x = start; x <= end + 1e-12; x += step) out.push(Number(x.toFixed(6)));
  return out;
}

function medianStepMs(candles, rows) {
  const src = candles.length > 10 ? candles : rows.map((r) => ({ time: Math.floor(r.ts / 1000) }));
  if (src.length < 3) return 3600000;
  const deltas = [];
  for (let i = 1; i < src.length; i += 1) {
    const prev = Number(src[i - 1].time) * 1000;
    const curr = Number(src[i].time) * 1000;
    const d = curr - prev;
    if (d > 0) deltas.push(d);
  }
  return quantile(deltas, 0.5) || 3600000;
}

function buildCascadeSummary(rows, candles, opts) {
  const stepMs = medianStepMs(candles, rows);
  const barsPerHour = Math.max(1, Math.round(3600000 / stepMs));
  const zWindowBars = Math.max(10, Math.round((opts.zWindowHours || 168) * barsPerHour));
  const entryDelayBars = Math.max(0, Math.round((opts.entryDelayHours || 0) * barsPerHour));
  const holdBars = Math.max(1, Math.round((opts.holdHours || 8) * barsPerHour));

  const priceByTs = new Map(candles.map((c) => [Number(c.time) * 1000, c]));
  const merged = rows.map((r) => ({ ...r, candle: priceByTs.get(r.ts) })).filter((x) => x.candle);
  if (!merged.length) return { count: 0, winRate: 0, avgRet: 0 };

  const totals = merged.map((x) => x.totalUsd);
  const threshold = quantile(totals, opts.q || 0.95);
  const rets = [];

  for (let i = 0; i < merged.length; i += 1) {
    const m = merged[i];
    const start = Math.max(0, i - zWindowBars + 1);
    const window = totals.slice(start, i + 1);
    const z = (m.totalUsd - mean(window)) / std(window);
    const longShare = m.totalUsd > 0 ? m.longUsd / m.totalUsd : 0;
    const isCascade = m.totalUsd >= threshold && longShare >= (opts.minLongShare || 0.65) && z >= (opts.zMin || 1.5);
    if (!isCascade) continue;
    const entryIdx = i + entryDelayBars;
    const exitIdx = entryIdx + holdBars;
    if (exitIdx >= merged.length) continue;
    const entry = merged[entryIdx].candle.close;
    const exit = merged[exitIdx].candle.close;
    rets.push(entry > 0 ? (exit - entry) / entry : 0);
  }

  const winCount = rets.filter((x) => x > 0).length;
  return {
    count: rets.length,
    winRate: rets.length ? winCount / rets.length : 0,
    avgRet: rets.length ? mean(rets) : 0
  };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const candles = Array.isArray(body?.candles) ? body.candles : [];
    const ranges = body?.ranges || {};

    const qs = frange(ranges.qMin, ranges.qMax, ranges.qStep);
    const ls = frange(ranges.longMin, ranges.longMax, ranges.longStep);
    const zs = frange(ranges.zMin, ranges.zMax, ranges.zStep);
    const delays = frange(ranges.delayMin, ranges.delayMax, ranges.delayStep);
    const holds = frange(ranges.holdMin, ranges.holdMax, ranges.holdStep);
    const estimated = qs.length * ls.length * zs.length * delays.length * holds.length;

    if (estimated > 60000) {
      return NextResponse.json({ error: `Too many combinations (${estimated}). Please narrow ranges.` }, { status: 400 });
    }

    const top = [];
    let tested = 0;
    for (const q of qs) {
      for (const minLongShare of ls) {
        for (const zMin of zs) {
          for (const entryDelayHours of delays) {
            for (const holdHours of holds) {
              tested += 1;
              const r = buildCascadeSummary(rows, candles, {
                q, minLongShare, zMin,
                zWindowHours: ranges.zWindowHours,
                entryDelayHours, holdHours
              });
              if (r.count < ranges.minEvents) continue;
              const score = (r.avgRet || 0) * 0.6 + (r.winRate || 0) * 0.4;
              top.push({ q, minLongShare, zMin, entryDelayHours, holdHours, count: r.count, winRate: r.winRate, avgRet: r.avgRet, score });
            }
          }
        }
      }
    }
    top.sort((a, b) => b.score - a.score);
    return NextResponse.json({ tested, estimated, top: top.slice(0, 20) });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error" }, { status: 500 });
  }
}
