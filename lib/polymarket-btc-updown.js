import {
  buildPhatich4RegimeAnalysisFromDataset,
  intervalToMs,
  mean,
  quantile,
} from "./phatich4-regime.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const MS = {
  min: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 180)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 240)}`);
  }
  return payload;
}

function getOutcomeIndex(outcomes, names) {
  const wanted = names.map((name) => String(name).toLowerCase());
  return outcomes.findIndex((outcome) => wanted.includes(String(outcome).toLowerCase()));
}

function resolvedOutcomeFromPrices(market) {
  const outcomes = parseJsonArray(market?.outcomes);
  const prices = parseJsonArray(market?.outcomePrices).map((v) => safeNum(v, NaN));
  const upIdx = getOutcomeIndex(outcomes, ["Up", "Yes"]);
  const downIdx = getOutcomeIndex(outcomes, ["Down", "No"]);
  if (upIdx < 0 || downIdx < 0) return null;
  const up = prices[upIdx];
  const down = prices[downIdx];
  if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
  if (up >= 0.99 && down <= 0.01) return "UP";
  if (down >= 0.99 && up <= 0.01) return "DOWN";
  return null;
}

function normalizeEvent(event) {
  const market = event?.markets?.[0] || event?.market || event;
  const outcomes = parseJsonArray(market?.outcomes);
  const clobTokenIds = parseJsonArray(market?.clobTokenIds);
  const upIdx = getOutcomeIndex(outcomes, ["Up", "Yes"]);
  const downIdx = getOutcomeIndex(outcomes, ["Down", "No"]);
  const endMs = Date.parse(market?.endDate || event?.endDate || "");
  const title = event?.title || market?.question || "";
  const question = market?.question || title;
  const slug = event?.slug || market?.slug || "";
  const description = event?.description || market?.description || "";
  const frame = inferMarketFrame({ slug, title, question, description, endMs });

  return {
    eventId: String(event?.id || ""),
    marketId: String(market?.id || ""),
    slug,
    marketSlug: market?.slug || slug,
    title,
    question,
    description,
    frame,
    active: Boolean(event?.active ?? market?.active),
    closed: Boolean(event?.closed ?? market?.closed),
    acceptingOrders: Boolean(market?.acceptingOrders),
    startDate: market?.startDate || event?.startDate || null,
    endDate: market?.endDate || event?.endDate || null,
    endMs: Number.isFinite(endMs) ? endMs : null,
    outcomes,
    outcomePrices: parseJsonArray(market?.outcomePrices).map((v) => safeNum(v, NaN)),
    upTokenId: upIdx >= 0 ? clobTokenIds[upIdx] : null,
    downTokenId: downIdx >= 0 ? clobTokenIds[downIdx] : null,
    upIndex: upIdx,
    downIndex: downIdx,
    bestBid: safeNum(market?.bestBid, NaN),
    bestAsk: safeNum(market?.bestAsk, NaN),
    spread: safeNum(market?.spread, NaN),
    volume24hr: safeNum(market?.volume24hr, 0),
    volumeNum: safeNum(market?.volumeNum ?? market?.volume, 0),
    liquidityNum: safeNum(market?.liquidityNum ?? market?.liquidity, 0),
    feeType: market?.feeType || null,
    feesEnabled: Boolean(market?.feesEnabled),
    feeSchedule: market?.feeSchedule || null,
    resolvedOutcome: resolvedOutcomeFromPrices(market),
  };
}

function inferMarketFrame({ slug, title, question, description }) {
  const text = `${slug || ""} ${title || ""} ${question || ""} ${description || ""}`.toLowerCase();
  if (/\b4h\b|\b4 hour\b|\b4-hour\b/.test(text)) return "4h";
  if (/btc-updown-5m-|5:?\d\d|5m|\b5 minute\b/.test(text) && /\d{1,2}:\d{2}.*-.*\d{1,2}:\d{2}/.test(text)) {
    return "5m";
  }
  if (/15m|\b15 minute\b/.test(text)) return "15m";
  if (/\b1 hour\b|\b1h\b|1am et|2am et|3am et|4am et|5am et|6am et|7am et|8am et|9am et|10am et|11am et|12pm et|1pm et|2pm et|3pm et|4pm et|5pm et|6pm et|7pm et|8pm et|9pm et|10pm et|11pm et|12am et/.test(text)) {
    return "1h";
  }
  if (/bitcoin-up-or-down-on-/.test(text) || /\bon [a-z]+ \d+/.test(text)) return "1d";
  return "unknown";
}

function marketWindow(event) {
  if (!event?.endMs) return null;
  let durationMs = MS.day;
  if (event.frame === "4h") durationMs = 4 * MS.hour;
  if (event.frame === "1h") durationMs = MS.hour;
  if (event.frame === "15m") durationMs = 15 * MS.min;
  if (event.frame === "5m") durationMs = 5 * MS.min;
  return {
    startMs: event.endMs - durationMs,
    endMs: event.endMs,
    durationMs,
  };
}

function nearestTimelineIndex(rows, targetMs, { direction = "before", maxGapMs = Infinity } = {}) {
  if (!rows.length || !Number.isFinite(targetMs)) return -1;
  let lo = 0;
  let hi = rows.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = rows[mid].ms;
    if (t <= targetMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (direction === "after") {
    const idx = best >= 0 && rows[best].ms === targetMs ? best : best + 1;
    if (idx >= rows.length) return -1;
    return Math.abs(rows[idx].ms - targetMs) <= maxGapMs ? idx : -1;
  }
  if (direction === "nearest") {
    const candidates = [best, best + 1].filter((idx) => idx >= 0 && idx < rows.length);
    if (!candidates.length) return -1;
    candidates.sort((a, b) => Math.abs(rows[a].ms - targetMs) - Math.abs(rows[b].ms - targetMs));
    return Math.abs(rows[candidates[0]].ms - targetMs) <= maxGapMs ? candidates[0] : -1;
  }
  if (best < 0) return -1;
  return Math.abs(rows[best].ms - targetMs) <= maxGapMs ? best : -1;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((sum, x) => sum + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v) || 0;
}

function enrichTimeline(timeline, interval) {
  const intervalMs = intervalToMs(interval);
  const bars24 = Math.max(1, Math.round(MS.day / intervalMs));
  const bars72 = bars24 * 3;
  const rows = (timeline || [])
    .map((row, idx) => ({
      ...row,
      idx,
      ms: safeNum(row.time, 0) * 1000,
      priceClose: safeNum(row.priceClose, NaN),
    }))
    .filter((row) => Number.isFinite(row.ms) && Number.isFinite(row.priceClose))
    .sort((a, b) => a.ms - b.ms);

  const rets = rows.map((row, idx) => (
    idx === 0 ? 0 : (row.priceClose - rows[idx - 1].priceClose) / Math.max(1e-9, rows[idx - 1].priceClose)
  ));

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    row.priceRet24 = i >= bars24 ? (row.priceClose - rows[i - bars24].priceClose) / rows[i - bars24].priceClose : 0;
    row.priceRet72 = i >= bars72 ? (row.priceClose - rows[i - bars72].priceClose) / rows[i - bars72].priceClose : 0;
    row.realizedVol24 = sampleStd(rets.slice(Math.max(0, i - bars24 + 1), i + 1));
    row.realizedVol72 = sampleStd(rets.slice(Math.max(0, i - bars72 + 1), i + 1));
    let duration = 1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (rows[j].state !== row.state) break;
      duration += 1;
    }
    row.stateDurationBars = duration;
    row.stateDurationHours = (duration * intervalMs) / MS.hour;
  }
  return rows;
}

function signedBucket(value, threshold = 0.0015) {
  if (value > threshold) return "pos";
  if (value < -threshold) return "neg";
  return "flat";
}

function betaMean(up, n, priorP = 0.5, priorN = 12) {
  return (up + priorP * priorN) / Math.max(1, n + priorN);
}

function wilsonInterval(up, n, z = 1.96) {
  if (!n) return { low: 0.05, high: 0.95, width: 0.9 };
  const phat = up / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  const low = clamp(center - margin, 0, 1);
  const high = clamp(center + margin, 0, 1);
  return { low, high, width: high - low };
}

function standardizationStats(samples) {
  const keys = [
    "distanceToStrike",
    "priceRet24",
    "priceRet72",
    "realizedVol24",
    "liqShock",
    "fundingShock",
    "oiRet24",
    "cvdRet24",
    "stateDurationHours",
    "elapsedPct",
  ];
  const stats = {};
  for (const key of keys) {
    const values = samples.map((sample) => safeNum(sample.features?.[key], 0));
    stats[key] = {
      mean: mean(values),
      std: sampleStd(values) || 1,
    };
  }
  return { keys, stats };
}

function featureDistance(a, b, keys, stats) {
  let d = a.state === b.state ? 0 : 1.2;
  for (const key of keys) {
    const s = stats[key]?.std || 1;
    const av = (safeNum(a.features?.[key], 0) - (stats[key]?.mean || 0)) / s;
    const bv = (safeNum(b.features?.[key], 0) - (stats[key]?.mean || 0)) / s;
    d += 0.16 * (av - bv) ** 2;
  }
  return Math.sqrt(d);
}

function predictWithTraining(sample, training, options = {}) {
  const priorN = safeNum(options.priorN, 16);
  const minStateSamples = safeNum(options.minStateSamples, 12);
  if (!training.length) {
    return {
      pUp: 0.5,
      baselineP: 0.5,
      stateP: 0.5,
      neighborP: 0.5,
      trendP: 0.5,
      sampleSize: 0,
      stateCount: 0,
      trendCount: 0,
      ci: { low: 0.05, high: 0.95, width: 0.9 },
      reason: "No prior samples.",
    };
  }

  const totalUp = training.filter((row) => row.outcome === "UP").length;
  const baselineP = betaMean(totalUp, training.length, 0.5, priorN);
  const sameState = training.filter((row) => row.state === sample.state);
  const stateUp = sameState.filter((row) => row.outcome === "UP").length;
  const stateP = betaMean(stateUp, sameState.length, baselineP, priorN);

  const trendKey = [
    sample.state,
    signedBucket(sample.features.distanceToStrike, 0.001),
    signedBucket(sample.features.priceRet24, 0.002),
  ].join("|");
  const trendRows = training.filter((row) => row.trendKey === trendKey);
  const trendUp = trendRows.filter((row) => row.outcome === "UP").length;
  const trendP = betaMean(trendUp, trendRows.length, stateP, priorN);

  const { keys, stats } = standardizationStats(training);
  const neighbors = training
    .map((row) => {
      const dist = featureDistance(sample, row, keys, stats);
      return {
        outcome: row.outcome,
        dist,
        weight: 1 / (0.3 + dist),
      };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.max(12, Math.min(40, Math.round(Math.sqrt(training.length) * 3))));
  const neighborWeight = neighbors.reduce((sum, row) => sum + row.weight, 0);
  const neighborUpWeight = neighbors.reduce((sum, row) => sum + (row.outcome === "UP" ? row.weight : 0), 0);
  const neighborP = neighborWeight > 0
    ? (neighborUpWeight + baselineP * 3) / (neighborWeight + 3)
    : baselineP;

  const stateReliability = sameState.length / (sameState.length + minStateSamples);
  const trendReliability = trendRows.length / (trendRows.length + 24);
  const neighborReliability = neighbors.length / (neighbors.length + 24);
  const weights = {
    state: 0.5 * stateReliability,
    neighbor: 0.3 * neighborReliability,
    trend: 0.2 * trendReliability,
  };
  const baseWeight = Math.max(0.15, 1 - weights.state - weights.neighbor - weights.trend);
  const weightSum = weights.state + weights.neighbor + weights.trend + baseWeight;
  const pUp = clamp(
    (weights.state * stateP + weights.neighbor * neighborP + weights.trend * trendP + baseWeight * baselineP) / weightSum,
    0.03,
    0.97,
  );

  return {
    pUp,
    baselineP,
    stateP,
    neighborP,
    trendP,
    sampleSize: training.length,
    stateCount: sameState.length,
    trendCount: trendRows.length,
    ci: wilsonInterval(stateUp, sameState.length),
    reason: sameState.length < minStateSamples
      ? `State sample thin (${sameState.length}/${minStateSamples}). Probability is strongly shrunk to baseline.`
      : "Regime sample is usable.",
  };
}

function feeRateForMarket(market, fallback = 0.07) {
  const explicit = safeNum(market?.feeSchedule?.rate, NaN);
  if (Number.isFinite(explicit)) return explicit;
  if (market?.feesEnabled === false) return 0;
  if (String(market?.feeType || "").includes("crypto")) return 0.07;
  return fallback;
}

function takerFeePerShare(price, feeRate) {
  if (!Number.isFinite(price)) return 0;
  return Math.max(0, feeRate * price * (1 - price));
}

function decideTrade({ prediction, impliedUp, upAsk, downAsk, market, options = {}, forceNoTrade = false }) {
  const minEdge = safeNum(options.minEdge, 0.035);
  const slippageCents = safeNum(options.slippageCents, 0.005);
  const feeRate = feeRateForMarket(market, safeNum(options.defaultFeeRate, 0.07));
  const pUp = prediction.pUp;
  const pDown = 1 - pUp;

  const upRaw = Number.isFinite(upAsk) ? upAsk : (Number.isFinite(impliedUp) ? impliedUp + slippageCents : NaN);
  const downRaw = Number.isFinite(downAsk) ? downAsk : (Number.isFinite(impliedUp) ? (1 - impliedUp) + slippageCents : NaN);
  const upCost = Number.isFinite(upRaw) ? clamp(upRaw + takerFeePerShare(upRaw, feeRate), 0.001, 0.999) : NaN;
  const downCost = Number.isFinite(downRaw) ? clamp(downRaw + takerFeePerShare(downRaw, feeRate), 0.001, 0.999) : NaN;
  const edgeUp = Number.isFinite(upCost) ? pUp - upCost : NaN;
  const edgeDown = Number.isFinite(downCost) ? pDown - downCost : NaN;

  const maxUpBid = clamp(pUp - minEdge - takerFeePerShare(Math.max(0.01, pUp), feeRate), 0.001, 0.999);
  const maxDownBid = clamp(pDown - minEdge - takerFeePerShare(Math.max(0.01, pDown), feeRate), 0.001, 0.999);
  let action = "SKIP";
  let side = "NONE";
  let edge = Math.max(Number.isFinite(edgeUp) ? edgeUp : -Infinity, Number.isFinite(edgeDown) ? edgeDown : -Infinity);
  let cost = NaN;
  let maxBid = NaN;
  let reason = "No edge after costs.";

  if (forceNoTrade) {
    action = "SKIP";
    side = "NONE";
    reason = "No listed Polymarket market for this horizon.";
  } else if (!Number.isFinite(edge)) {
    reason = "Missing usable implied odds.";
  } else if (prediction.stateCount < safeNum(options.minStateSamples, 12)) {
    reason = prediction.reason;
  } else if (edgeUp >= edgeDown && edgeUp >= minEdge) {
    action = "BUY_UP";
    side = "UP";
    edge = edgeUp;
    cost = upCost;
    maxBid = maxUpBid;
    reason = "Model fair Up probability is above executable Up cost.";
  } else if (edgeDown > edgeUp && edgeDown >= minEdge) {
    action = "BUY_DOWN";
    side = "DOWN";
    edge = edgeDown;
    cost = downCost;
    maxBid = maxDownBid;
    reason = "Model fair Down probability is above executable Down cost.";
  }

  const winP = side === "UP" ? pUp : side === "DOWN" ? pDown : 0;
  const kelly = Number.isFinite(cost) && cost > 0 && cost < 1
    ? clamp((((1 - cost) / cost) * winP - (1 - winP)) / ((1 - cost) / cost), 0, 1)
    : 0;
  const fraction = clamp(kelly * safeNum(options.kellyFraction, 0.25), 0, safeNum(options.maxPositionFraction, 0.05));

  return {
    action,
    side,
    reason,
    pUp,
    pDown,
    impliedUp: Number.isFinite(impliedUp) ? impliedUp : null,
    upCost: Number.isFinite(upCost) ? upCost : null,
    downCost: Number.isFinite(downCost) ? downCost : null,
    cost: Number.isFinite(cost) ? cost : null,
    edgeUp: Number.isFinite(edgeUp) ? edgeUp : null,
    edgeDown: Number.isFinite(edgeDown) ? edgeDown : null,
    edge: Number.isFinite(edge) ? edge : null,
    maxBid: Number.isFinite(maxBid) ? maxBid : null,
    maxUpBid,
    maxDownBid,
    feeRate,
    kelly,
    positionFraction: fraction,
  };
}

function buildPolymarketSample({ event, timeline, entryDelayHours, nowMs = Date.now(), entryMsOverride = null }) {
  const window = marketWindow(event);
  if (!window) return null;
  const latestMs = timeline[timeline.length - 1]?.ms;
  if (!Number.isFinite(latestMs) || window.startMs > latestMs) return null;

  const entryDelayMs = entryDelayHours * MS.hour;
  const intendedEntryMs = window.startMs + entryDelayMs;
  const hasResolvedData = window.endMs <= latestMs;
  const liveUpperMs = Math.min(latestMs, window.endMs - 60_000);
  const liveEntryMs = Number.isFinite(entryMsOverride)
    ? entryMsOverride
    : event.closed || hasResolvedData
    ? intendedEntryMs
    : clamp(nowMs, window.startMs, liveUpperMs);
  const entryMs = Number.isFinite(liveEntryMs) ? liveEntryMs : intendedEntryMs;
  if (!Number.isFinite(entryMs) || entryMs > latestMs) return null;

  const maxGapMs = Math.max(3 * intervalMedianMs(timeline), 90 * MS.min);
  const startIdx = nearestTimelineIndex(timeline, window.startMs, { direction: "nearest", maxGapMs });
  const entryIdx = nearestTimelineIndex(timeline, entryMs, { direction: "before", maxGapMs });
  const endIdx = hasResolvedData
    ? nearestTimelineIndex(timeline, window.endMs, { direction: "nearest", maxGapMs })
    : -1;
  if (startIdx < 0 || entryIdx < 0) return null;
  const start = timeline[startIdx];
  const entry = timeline[entryIdx];
  const end = endIdx >= 0 ? timeline[endIdx] : null;
  const outcome = hasResolvedData && end
    ? (event.resolvedOutcome || (end.priceClose >= start.priceClose ? "UP" : "DOWN"))
    : null;
  const durationMs = window.durationMs || Math.max(MS.hour, window.endMs - window.startMs);
  const distanceToStrike = (entry.priceClose - start.priceClose) / Math.max(1e-9, start.priceClose);
  const features = {
    distanceToStrike,
    elapsedPct: clamp((entry.ms - window.startMs) / durationMs, 0, 1),
    priceRet24: safeNum(entry.priceRet24, 0),
    priceRet72: safeNum(entry.priceRet72, 0),
    realizedVol24: safeNum(entry.realizedVol24, 0),
    realizedVol72: safeNum(entry.realizedVol72, 0),
    liqShock: safeNum(entry.liqShock, 0),
    fundingShock: safeNum(entry.fundingShock, 0),
    oiRet24: safeNum(entry.oiRet24, 0),
    cvdRet24: safeNum(entry.cvdRet24, 0),
    stateDurationHours: safeNum(entry.stateDurationHours, 0),
  };
  const trendKey = [entry.state, signedBucket(distanceToStrike, 0.001), signedBucket(features.priceRet24, 0.002)].join("|");
  return {
    type: "polymarket",
    slug: event.slug,
    title: event.title,
    question: event.question,
    frame: event.frame,
    event,
    startMs: window.startMs,
    endMs: window.endMs,
    entryMs,
    entryTimestamp: new Date(entry.ms).toISOString(),
    startPrice: start.priceClose,
    entryPrice: entry.priceClose,
    endPrice: end?.priceClose ?? null,
    outcome,
    state: entry.state,
    stateLabel: `State ${entry.state + 1}`,
    stateColor: entry.color,
    confidence: safeNum(entry.confidence, 0),
    features,
    trendKey,
  };
}

function buildPolymarketCandidateGroup({ event, timeline, options = {}, nowMs = Date.now() }) {
  const window = marketWindow(event);
  if (!window || !timeline.length) return null;
  const latestMs = timeline[timeline.length - 1]?.ms;
  if (!Number.isFinite(latestMs) || window.startMs > latestMs) return null;

  const scanStepMs = Math.max(MS.min, safeNum(options.scanStepMinutes, 5) * MS.min);
  const minEntryDelayMs = Math.max(0, safeNum(options.minEntryDelayMinutes, 5) * MS.min);
  const minTimeToResolveMs = Math.max(0, safeNum(options.minTimeToResolveMinutes, 5) * MS.min);
  const hasResolvedData = window.endMs <= latestMs;
  const scanStartMs = window.startMs + minEntryDelayMs;
  const scanEndMs = hasResolvedData
    ? window.endMs - minTimeToResolveMs
    : Math.min(nowMs, latestMs, window.endMs - minTimeToResolveMs);
  if (scanEndMs < scanStartMs) return null;

  const maxGapMs = Math.max(3 * intervalMedianMs(timeline), 90 * MS.min);
  const candidates = [];
  let lastCandidateMs = -Infinity;
  for (const row of timeline) {
    if (row.ms < scanStartMs || row.ms > scanEndMs) continue;
    if (row.ms - lastCandidateMs < scanStepMs - 1) continue;
    const sample = buildPolymarketSample({
      event,
      timeline,
      entryDelayHours: 0,
      nowMs,
      entryMsOverride: row.ms,
    });
    if (!sample) continue;
    if (Math.abs(sample.entryMs - row.ms) > maxGapMs) continue;
    candidates.push({
      ...sample,
      entryMode: "adaptive",
      candidateIndex: candidates.length,
      scanStepMinutes: scanStepMs / MS.min,
    });
    lastCandidateMs = row.ms;
  }

  if (!candidates.length) return null;
  return {
    slug: event.slug,
    event,
    frame: event.frame,
    startMs: window.startMs,
    endMs: window.endMs,
    candidates,
  };
}

function intervalMedianMs(timeline) {
  if (!timeline || timeline.length < 3) return MS.hour;
  const deltas = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const d = timeline[i].ms - timeline[i - 1].ms;
    if (d > 0) deltas.push(d);
  }
  return quantile(deltas, 0.5) || MS.hour;
}

function buildSynthetic4hSamples(timeline, options = {}) {
  if (!timeline.length) return [];
  const entryDelayMs = safeNum(options.entryDelayHours, 0.25) * MS.hour;
  const first = Math.ceil(timeline[0].ms / (4 * MS.hour)) * 4 * MS.hour;
  const last = timeline.at(-1).ms;
  const out = [];
  for (let startMs = first; startMs + 4 * MS.hour <= last; startMs += 4 * MS.hour) {
    const endMs = startMs + 4 * MS.hour;
    const entryMs = startMs + entryDelayMs;
    const startIdx = nearestTimelineIndex(timeline, startMs, { direction: "nearest", maxGapMs: 90 * MS.min });
    const entryIdx = nearestTimelineIndex(timeline, entryMs, { direction: "before", maxGapMs: 90 * MS.min });
    const endIdx = nearestTimelineIndex(timeline, endMs, { direction: "nearest", maxGapMs: 90 * MS.min });
    if (startIdx < 0 || entryIdx < 0 || endIdx < 0) continue;
    const start = timeline[startIdx];
    const entry = timeline[entryIdx];
    const end = timeline[endIdx];
    const distanceToStrike = (entry.priceClose - start.priceClose) / Math.max(1e-9, start.priceClose);
    const features = {
      distanceToStrike,
      elapsedPct: clamp((entry.ms - startMs) / (4 * MS.hour), 0, 1),
      priceRet24: safeNum(entry.priceRet24, 0),
      priceRet72: safeNum(entry.priceRet72, 0),
      realizedVol24: safeNum(entry.realizedVol24, 0),
      realizedVol72: safeNum(entry.realizedVol72, 0),
      liqShock: safeNum(entry.liqShock, 0),
      fundingShock: safeNum(entry.fundingShock, 0),
      oiRet24: safeNum(entry.oiRet24, 0),
      cvdRet24: safeNum(entry.cvdRet24, 0),
      stateDurationHours: safeNum(entry.stateDurationHours, 0),
    };
    out.push({
      type: "synthetic4h",
      slug: `synthetic-4h-${Math.floor(startMs / 1000)}`,
      title: `Synthetic BTC 4H ${new Date(startMs).toISOString()}`,
      question: "Synthetic BTC Up/Down 4H from Binance futures candles",
      frame: "4h",
      startMs,
      endMs,
      entryMs,
      entryTimestamp: new Date(entry.ms).toISOString(),
      startPrice: start.priceClose,
      entryPrice: entry.priceClose,
      endPrice: end.priceClose,
      outcome: end.priceClose >= start.priceClose ? "UP" : "DOWN",
      state: entry.state,
      stateLabel: `State ${entry.state + 1}`,
      stateColor: entry.color,
      confidence: safeNum(entry.confidence, 0),
      features,
      trendKey: [entry.state, signedBucket(distanceToStrike, 0.001), signedBucket(features.priceRet24, 0.002)].join("|"),
      syntheticOdds: 0.5,
    });
  }
  return out;
}

async function discoverDailyBitcoinUpDown({ pages = 8, limitPerType = 50, includeOpen = true } = {}) {
  const events = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page += 1) {
    const url = new URL(`${GAMMA_BASE}/public-search`);
    url.searchParams.set("q", "Bitcoin Up or Down daily");
    url.searchParams.set("limit_per_type", String(limitPerType));
    url.searchParams.set("page", String(page));
    const payload = await fetchJson(url.toString());
    for (const event of payload?.events || []) {
      const normalized = normalizeEvent(event);
      const isDaily = normalized.frame === "1d" && /bitcoin up or down/i.test(`${normalized.title} ${normalized.question}`);
      if (!isDaily || seen.has(normalized.slug)) continue;
      if (!includeOpen && !normalized.closed) continue;
      if (!normalized.upTokenId || !normalized.downTokenId || !normalized.endMs) continue;
      seen.add(normalized.slug);
      events.push(normalized);
    }
    if (!payload?.pagination?.hasMore) break;
  }
  return events.sort((a, b) => (a.endMs || 0) - (b.endMs || 0));
}

async function discoverFourHourBitcoinUpDown({ pages = 8, limitPerType = 50, includeOpen = true } = {}) {
  const events = [];
  const seen = new Set();
  const terms = [
    "Bitcoin Up or Down 12:00AM-4:00AM",
    "Bitcoin Up or Down 4:00AM-8:00AM",
    "Bitcoin Up or Down 8:00AM-12:00PM",
    "Bitcoin Up or Down 12:00PM-4:00PM",
    "Bitcoin Up or Down 4:00PM-8:00PM",
    "Bitcoin Up or Down 8:00PM-12:00AM",
  ];
  for (const term of terms) {
    for (let page = 1; page <= pages; page += 1) {
      const url = new URL(`${GAMMA_BASE}/public-search`);
      url.searchParams.set("q", term);
      url.searchParams.set("limit_per_type", String(limitPerType));
      url.searchParams.set("page", String(page));
      const payload = await fetchJson(url.toString());
      for (const event of payload?.events || []) {
        const normalized = normalizeEvent(event);
        const isFourHour = /^btc-updown-4h-/i.test(normalized.slug) || /^btc-updown-4h-/i.test(normalized.marketSlug);
        if (!isFourHour || seen.has(normalized.slug)) continue;
        if (!includeOpen && !normalized.closed) continue;
        if (!normalized.upTokenId || !normalized.downTokenId || !normalized.endMs) continue;
        seen.add(normalized.slug);
        events.push(normalized);
      }
      if (!payload?.pagination?.hasMore) break;
    }
  }
  return events.sort((a, b) => (a.endMs || 0) - (b.endMs || 0));
}

function listedAvailability(events) {
  return {
    hasLive: events.some((event) => event.active && !event.closed && event.acceptingOrders),
    live: events
      .filter((event) => event.active && !event.closed)
      .sort((a, b) => (a.endMs || 0) - (b.endMs || 0))
      .slice(0, 5),
    recent: events.slice(-5),
  };
}

async function discoverListed4hAvailability() {
  const matches = [];
  for (const term of ["BTC Up or Down 4H", "Bitcoin Up or Down 4 hour"]) {
    const url = new URL(`${GAMMA_BASE}/public-search`);
    url.searchParams.set("q", term);
    url.searchParams.set("limit_per_type", "20");
    const payload = await fetchJson(url.toString());
    for (const event of payload?.events || []) {
      const normalized = normalizeEvent(event);
      if (normalized.frame === "4h") matches.push(normalized);
    }
  }
  return {
    hasListed4h: matches.some((event) => event.active && !event.closed && event.acceptingOrders),
    matches: matches.slice(0, 5),
  };
}

async function fetchHistoricalUpProbability(tokenId, entryMs) {
  if (!tokenId) return null;
  const entrySec = Math.floor(entryMs / 1000);
  const url = new URL(`${CLOB_BASE}/prices-history`);
  url.searchParams.set("market", String(tokenId));
  url.searchParams.set("startTs", String(entrySec - 24 * 3600));
  url.searchParams.set("endTs", String(entrySec + 2 * 3600));
  url.searchParams.set("interval", "1h");
  url.searchParams.set("fidelity", "60");
  const payload = await fetchJson(url.toString());
  const history = (payload?.history || [])
    .map((row) => ({ t: safeNum(row.t, NaN), p: safeNum(row.p, NaN) }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.p));
  if (!history.length) return null;
  const before = history.filter((row) => row.t <= entrySec).sort((a, b) => b.t - a.t)[0];
  const nearest = before || history.sort((a, b) => Math.abs(a.t - entrySec) - Math.abs(b.t - entrySec))[0];
  if (!nearest || Math.abs(nearest.t - entrySec) > 26 * 3600) return null;
  return {
    impliedUp: clamp(nearest.p, 0.001, 0.999),
    oddsTimestamp: new Date(nearest.t * 1000).toISOString(),
    oddsAgeHours: (entrySec - nearest.t) / 3600,
  };
}

async function fetchHistoricalUpSeries(tokenId, startMs, endMs, fidelityMinutes = 5) {
  if (!tokenId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const url = new URL(`${CLOB_BASE}/prices-history`);
  url.searchParams.set("market", String(tokenId));
  url.searchParams.set("startTs", String(Math.floor(startMs / 1000)));
  url.searchParams.set("endTs", String(Math.ceil(endMs / 1000)));
  url.searchParams.set("interval", "max");
  url.searchParams.set("fidelity", String(Math.max(1, Math.round(fidelityMinutes))));
  const payload = await fetchJson(url.toString());
  return (payload?.history || [])
    .map((row) => ({ t: safeNum(row.t, NaN), p: safeNum(row.p, NaN) }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.p))
    .sort((a, b) => a.t - b.t);
}

function oddsFromHistoryAt(history, entryMs, maxAgeMinutes = 15) {
  if (!history?.length || !Number.isFinite(entryMs)) return null;
  const entrySec = Math.floor(entryMs / 1000);
  let lo = 0;
  let hi = history.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (history[mid].t <= entrySec) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const before = best >= 0 ? history[best] : null;
  const after = best + 1 < history.length ? history[best + 1] : null;
  const nearest = [before, after]
    .filter(Boolean)
    .sort((a, b) => Math.abs(a.t - entrySec) - Math.abs(b.t - entrySec))[0];
  if (!nearest) return null;
  const ageSeconds = Math.abs(nearest.t - entrySec);
  if (ageSeconds > Math.max(60, maxAgeMinutes * 60)) return null;
  return {
    impliedUp: clamp(nearest.p, 0.001, 0.999),
    oddsTimestamp: new Date(nearest.t * 1000).toISOString(),
    oddsAgeHours: (entrySec - nearest.t) / 3600,
  };
}

async function fetchBookQuote(tokenId) {
  if (!tokenId) return null;
  const url = new URL(`${CLOB_BASE}/book`);
  url.searchParams.set("token_id", String(tokenId));
  const book = await fetchJson(url.toString());
  const bids = (book?.bids || []).map((row) => ({ price: safeNum(row.price, NaN), size: safeNum(row.size, 0) })).filter((row) => Number.isFinite(row.price));
  const asks = (book?.asks || []).map((row) => ({ price: safeNum(row.price, NaN), size: safeNum(row.size, 0) })).filter((row) => Number.isFinite(row.price));
  const bestBid = bids.length ? Math.max(...bids.map((row) => row.price)) : NaN;
  const bestAsk = asks.length ? Math.min(...asks.map((row) => row.price)) : NaN;
  return {
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
    bidSize: bids.find((row) => row.price === bestBid)?.size ?? null,
    askSize: asks.find((row) => row.price === bestAsk)?.size ?? null,
    lastTradePrice: safeNum(book?.last_trade_price, NaN),
    tickSize: safeNum(book?.tick_size, NaN),
    minOrderSize: safeNum(book?.min_order_size, NaN),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function summarizeTrades(rows) {
  const trades = rows.filter((row) => row.decision?.action && row.decision.action !== "SKIP" && row.pnl != null);
  const wins = trades.filter((row) => row.pnl > 0).length;
  const totalPnl = trades.reduce((sum, row) => sum + row.pnl, 0);
  const totalCost = trades.reduce((sum, row) => sum + safeNum(row.decision.cost, 0), 0);
  const stakePerTrade = 1;
  const stakeInvested = trades.length * stakePerTrade;
  const stakePayout = trades.reduce((sum, row) => {
    const cost = safeNum(row.decision.cost, NaN);
    if (!Number.isFinite(cost) || cost <= 0) return sum;
    const won = row.decision.side === row.outcome;
    return sum + (won ? stakePerTrade / cost : 0);
  }, 0);
  const stakeNetPnl = stakePayout - stakeInvested;
  const brierRows = rows.filter((row) => row.outcome);
  const brier = brierRows.length
    ? mean(brierRows.map((row) => ((row.prediction?.pUp || 0.5) - (row.outcome === "UP" ? 1 : 0)) ** 2))
    : null;
  return {
    samples: rows.length,
    oddsSamples: rows.filter((row) => Number.isFinite(row.impliedUp)).length,
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    hitRate: trades.length ? wins / trades.length : 0,
    totalPnl,
    avgPnl: trades.length ? totalPnl / trades.length : 0,
    roiOnCost: totalCost > 0 ? totalPnl / totalCost : 0,
    stakePerTrade,
    stakeInvested,
    stakePayout,
    stakeNetPnl,
    stakeRoi: stakeInvested > 0 ? stakeNetPnl / stakeInvested : 0,
    avgEdge: trades.length ? mean(trades.map((row) => safeNum(row.decision.edge, 0))) : 0,
    brier,
  };
}

function stateEdgeTable(rows, states = []) {
  const stateMeta = new Map(states.map((state) => [state.state, state]));
  const groups = new Map();
  for (const row of rows) {
    if (!row.outcome) continue;
    const curr = groups.get(row.state) || { state: row.state, samples: 0, up: 0, preds: [], pnl: 0, trades: 0 };
    curr.samples += 1;
    if (row.outcome === "UP") curr.up += 1;
    if (row.prediction?.pUp != null) curr.preds.push(row.prediction.pUp);
    if (row.pnl != null && row.decision?.action !== "SKIP") {
      curr.pnl += row.pnl;
      curr.trades += 1;
    }
    groups.set(row.state, curr);
  }
  return [...groups.values()]
    .sort((a, b) => a.state - b.state)
    .map((row) => {
      const meta = stateMeta.get(row.state);
      return {
        state: row.state,
        label: meta?.label || `State ${row.state + 1}`,
        color: meta?.color || "#64748b",
        samples: row.samples,
        upRate: row.samples ? row.up / row.samples : 0,
        avgPredictedUp: row.preds.length ? mean(row.preds) : 0.5,
        trades: row.trades,
        pnl: row.pnl,
        avgPnl: row.trades ? row.pnl / row.trades : 0,
      };
    });
}

function applyBacktest(samples, options, { useSyntheticOdds = false, forceNoTrade = false } = {}) {
  const rows = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const training = samples.slice(0, i).filter((row) => row.outcome);
    const prediction = predictWithTraining(sample, training, options);
    const impliedUp = useSyntheticOdds ? sample.syntheticOdds : sample.impliedUp;
    const decision = decideTrade({
      prediction,
      impliedUp,
      market: sample.event,
      options,
      forceNoTrade,
    });
    let pnl = null;
    let stakeResult = null;
    if (sample.outcome && decision.action !== "SKIP") {
      const won = decision.side === sample.outcome;
      const cost = decision.side === "UP" ? decision.upCost : decision.downCost;
      pnl = won ? 1 - cost : -cost;
      const stake = 1;
      const shares = Number.isFinite(cost) && cost > 0 ? stake / cost : 0;
      const payout = won ? shares : 0;
      stakeResult = {
        stake,
        shares,
        payout,
        netPnl: payout - stake,
        roi: stake > 0 ? (payout - stake) / stake : 0,
      };
    }
    rows.push({
      ...sample,
      prediction,
      decision,
      pnl,
      stakeResult,
    });
  }
  return {
    rows,
    summary: summarizeTrades(rows),
  };
}

async function attachHistoricalOdds(samples, { concurrency = 5 } = {}) {
  const withOdds = await mapLimit(samples, concurrency, async (sample) => {
    if (!sample?.event?.upTokenId || !sample.outcome) return sample;
    try {
      const odds = await fetchHistoricalUpProbability(sample.event.upTokenId, sample.entryMs);
      return odds ? { ...sample, ...odds } : sample;
    } catch (error) {
      return { ...sample, oddsError: error?.message || "odds fetch failed" };
    }
  });
  return withOdds;
}

async function attachHistoricalOddsToGroups(groups, { concurrency = 5, fidelityMinutes = 5, maxAgeMinutes = 15 } = {}) {
  const withOdds = await mapLimit(groups, concurrency, async (group) => {
    const tokenId = group?.event?.upTokenId;
    const resolvedCandidates = (group?.candidates || []).filter((sample) => sample.outcome);
    if (!tokenId || !resolvedCandidates.length) return group;
    const minEntryMs = Math.min(...resolvedCandidates.map((sample) => sample.entryMs));
    const maxEntryMs = Math.max(...resolvedCandidates.map((sample) => sample.entryMs));
    try {
      const history = await fetchHistoricalUpSeries(
        tokenId,
        minEntryMs - 2 * MS.hour,
        maxEntryMs + 2 * MS.hour,
        fidelityMinutes,
      );
      return {
        ...group,
        candidates: group.candidates.map((sample) => {
          if (!sample.outcome) return sample;
          const odds = oddsFromHistoryAt(history, sample.entryMs, maxAgeMinutes);
          return odds ? { ...sample, ...odds } : sample;
        }),
      };
    } catch (error) {
      return {
        ...group,
        candidates: group.candidates.map((sample) => ({ ...sample, oddsError: error?.message || "odds fetch failed" })),
      };
    }
  });
  return withOdds;
}

function applyAdaptiveBacktest(groups, options) {
  const rows = [];
  const trainingRows = [];
  const sortedGroups = [...groups].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

  for (const group of sortedGroups) {
    const candidates = (group.candidates || [])
      .filter((sample) => sample.outcome)
      .sort((a, b) => a.entryMs - b.entryMs);
    if (!candidates.length) continue;

    let selected = null;
    let lastEvaluated = null;
    for (const sample of candidates) {
      const training = trainingRows.filter((row) => row.outcome && row.endMs <= sample.entryMs);
      const prediction = predictWithTraining(sample, training, options);
      const decision = decideTrade({
        prediction,
        impliedUp: sample.impliedUp,
        market: sample.event,
        options,
      });
      const evaluated = {
        ...sample,
        prediction,
        decision,
        evaluatedCandidates: candidates.length,
      };
      lastEvaluated = evaluated;
      if (decision.action !== "SKIP") {
        const won = decision.side === sample.outcome;
        const cost = decision.side === "UP" ? decision.upCost : decision.downCost;
        const pnl = won ? 1 - cost : -cost;
        const stake = 1;
        const shares = Number.isFinite(cost) && cost > 0 ? stake / cost : 0;
        const payout = won ? shares : 0;
        selected = {
          ...evaluated,
          pnl,
          stakeResult: {
            stake,
            shares,
            payout,
            netPnl: payout - stake,
            roi: stake > 0 ? (payout - stake) / stake : 0,
          },
        };
        break;
      }
    }

    rows.push(selected || {
      ...lastEvaluated,
      pnl: null,
      stakeResult: null,
    });
    trainingRows.push(...candidates);
  }

  return {
    rows,
    trainingRows,
    summary: summarizeTrades(rows),
  };
}

function latestSynthetic4h(timeline, options = {}) {
  if (!timeline.length) return null;
  const entry = timeline.at(-1);
  const startMs = Math.floor(entry.ms / (4 * MS.hour)) * 4 * MS.hour;
  const endMs = startMs + 4 * MS.hour;
  const startIdx = nearestTimelineIndex(timeline, startMs, { direction: "nearest", maxGapMs: 90 * MS.min });
  if (startIdx < 0) return null;
  const start = timeline[startIdx];
  const distanceToStrike = (entry.priceClose - start.priceClose) / Math.max(1e-9, start.priceClose);
  const features = {
    distanceToStrike,
    elapsedPct: clamp((entry.ms - startMs) / (4 * MS.hour), 0, 1),
    priceRet24: safeNum(entry.priceRet24, 0),
    priceRet72: safeNum(entry.priceRet72, 0),
    realizedVol24: safeNum(entry.realizedVol24, 0),
    realizedVol72: safeNum(entry.realizedVol72, 0),
    liqShock: safeNum(entry.liqShock, 0),
    fundingShock: safeNum(entry.fundingShock, 0),
    oiRet24: safeNum(entry.oiRet24, 0),
    cvdRet24: safeNum(entry.cvdRet24, 0),
    stateDurationHours: safeNum(entry.stateDurationHours, 0),
  };
  return {
    type: "synthetic4hLive",
    slug: `synthetic-4h-live-${Math.floor(startMs / 1000)}`,
    title: "Synthetic BTC 4H current window",
    question: "Synthetic BTC Up/Down 4H from Binance futures candles",
    frame: "4h",
    startMs,
    endMs,
    entryMs: entry.ms,
    entryTimestamp: new Date(entry.ms).toISOString(),
    startPrice: start.priceClose,
    entryPrice: entry.priceClose,
    endPrice: null,
    outcome: null,
    state: entry.state,
    stateLabel: `State ${entry.state + 1}`,
    stateColor: entry.color,
    confidence: safeNum(entry.confidence, 0),
    features,
    trendKey: [entry.state, signedBucket(distanceToStrike, 0.001), signedBucket(features.priceRet24, 0.002)].join("|"),
    syntheticOdds: 0.5,
    availabilityNote: "No listed Polymarket 4H market was found; use this as model research, not an executable Polymarket bid.",
  };
}

async function buildLiveRecommendation({ samples, events, options, label = "event" }) {
  const liveEvent = [...events]
    .filter((event) => event.active && !event.closed && event.acceptingOrders)
    .sort((a, b) => (a.endMs || 0) - (b.endMs || 0))[0];
  if (!liveEvent) return null;
  const liveSample = samples.find((sample) => sample.slug === liveEvent.slug);
  if (!liveSample) return {
    event: liveEvent,
    unavailableReason: `Regime timeline does not cover the live ${label} entry time.`,
  };

  const training = samples
    .filter((sample) => sample.outcome && sample.entryMs < liveSample.entryMs)
    .sort((a, b) => a.entryMs - b.entryMs);
  const prediction = predictWithTraining(liveSample, training, options);
  let upBook = null;
  let downBook = null;
  try {
    [upBook, downBook] = await Promise.all([
      fetchBookQuote(liveEvent.upTokenId),
      fetchBookQuote(liveEvent.downTokenId),
    ]);
  } catch {
    upBook = null;
    downBook = null;
  }
  const marketMid = Number.isFinite(liveEvent.outcomePrices?.[liveEvent.upIndex])
    ? liveEvent.outcomePrices[liveEvent.upIndex]
    : null;
  const bookMid = upBook?.bestBid != null && upBook?.bestAsk != null
    ? (upBook.bestBid + upBook.bestAsk) / 2
    : marketMid;
  const decision = decideTrade({
    prediction,
    impliedUp: bookMid,
    upAsk: upBook?.bestAsk ?? null,
    downAsk: downBook?.bestAsk ?? null,
    market: liveEvent,
    options,
  });
  return {
    ...liveSample,
    prediction,
    decision,
    upBook,
    downBook,
    impliedUp: bookMid,
  };
}

async function buildLiveRecommendationAdaptive({ timeline, events, trainingRows, options, label = "event" }) {
  const liveEvent = [...events]
    .filter((event) => event.active && !event.closed && event.acceptingOrders)
    .sort((a, b) => (a.endMs || 0) - (b.endMs || 0))[0];
  if (!liveEvent) return null;
  const liveSample = buildPolymarketSample({
    event: liveEvent,
    timeline,
    entryDelayHours: 0,
  });
  if (!liveSample) return {
    event: liveEvent,
    unavailableReason: `Regime timeline does not cover the live ${label} entry time.`,
  };
  const training = (trainingRows || [])
    .filter((sample) => sample.outcome && sample.endMs <= liveSample.entryMs)
    .sort((a, b) => a.entryMs - b.entryMs);
  const prediction = predictWithTraining(liveSample, training, options);
  let upBook = null;
  let downBook = null;
  try {
    [upBook, downBook] = await Promise.all([
      fetchBookQuote(liveEvent.upTokenId),
      fetchBookQuote(liveEvent.downTokenId),
    ]);
  } catch {
    upBook = null;
    downBook = null;
  }
  const marketMid = Number.isFinite(liveEvent.outcomePrices?.[liveEvent.upIndex])
    ? liveEvent.outcomePrices[liveEvent.upIndex]
    : null;
  const bookMid = upBook?.bestBid != null && upBook?.bestAsk != null
    ? (upBook.bestBid + upBook.bestAsk) / 2
    : marketMid;
  const decision = decideTrade({
    prediction,
    impliedUp: bookMid,
    upAsk: upBook?.bestAsk ?? null,
    downAsk: downBook?.bestAsk ?? null,
    market: liveEvent,
    options,
  });
  return {
    ...liveSample,
    prediction,
    decision,
    upBook,
    downBook,
    impliedUp: bookMid,
    entryMode: "adaptive",
  };
}

export async function buildPolymarketBtcUpDownResearch({
  dataset,
  fitK = 5,
  maxK = 8,
  hmmIterations = 10,
  selectedFeatures = null,
  marketPages = 8,
  maxDailyMarkets = 180,
  entryDelayHours = 1,
  minEdge = 0.035,
  minStateSamples = 12,
  slippageCents = 0.005,
  includeOdds = true,
  entryMode = "adaptive",
  scanStepMinutes = 5,
  minEntryDelayMinutes = 5,
  minTimeToResolveMinutes = 5,
} = {}) {
  const regime = buildPhatich4RegimeAnalysisFromDataset({
    dataset,
    fitK,
    maxK,
    hmmIterations,
    selectedFeatures,
  });
  const timeline = enrichTimeline(regime.timeline || [], regime.meta?.interval || "1h");
  const [dailyEvents, fourHourEvents] = await Promise.all([
    discoverDailyBitcoinUpDown({ pages: marketPages, includeOpen: true }),
    discoverFourHourBitcoinUpDown({ pages: marketPages, includeOpen: true }),
  ]);
  const recentEvents = dailyEvents
    .filter((event) => event.frame === "1d")
    .slice(-Math.max(20, maxDailyMarkets));
  const recent4hEvents = fourHourEvents
    .filter((event) => event.frame === "4h")
    .slice(-Math.max(40, Math.min(700, maxDailyMarkets * 4)));
  const fourHourEntryDelay = clamp(entryDelayHours, 0.25, 2);
  const options = {
    entryDelayHours,
    entryMode,
    scanStepMinutes,
    minEntryDelayMinutes,
    minTimeToResolveMinutes,
    minEdge,
    minStateSamples,
    slippageCents,
    priorN: 16,
    defaultFeeRate: 0.07,
    kellyFraction: 0.25,
    maxPositionFraction: 0.05,
  };

  let dailySamples = recentEvents
    .map((event) => buildPolymarketSample({ event, timeline, entryDelayHours }))
    .filter(Boolean)
    .sort((a, b) => a.entryMs - b.entryMs);

  if (includeOdds) {
    dailySamples = await attachHistoricalOdds(dailySamples, { concurrency: 5 });
  }

  let fourHourSamples = recent4hEvents
    .map((event) => buildPolymarketSample({ event, timeline, entryDelayHours: fourHourEntryDelay }))
    .filter(Boolean)
    .sort((a, b) => a.entryMs - b.entryMs);

  if (includeOdds) {
    fourHourSamples = await attachHistoricalOdds(fourHourSamples, { concurrency: 5 });
  }

  let dailyBacktest;
  let fourHourBacktest;
  let dailyAdaptiveGroups = [];
  let fourHourAdaptiveGroups = [];
  if (entryMode === "adaptive") {
    dailyAdaptiveGroups = recentEvents
      .map((event) => buildPolymarketCandidateGroup({ event, timeline, options }))
      .filter(Boolean);
    fourHourAdaptiveGroups = recent4hEvents
      .map((event) => buildPolymarketCandidateGroup({ event, timeline, options: { ...options, entryDelayHours: fourHourEntryDelay } }))
      .filter(Boolean);
    if (includeOdds) {
      [dailyAdaptiveGroups, fourHourAdaptiveGroups] = await Promise.all([
        attachHistoricalOddsToGroups(dailyAdaptiveGroups, {
          concurrency: 5,
          fidelityMinutes: scanStepMinutes,
          maxAgeMinutes: Math.max(15, scanStepMinutes * 2),
        }),
        attachHistoricalOddsToGroups(fourHourAdaptiveGroups, {
          concurrency: 5,
          fidelityMinutes: scanStepMinutes,
          maxAgeMinutes: Math.max(15, scanStepMinutes * 2),
        }),
      ]);
    }
    dailyBacktest = applyAdaptiveBacktest(dailyAdaptiveGroups, options);
    fourHourBacktest = applyAdaptiveBacktest(fourHourAdaptiveGroups, { ...options, entryDelayHours: fourHourEntryDelay });
  } else {
    dailyBacktest = applyBacktest(
      dailySamples.filter((sample) => sample.outcome),
      options,
    );
    fourHourBacktest = applyBacktest(
      fourHourSamples.filter((sample) => sample.outcome),
      { ...options, entryDelayHours: fourHourEntryDelay },
    );
  }
  const synthetic4hSamples = buildSynthetic4hSamples(timeline, { entryDelayHours: 0.25 })
    .slice(-Math.max(80, Math.min(600, maxDailyMarkets * 4)));
  const synthetic4hBacktest = applyBacktest(
    synthetic4hSamples,
    { ...options, minEdge: Math.max(minEdge, 0.025), slippageCents },
    { useSyntheticOdds: true },
  );

  const [liveDaily, live4hListed] = entryMode === "adaptive"
    ? await Promise.all([
      buildLiveRecommendationAdaptive({
        timeline,
        events: dailyEvents,
        trainingRows: dailyBacktest.trainingRows,
        options,
        label: "1D event",
      }),
      buildLiveRecommendationAdaptive({
        timeline,
        events: fourHourEvents,
        trainingRows: fourHourBacktest.trainingRows,
        options: { ...options, entryDelayHours: fourHourEntryDelay },
        label: "4H event",
      }),
    ])
    : await Promise.all([
      buildLiveRecommendation({
        samples: dailySamples,
        events: dailyEvents,
        options,
        label: "1D event",
      }),
      buildLiveRecommendation({
        samples: fourHourSamples,
        events: fourHourEvents,
        options: { ...options, entryDelayHours: fourHourEntryDelay },
        label: "4H event",
      }),
    ]);
  const availability4h = listedAvailability(fourHourEvents);
  const live4hFallbackSample = latestSynthetic4h(timeline, options);
  const live4hTraining = synthetic4hSamples.filter((sample) => sample.outcome && sample.entryMs < (live4hFallbackSample?.entryMs || 0));
  const live4hPrediction = live4hFallbackSample ? predictWithTraining(live4hFallbackSample, live4hTraining, options) : null;
  const live4hFallback = live4hFallbackSample ? {
    ...live4hFallbackSample,
    prediction: live4hPrediction,
    decision: decideTrade({
      prediction: live4hPrediction,
      impliedUp: 0.5,
      market: null,
      options,
      forceNoTrade: true,
    }),
  } : null;
  const live4h = live4hListed
    ? { ...live4hListed, listedAvailability: availability4h, isListedMarket: true }
    : (live4hFallback ? { ...live4hFallback, listedAvailability: availability4h, isListedMarket: false } : null);

  return {
    meta: {
      dataset: regime.meta?.dataset || dataset || null,
      interval: regime.meta?.interval,
      regimeRows: regime.meta?.rows,
      regimeStartTime: regime.meta?.startTime,
      regimeEndTime: regime.meta?.endTime,
      chosenK: regime.meta?.chosenK,
      marketEventsFetched: dailyEvents.length,
      fourHourEventsFetched: fourHourEvents.length,
      marketEventsUsed: recentEvents.length,
      fourHourEventsUsed: recent4hEvents.length,
      dailySamples: dailySamples.length,
      fourHourSamples: fourHourSamples.length,
      dailyAdaptiveGroups: dailyAdaptiveGroups.length,
      fourHourAdaptiveGroups: fourHourAdaptiveGroups.length,
      dailyAdaptiveCandidates: dailyAdaptiveGroups.reduce((sum, group) => sum + (group.candidates?.length || 0), 0),
      fourHourAdaptiveCandidates: fourHourAdaptiveGroups.reduce((sum, group) => sum + (group.candidates?.length || 0), 0),
      includeOdds,
      entryMode,
      entryDelayHours,
      scanStepMinutes,
      minEntryDelayMinutes,
      minTimeToResolveMinutes,
      minEdge,
      minStateSamples,
      slippageCents,
      fourHourEntryDelay,
      notes: [
        "Daily market windows use Polymarket Gamma metadata and CLOB price history for the Up token.",
        "4H market windows use Polymarket Gamma/CLOB when matching btc-updown-4h markets exist. Resolution source can be Chainlink BTC/USD, while regime features may use Binance BTCUSDT; treat that as basis risk.",
        "Historical odds are sampled from CLOB prices-history near the configured entry time; rows without odds remain useful for calibration but not PnL.",
      ],
    },
    regime: {
      latest: regime.latest,
      states: regime.states,
    },
    liveDaily,
    live4h,
    dailyBacktest: {
      summary: dailyBacktest.summary,
      stateEdges: stateEdgeTable(dailyBacktest.rows, regime.states || []),
      trades: dailyBacktest.rows
        .filter((row) => row.decision?.action !== "SKIP" || row.slug === liveDaily?.slug)
        .slice(-80)
        .map(compactResultRow),
      skippedMissingOdds: dailyBacktest.rows.filter((row) => !Number.isFinite(row.impliedUp)).length,
    },
    fourHourBacktest: {
      summary: fourHourBacktest.summary,
      stateEdges: stateEdgeTable(fourHourBacktest.rows, regime.states || []),
      trades: fourHourBacktest.rows
        .filter((row) => row.decision?.action !== "SKIP")
        .slice(-80)
        .map(compactResultRow),
      skippedMissingOdds: fourHourBacktest.rows.filter((row) => !Number.isFinite(row.impliedUp)).length,
    },
    synthetic4hBacktest: {
      summary: synthetic4hBacktest.summary,
      stateEdges: stateEdgeTable(synthetic4hBacktest.rows, regime.states || []),
      trades: synthetic4hBacktest.rows
        .filter((row) => row.decision?.action !== "SKIP")
        .slice(-40)
        .map(compactResultRow),
    },
    marketSamples: dailySamples.slice(-40).map(compactSampleRow),
  };
}

function compactSampleRow(row) {
  return {
    slug: row.slug,
    title: row.title,
    frame: row.frame,
    entryTimestamp: row.entryTimestamp,
    startTime: new Date(row.startMs).toISOString(),
    endTime: new Date(row.endMs).toISOString(),
    state: row.state,
    stateLabel: row.stateLabel,
    stateColor: row.stateColor,
    confidence: row.confidence,
    startPrice: row.startPrice,
    entryPrice: row.entryPrice,
    endPrice: row.endPrice,
    distanceToStrike: row.features?.distanceToStrike,
    outcome: row.outcome,
    impliedUp: row.impliedUp ?? null,
    oddsTimestamp: row.oddsTimestamp ?? null,
    volumeNum: row.event?.volumeNum ?? null,
    entryMode: row.entryMode || null,
    evaluatedCandidates: row.evaluatedCandidates ?? null,
  };
}

function compactResultRow(row) {
  return {
    ...compactSampleRow(row),
    prediction: row.prediction ? {
      pUp: row.prediction.pUp,
      baselineP: row.prediction.baselineP,
      stateP: row.prediction.stateP,
      neighborP: row.prediction.neighborP,
      trendP: row.prediction.trendP,
      stateCount: row.prediction.stateCount,
      sampleSize: row.prediction.sampleSize,
      ci: row.prediction.ci,
      reason: row.prediction.reason,
    } : null,
    decision: row.decision || null,
    pnl: row.pnl,
    stakeResult: row.stakeResult,
  };
}
