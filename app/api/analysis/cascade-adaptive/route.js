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

function buildMerged(rows, candles) {
  const priceByTs = new Map(candles.map((c) => [Number(c.time) * 1000, c]));
  return rows.map((r) => ({ ...r, candle: priceByTs.get(r.ts) })).filter((x) => x.candle);
}

function detectCascadeEvents(merged, opts, barsPerHour) {
  const zWindowBars = Math.max(10, Math.round((opts.zWindowHours || 168) * barsPerHour));
  const totals = merged.map((x) => x.totalUsd);
  const threshold = quantile(totals, opts.q || 0.95);
  const events = [];

  for (let i = 0; i < merged.length; i += 1) {
    const m = merged[i];
    const start = Math.max(0, i - zWindowBars + 1);
    const window = totals.slice(start, i + 1);
    const z = (m.totalUsd - mean(window)) / std(window);
    const longShare = m.totalUsd > 0 ? m.longUsd / m.totalUsd : 0;
    const isCascade = m.totalUsd >= threshold && longShare >= (opts.minLongShare || 0.65) && z >= (opts.zMin || 1.5);
    if (!isCascade) continue;
    events.push({
      idx: i,
      ts: m.ts,
      timestamp: m.timestamp,
      totalUsd: m.totalUsd,
      longShare,
      z
    });
  }

  return { events, threshold };
}

function evaluateTrade(merged, eventIdx, entryDelayBars, holdBars) {
  const entryIdx = eventIdx + entryDelayBars;
  const exitIdx = entryIdx + holdBars;
  if (entryIdx < 0 || exitIdx >= merged.length) return null;

  const entryCandle = merged[entryIdx]?.candle;
  const exitCandle = merged[exitIdx]?.candle;
  const entry = Number(entryCandle?.close || 0);
  const exit = Number(exitCandle?.close || 0);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return null;

  let minLow = entry;
  let maxHigh = entry;
  for (let i = entryIdx; i <= exitIdx; i += 1) {
    const c = merged[i]?.candle;
    if (!c) continue;
    const low = Number.isFinite(Number(c.low)) ? Number(c.low) : Number(c.close || entry);
    const high = Number.isFinite(Number(c.high)) ? Number(c.high) : Number(c.close || entry);
    if (low < minLow) minLow = low;
    if (high > maxHigh) maxHigh = high;
  }

  const ret = (exit - entry) / entry;
  const mae = (minLow - entry) / entry;
  const mfe = (maxHigh - entry) / entry;

  return {
    entryIdx,
    exitIdx,
    entry,
    exit,
    entryTs: merged[entryIdx].timestamp,
    exitTs: merged[exitIdx].timestamp,
    ret,
    mae,
    mfe,
    win: ret > 0
  };
}

function scoreTrade(trade, entryDelayHours, holdHours, scoring) {
  const riskPenalty = Number(scoring?.riskPenalty ?? 0.5);
  const holdPenaltyPerHour = Number(scoring?.holdPenaltyPerHour ?? 0);
  const delayPenaltyPerHour = Number(scoring?.delayPenaltyPerHour ?? 0);
  const minReturn = Number(scoring?.minReturn ?? -Infinity);

  if (Number.isFinite(minReturn) && trade.ret < minReturn) return Number.NEGATIVE_INFINITY;
  const drawdownPenalty = Math.max(0, -Number(trade.mae || 0)) * riskPenalty;
  return Number(trade.ret || 0) - drawdownPenalty - holdPenaltyPerHour * holdHours - delayPenaltyPerHour * entryDelayHours;
}

function summarizeTrades(events) {
  const rets = events.map((e) => Number(e.ret || 0));
  const wins = rets.filter((x) => x > 0).length;
  let compounded = 1;
  for (const r of rets) compounded *= (1 + r);

  return {
    count: events.length,
    winRate: events.length ? wins / events.length : 0,
    avgRet: events.length ? mean(rets) : 0,
    medianRet: events.length ? quantile(rets, 0.5) : 0,
    avgDelayHours: events.length ? mean(events.map((e) => Number(e.entryDelayHours || 0))) : 0,
    avgHoldHours: events.length ? mean(events.map((e) => Number(e.holdHours || 0))) : 0,
    avgMae: events.length ? mean(events.map((e) => Number(e.mae || 0))) : 0,
    avgMfe: events.length ? mean(events.map((e) => Number(e.mfe || 0))) : 0,
    compoundedRoi: events.length ? (compounded - 1) : 0
  };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const candles = Array.isArray(body?.candles) ? body.candles : [];
    const filters = body?.filters || {};
    const ranges = body?.ranges || {};
    const scoring = body?.scoring || {};
    const baseline = body?.baseline || {};

    const stepMs = medianStepMs(candles, rows);
    const barsPerHour = Math.max(1, Math.round(3600000 / stepMs));
    const merged = buildMerged(rows, candles);
    if (!merged.length) {
      return NextResponse.json({
        meta: { detectedEvents: 0, testedCombos: 0, threshold: 0 },
        summary: summarizeTrades([]),
        events: []
      });
    }

    const { events: detectedEvents, threshold } = detectCascadeEvents(merged, {
      q: Number(filters.q ?? 0.95),
      minLongShare: Number(filters.minLongShare ?? 0.65),
      zMin: Number(filters.zMin ?? 1.5),
      zWindowHours: Number(filters.zWindowHours ?? 168)
    }, barsPerHour);

    const delays = frange(ranges.delayMin, ranges.delayMax, ranges.delayStep);
    const holds = frange(ranges.holdMin, ranges.holdMax, ranges.holdStep);
    const combosPerEvent = delays.length * holds.length;
    const estimated = detectedEvents.length * combosPerEvent;

    if (!delays.length || !holds.length) {
      return NextResponse.json({ error: "Delay/Hold ranges are invalid." }, { status: 400 });
    }
    if (estimated > 500000) {
      return NextResponse.json({ error: `Too many event-level combinations (${estimated}). Please narrow ranges.` }, { status: 400 });
    }

    const bestEvents = [];
    let testedCombos = 0;

    for (const e of detectedEvents) {
      let best = null;
      for (const delayHours of delays) {
        const entryDelayBars = Math.max(0, Math.round(delayHours * barsPerHour));
        for (const holdHours of holds) {
          const holdBars = Math.max(1, Math.round(holdHours * barsPerHour));
          const trade = evaluateTrade(merged, e.idx, entryDelayBars, holdBars);
          testedCombos += 1;
          if (!trade) continue;
          const score = scoreTrade(trade, delayHours, holdHours, scoring);
          if (!Number.isFinite(score)) continue;

          const candidate = {
            ...e,
            ...trade,
            entryDelayHours: delayHours,
            holdHours,
            score
          };

          if (!best) {
            best = candidate;
            continue;
          }
          if (candidate.score > best.score) {
            best = candidate;
            continue;
          }
          if (candidate.score === best.score && candidate.ret > best.ret) {
            best = candidate;
            continue;
          }
          if (candidate.score === best.score && candidate.ret === best.ret && candidate.holdHours < best.holdHours) {
            best = candidate;
          }
        }
      }
      if (best) bestEvents.push(best);
    }

    bestEvents.sort((a, b) => a.ts - b.ts);

    const baselineDelayHours = Number(baseline.entryDelayHours ?? 1);
    const baselineHoldHours = Number(baseline.holdHours ?? 8);
    const baselineDelayBars = Math.max(0, Math.round(baselineDelayHours * barsPerHour));
    const baselineHoldBars = Math.max(1, Math.round(baselineHoldHours * barsPerHour));
    const baselineEvents = [];
    for (const e of detectedEvents) {
      const trade = evaluateTrade(merged, e.idx, baselineDelayBars, baselineHoldBars);
      if (!trade) continue;
      baselineEvents.push({
        ...e,
        ...trade,
        entryDelayHours: baselineDelayHours,
        holdHours: baselineHoldHours,
        score: scoreTrade(trade, baselineDelayHours, baselineHoldHours, scoring)
      });
    }

    return NextResponse.json({
      meta: {
        barsPerHour,
        threshold,
        detectedEvents: detectedEvents.length,
        testedCombos,
        estimatedCombos: estimated,
        combosPerEvent
      },
      summary: summarizeTrades(bestEvents),
      baselineSummary: {
        ...summarizeTrades(baselineEvents),
        entryDelayHours: baselineDelayHours,
        holdHours: baselineHoldHours
      },
      events: bestEvents.map((x) => ({
        ts: x.ts,
        timestamp: x.timestamp,
        totalUsd: x.totalUsd,
        longShare: x.longShare,
        z: x.z,
        entryDelayHours: x.entryDelayHours,
        holdHours: x.holdHours,
        entryTs: x.entryTs,
        exitTs: x.exitTs,
        ret: x.ret,
        mae: x.mae,
        mfe: x.mfe,
        score: x.score,
        win: x.win
      }))
    });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error" }, { status: 500 });
  }
}
