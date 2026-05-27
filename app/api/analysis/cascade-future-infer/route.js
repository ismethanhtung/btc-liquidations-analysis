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
      z,
      threshold
    });
  }

  return { events, threshold };
}

function pctMove(from, to) {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return 0;
  return (to - from) / from;
}

function trailingStdClose(merged, idx, bars) {
  const start = Math.max(1, idx - bars + 1);
  const rets = [];
  for (let i = start; i <= idx; i += 1) {
    const prev = Number(merged[i - 1]?.candle?.close || 0);
    const curr = Number(merged[i]?.candle?.close || 0);
    if (prev > 0 && curr > 0) rets.push((curr - prev) / prev);
  }
  return std(rets);
}

function buildFeatureVector(merged, event, barsPerHour) {
  const idx = event.idx;
  const closeNow = Number(merged[idx]?.candle?.close || 0);
  const close1hAgo = Number(merged[Math.max(0, idx - barsPerHour)]?.candle?.close || closeNow);
  const close4hAgo = Number(merged[Math.max(0, idx - 4 * barsPerHour)]?.candle?.close || closeNow);
  const close24hAgo = Number(merged[Math.max(0, idx - 24 * barsPerHour)]?.candle?.close || closeNow);
  const totalPrev6 = [];
  for (let i = Math.max(0, idx - 6 * barsPerHour); i < idx; i += 1) totalPrev6.push(Number(merged[i]?.totalUsd || 0));
  const totalPrev24 = [];
  for (let i = Math.max(0, idx - 24 * barsPerHour); i < idx; i += 1) totalPrev24.push(Number(merged[i]?.totalUsd || 0));

  const liqMean6h = totalPrev6.length ? mean(totalPrev6) : Number(merged[idx]?.totalUsd || 0);
  const liqStd6h = totalPrev6.length ? std(totalPrev6) : 1;
  const liqMean24h = totalPrev24.length ? mean(totalPrev24) : Number(merged[idx]?.totalUsd || 0);

  return {
    totalUsdLog: Math.log10(Math.max(1, Number(event.totalUsd || 0))),
    longShare: Number(event.longShare || 0),
    zScore: Number(event.z || 0),
    liqToThreshold: Number(event.threshold || 1) > 0 ? Number(event.totalUsd || 0) / Number(event.threshold || 1) : 0,
    liqImpulse6h: liqStd6h > 0 ? (Number(event.totalUsd || 0) - liqMean6h) / liqStd6h : 0,
    liqVs24hMean: liqMean24h > 0 ? Number(event.totalUsd || 0) / liqMean24h : 0,
    ret1hPast: pctMove(close1hAgo, closeNow),
    ret4hPast: pctMove(close4hAgo, closeNow),
    ret24hPast: pctMove(close24hAgo, closeNow),
    vol6h: trailingStdClose(merged, idx, Math.max(3, 6 * barsPerHour)),
    vol24h: trailingStdClose(merged, idx, Math.max(6, 24 * barsPerHour))
  };
}

function inferRegimeLabel(merged, event, barsPerHour, regimeCfg) {
  const horizonBars = Math.max(2, Math.round((regimeCfg.horizonHours || 6) * barsPerHour));
  const retThreshold = Number(regimeCfg.retThreshold || 0.008);
  const drawdownThreshold = Number(regimeCfg.drawdownThreshold || 0.015);

  const entry = Number(merged[event.idx]?.candle?.close || 0);
  if (!Number.isFinite(entry) || entry <= 0) return "chop";

  const endIdx = Math.min(merged.length - 1, event.idx + horizonBars);
  if (endIdx <= event.idx) return "chop";

  const exit = Number(merged[endIdx]?.candle?.close || entry);
  const ret = pctMove(entry, exit);

  let minLow = entry;
  for (let i = event.idx + 1; i <= endIdx; i += 1) {
    const low = Number(merged[i]?.candle?.low || merged[i]?.candle?.close || entry);
    if (low < minLow) minLow = low;
  }
  const drawdown = pctMove(entry, minLow);

  if (ret >= retThreshold) return "mean_revert";
  if (ret <= -retThreshold || drawdown <= -drawdownThreshold) return "trend_down";
  return "chop";
}

function evaluateTrade(merged, eventIdx, delayBars, holdBars) {
  const entryIdx = eventIdx + delayBars;
  const exitIdx = entryIdx + holdBars;
  if (entryIdx < 0 || exitIdx >= merged.length) return null;
  const entry = Number(merged[entryIdx]?.candle?.close || 0);
  const exit = Number(merged[exitIdx]?.candle?.close || 0);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return null;

  let minLow = entry;
  let maxHigh = entry;
  for (let i = entryIdx; i <= exitIdx; i += 1) {
    const low = Number(merged[i]?.candle?.low || merged[i]?.candle?.close || entry);
    const high = Number(merged[i]?.candle?.high || merged[i]?.candle?.close || entry);
    if (low < minLow) minLow = low;
    if (high > maxHigh) maxHigh = high;
  }

  const ret = pctMove(entry, exit);
  const mae = pctMove(entry, minLow);
  const mfe = pctMove(entry, maxHigh);

  return {
    entryIdx,
    exitIdx,
    entryTs: merged[entryIdx].timestamp,
    exitTs: merged[exitIdx].timestamp,
    entry,
    exit,
    ret,
    mae,
    mfe,
    win: ret > 0
  };
}

function fitStandardizer(items, featureNames) {
  const means = {};
  const stds = {};
  for (const f of featureNames) {
    const arr = items.map((x) => Number(x.features[f] || 0));
    means[f] = mean(arr);
    stds[f] = std(arr) || 1;
  }
  return { means, stds };
}

function normalizeFeatures(features, standardizer, featureNames) {
  const v = {};
  for (const f of featureNames) {
    const x = Number(features[f] || 0);
    const m = Number(standardizer.means[f] || 0);
    const s = Number(standardizer.stds[f] || 1);
    v[f] = (x - m) / (s || 1);
  }
  return v;
}

function cosineSimilarity(a, b, featureNames) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const f of featureNames) {
    const x = Number(a[f] || 0);
    const y = Number(b[f] || 0);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  if (!Number.isFinite(den) || den <= 0) return 0;
  return dot / den;
}

function buildRegimeLogitsFromNeighbors(neighbors) {
  const score = {
    mean_revert: 0,
    trend_down: 0,
    chop: 0
  };
  for (const n of neighbors) {
    score[n.regime] += Number(n.weight || 0);
  }

  const arr = [score.mean_revert, score.trend_down, score.chop];
  const m = mean(arr);
  const s = std(arr) || 1;
  const logits = {
    mean_revert: (score.mean_revert - m) / s,
    trend_down: (score.trend_down - m) / s,
    chop: (score.chop - m) / s
  };

  const ex = {
    mean_revert: Math.exp(logits.mean_revert),
    trend_down: Math.exp(logits.trend_down),
    chop: Math.exp(logits.chop)
  };
  const sumEx = ex.mean_revert + ex.trend_down + ex.chop;
  const probs = {
    mean_revert: sumEx > 0 ? ex.mean_revert / sumEx : 1 / 3,
    trend_down: sumEx > 0 ? ex.trend_down / sumEx : 1 / 3,
    chop: sumEx > 0 ? ex.chop / sumEx : 1 / 3
  };

  return { rawScores: score, logits, probs };
}

function weightedAvg(items, accessor) {
  const nums = [];
  const weights = [];
  for (const it of items) {
    const v = Number(accessor(it));
    const w = Number(it.weight || 0);
    if (!Number.isFinite(v) || !Number.isFinite(w) || w <= 0) continue;
    nums.push(v);
    weights.push(w);
  }
  const sw = weights.reduce((s, x) => s + x, 0);
  if (sw <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < nums.length; i += 1) sum += nums[i] * weights[i];
  return sum / sw;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export async function POST(req) {
  try {
    const body = await req.json();
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const candles = Array.isArray(body?.candles) ? body.candles : [];
    const filters = body?.filters || {};
    const ranges = body?.ranges || {};
    const scoring = body?.scoring || {};
    const memory = body?.memory || {};
    const targetTs = Number(body?.targetTs || 0);
    const regimeCfg = body?.regime || {};

    const stepMs = medianStepMs(candles, rows);
    const barsPerHour = Math.max(1, Math.round(3600000 / stepMs));
    const merged = buildMerged(rows, candles);
    if (!merged.length) {
      return NextResponse.json({ error: "No merged rows/candles." }, { status: 400 });
    }

    const detected = detectCascadeEvents(merged, {
      q: Number(filters.q ?? 0.99),
      minLongShare: Number(filters.minLongShare ?? 0.8),
      zMin: Number(filters.zMin ?? 1.5),
      zWindowHours: Number(filters.zWindowHours ?? 168)
    }, barsPerHour);

    if (!detected.events.length) {
      return NextResponse.json({
        meta: { barsPerHour, detectedEvents: 0 },
        message: "No events matched current filter.",
        regime: null,
        actions: { top: [], chosen: null },
        targetEvent: null
      });
    }

    const eventsWithFeatures = detected.events.map((event) => ({
      ...event,
      features: buildFeatureVector(merged, event, barsPerHour),
      regime: inferRegimeLabel(merged, event, barsPerHour, {
        horizonHours: Number(regimeCfg.horizonHours ?? 6),
        retThreshold: Number(regimeCfg.retThreshold ?? 0.008),
        drawdownThreshold: Number(regimeCfg.drawdownThreshold ?? 0.015)
      })
    }));

    const targetEvent = targetTs
      ? eventsWithFeatures.find((e) => Math.abs(Number(e.ts) - targetTs) <= stepMs)
      : eventsWithFeatures[eventsWithFeatures.length - 1];

    if (!targetEvent) {
      return NextResponse.json({ error: "Target event not found." }, { status: 404 });
    }

    const minHistory = Math.max(20, Number(memory.minHistoryEvents || 80));
    const histEvents = eventsWithFeatures.filter((e) => e.ts < targetEvent.ts);
    if (histEvents.length < minHistory) {
      return NextResponse.json({
        error: `Not enough history before target event. need>=${minHistory}, got=${histEvents.length}`
      }, { status: 400 });
    }

    const featureNames = [
      "totalUsdLog",
      "longShare",
      "zScore",
      "liqToThreshold",
      "liqImpulse6h",
      "liqVs24hMean",
      "ret1hPast",
      "ret4hPast",
      "ret24hPast",
      "vol6h",
      "vol24h"
    ];

    const standardizer = fitStandardizer(histEvents, featureNames);
    const targetNorm = normalizeFeatures(targetEvent.features, standardizer, featureNames);

    const k = Math.max(5, Number(memory.k || 40));
    const compared = histEvents.map((h) => {
      const norm = normalizeFeatures(h.features, standardizer, featureNames);
      const cos = cosineSimilarity(targetNorm, norm, featureNames);
      const sim01 = (cos + 1) / 2;
      const weight = Math.max(1e-6, sim01 ** 3);
      return {
        ...h,
        similarity: sim01,
        weight
      };
    }).sort((a, b) => b.similarity - a.similarity);

    const neighbors = compared.slice(0, Math.min(k, compared.length));
    const regime = buildRegimeLogitsFromNeighbors(neighbors);

    const delayList = frange(ranges.delayMin, ranges.delayMax, ranges.delayStep);
    const holdList = frange(ranges.holdMin, ranges.holdMax, ranges.holdStep);
    if (!delayList.length || !holdList.length) {
      return NextResponse.json({ error: "Invalid delay/hold range." }, { status: 400 });
    }

    const riskPenalty = Number(scoring.riskPenalty ?? 0.5);
    const holdPenaltyPerHour = Number(scoring.holdPenaltyPerHour ?? 0.0005);
    const delayPenaltyPerHour = Number(scoring.delayPenaltyPerHour ?? 0.0002);
    const uncertaintyPenalty = Number(scoring.uncertaintyPenalty ?? 0.35);
    const minExpectedRet = Number(scoring.minExpectedRet ?? -0.03);
    const regimeBias = Number(scoring.regimeBias ?? 0.01);

    const actionRows = [];
    for (const delayHours of delayList) {
      const delayBars = Math.max(0, Math.round(delayHours * barsPerHour));
      for (const holdHours of holdList) {
        const holdBars = Math.max(1, Math.round(holdHours * barsPerHour));

        const neighborTrades = [];
        for (const n of neighbors) {
          const trade = evaluateTrade(merged, n.idx, delayBars, holdBars);
          if (!trade) continue;
          neighborTrades.push({ ...n, trade });
        }
        if (neighborTrades.length < Math.max(8, Math.round(k * 0.25))) continue;

        const expectedRet = weightedAvg(neighborTrades, (x) => x.trade.ret);
        const expectedMae = weightedAvg(neighborTrades, (x) => x.trade.mae);
        const expectedMfe = weightedAvg(neighborTrades, (x) => x.trade.mfe);
        const winProb = weightedAvg(neighborTrades, (x) => (x.trade.win ? 1 : 0));

        const retList = neighborTrades.map((x) => Number(x.trade.ret || 0));
        const uncertainty = std(retList);

        if (expectedRet < minExpectedRet) continue;

        const rawScore =
          expectedRet
          - riskPenalty * Math.max(0, -expectedMae)
          - holdPenaltyPerHour * holdHours
          - delayPenaltyPerHour * delayHours
          - uncertaintyPenalty * uncertainty
          + regimeBias * (regime.probs.mean_revert - regime.probs.trend_down);

        const score = sigmoid(rawScore / 0.01);

        actionRows.push({
          delayHours,
          holdHours,
          expectedRet,
          expectedMae,
          expectedMfe,
          winProb,
          uncertainty,
          rawScore,
          score,
          sampleSize: neighborTrades.length,
          delayBars,
          holdBars
        });
      }
    }

    actionRows.sort((a, b) => b.score - a.score);
    const chosen = actionRows[0] || null;

    const chosenTradeRealized = chosen
      ? evaluateTrade(merged, targetEvent.idx, chosen.delayBars, chosen.holdBars)
      : null;

    const baselineDelayHours = Number(body?.baseline?.entryDelayHours ?? 1);
    const baselineHoldHours = Number(body?.baseline?.holdHours ?? 8);
    const baselineTradeRealized = evaluateTrade(
      merged,
      targetEvent.idx,
      Math.max(0, Math.round(baselineDelayHours * barsPerHour)),
      Math.max(1, Math.round(baselineHoldHours * barsPerHour))
    );

    return NextResponse.json({
      meta: {
        barsPerHour,
        stepMs,
        detectedEvents: detected.events.length,
        historyEvents: histEvents.length,
        targetTs: targetEvent.ts,
        kUsed: neighbors.length,
        threshold: detected.threshold
      },
      targetEvent: {
        ts: targetEvent.ts,
        timestamp: targetEvent.timestamp,
        totalUsd: targetEvent.totalUsd,
        longShare: targetEvent.longShare,
        z: targetEvent.z,
        features: targetEvent.features
      },
      regime: {
        rawScores: regime.rawScores,
        logits: regime.logits,
        probs: regime.probs,
        topNeighbors: neighbors.slice(0, 20).map((n) => ({
          ts: n.ts,
          timestamp: n.timestamp,
          similarity: n.similarity,
          weight: n.weight,
          totalUsd: n.totalUsd,
          longShare: n.longShare,
          z: n.z,
          regime: n.regime
        }))
      },
      actions: {
        totalEvaluated: actionRows.length,
        top: actionRows,
        chosen,
        chosenTradeRealized,
        baseline: {
          delayHours: baselineDelayHours,
          holdHours: baselineHoldHours,
          realized: baselineTradeRealized
        }
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Unexpected error" }, { status: 500 });
  }
}
