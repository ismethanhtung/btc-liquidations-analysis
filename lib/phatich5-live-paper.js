import { buildPolymarketBtcUpDownResearch } from "./polymarket-btc-updown.js";
import {
  getLivePaperStoreInfo,
  readLivePaperState,
  writeLivePaperState,
} from "./live-paper-store.js";
import { ensureDatasetUpToDate } from "./phatich4-regime.js";

const DEFAULTS = {
  source: "local",
  years: 0.05,
  interval: "5m",
  exchangeList: "Binance",
  symbol: "BTC",
  fitK: null,
  maxK: 8,
  hmmIterations: 10,
  marketPages: 4,
  maxDailyMarkets: 120,
  entryMode: "adaptive",
  scanStepMinutes: 5,
  minEntryDelayMinutes: 5,
  minTimeToResolveMinutes: 5,
  minEdge: 0.035,
  minStateSamples: 12,
  slippageCents: 0.005,
  stakeUsd: 1,
};

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function envNum(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseFitK(value) {
  if (value == null || value === "" || value === "auto") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nowIso() {
  return new Date().toISOString();
}

function makeRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function tradeIdFor(row, side) {
  const slug = String(row?.slug || "unknown").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `${slug}:${side}`;
}

function asMs(value) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveConfig(overrides = {}) {
  const hasApiKey = Boolean(process.env.COINGLASS_API_KEY);
  const wantedSource = process.env.LIVE_PAPER_SOURCE || DEFAULTS.source;
  const source = wantedSource === "api" && hasApiKey ? "api" : "local";
  return {
    ...DEFAULTS,
    source,
    apiKey: process.env.COINGLASS_API_KEY,
    dataset: process.env.LIVE_PAPER_DATASET || overrides.dataset || undefined,
    years: envNum("LIVE_PAPER_YEARS", DEFAULTS.years),
    interval: process.env.LIVE_PAPER_INTERVAL || DEFAULTS.interval,
    exchangeList: process.env.LIVE_PAPER_EXCHANGE_LIST || DEFAULTS.exchangeList,
    symbol: process.env.LIVE_PAPER_SYMBOL || DEFAULTS.symbol,
    fitK: parseFitK(process.env.LIVE_PAPER_FIT_K ?? overrides.fitK ?? DEFAULTS.fitK),
    maxK: envNum("LIVE_PAPER_MAX_K", DEFAULTS.maxK),
    hmmIterations: envNum("LIVE_PAPER_HMM_ITERATIONS", DEFAULTS.hmmIterations),
    marketPages: envNum("LIVE_PAPER_MARKET_PAGES", DEFAULTS.marketPages),
    maxDailyMarkets: envNum("LIVE_PAPER_MAX_MARKETS", DEFAULTS.maxDailyMarkets),
    entryMode: process.env.LIVE_PAPER_ENTRY_MODE || DEFAULTS.entryMode,
    scanStepMinutes: envNum("LIVE_PAPER_SCAN_STEP_MINUTES", DEFAULTS.scanStepMinutes),
    minEntryDelayMinutes: envNum("LIVE_PAPER_MIN_ENTRY_DELAY_MINUTES", DEFAULTS.minEntryDelayMinutes),
    minTimeToResolveMinutes: envNum("LIVE_PAPER_MIN_TIME_TO_RESOLVE_MINUTES", DEFAULTS.minTimeToResolveMinutes),
    minEdge: envNum("LIVE_PAPER_MIN_EDGE", DEFAULTS.minEdge),
    minStateSamples: envNum("LIVE_PAPER_MIN_STATE_SAMPLES", DEFAULTS.minStateSamples),
    slippageCents: envNum("LIVE_PAPER_SLIPPAGE_CENTS", DEFAULTS.slippageCents),
    stakeUsd: envNum("LIVE_PAPER_STAKE_USD", DEFAULTS.stakeUsd),
  };
}

function publicConfig(config) {
  const { apiKey, ...rest } = config;
  return rest;
}

async function buildResearchWithFallback(config, warnings) {
  try {
    return await buildPolymarketBtcUpDownResearch(config);
  } catch (error) {
    if (config.source !== "api") throw error;
    warnings.push(`Realtime regime failed, fell back to local dataset: ${error?.message || "unknown error"}`);
    return buildPolymarketBtcUpDownResearch({
      ...config,
      source: "local",
      apiKey: undefined,
    });
  }
}

function liveRowsFromResearch(research) {
  return [
    { horizon: "1D", row: research?.liveDaily },
    { horizon: "4H", row: research?.live4h },
  ].filter(({ row }) => row && row.isListedMarket !== false);
}

function resolvedRowsFromResearch(research) {
  const rows = [
    ...(research?.dailyBacktest?.trades || []),
    ...(research?.fourHourBacktest?.trades || []),
    ...(research?.marketSamples || []),
  ];
  const bySlug = new Map();
  for (const row of rows) {
    if (!row?.slug || !row?.outcome) continue;
    bySlug.set(row.slug, row);
  }
  return bySlug;
}

function openTradeFromLiveRow({ row, horizon, runId, stakeUsd }) {
  const decision = row?.decision || {};
  const side = decision.side;
  const cost = safeNum(decision.cost, NaN);
  const stake = Math.max(0.01, safeNum(stakeUsd, 1));
  const shares = Number.isFinite(cost) && cost > 0 ? stake / cost : 0;

  const prediction = row.prediction || decision.prediction || {};
  const predictionDetails = {
    pUp: prediction.pUp ?? row.pUp ?? decision.pUp ?? null,
    pDown: prediction.pUp != null ? 1 - prediction.pUp : (decision.pDown ?? null),
    baselineP: prediction.baselineP ?? null,
    stateP: prediction.stateP ?? null,
    trendP: prediction.trendP ?? null,
    neighborP: prediction.neighborP ?? null,
    sampleSize: prediction.sampleSize ?? null,
    stateCount: prediction.stateCount ?? null,
    trendCount: prediction.trendCount ?? null,
    weights: prediction.weights ?? null,
    baseWeight: prediction.baseWeight ?? null,
    weightSum: prediction.weightSum ?? null,
    stateReliability: prediction.stateReliability ?? null,
    trendReliability: prediction.trendReliability ?? null,
    neighborReliability: prediction.neighborReliability ?? null,
    trendKey: prediction.trendKey ?? null,
    state: row.state ?? null,
    stateLabel: row.stateLabel || null,
    ci: prediction.ci ?? null,
    reason: prediction.reason ?? null,
    features: prediction.features || (row.features ? {
      distanceToStrike: row.features.distanceToStrike,
      priceRet24: row.features.priceRet24,
    } : row.distanceToStrike !== undefined ? {
      distanceToStrike: row.distanceToStrike,
      priceRet24: row.priceRet24
    } : null),
    impliedUp: row.impliedUp ?? decision.impliedUp ?? null,
    cost,
    side,
    edge: decision.edge ?? null,
    kelly: decision.kelly ?? null,
    positionFraction: decision.positionFraction ?? null,
    feeRate: decision.feeRate ?? null,
    upCost: decision.upCost ?? null,
    downCost: decision.downCost ?? null,
    edgeUp: decision.edgeUp ?? null,
    edgeDown: decision.edgeDown ?? null,
  };

  return {
    id: tradeIdFor(row, side),
    status: "OPEN",
    runId,
    horizon,
    openedAt: nowIso(),
    marketSlug: row.slug,
    title: row.title || row.question || row.slug,
    frame: row.frame || horizon.toLowerCase(),
    action: decision.action,
    side,
    stakeUsd: stake,
    shares,
    cost,
    maxBid: decision.maxBid ?? null,
    edge: decision.edge ?? null,
    edgeUp: decision.edgeUp ?? null,
    edgeDown: decision.edgeDown ?? null,
    impliedUp: row.impliedUp ?? decision.impliedUp ?? null,
    pUp: row.prediction?.pUp ?? decision.pUp ?? null,
    pDown: row.prediction ? 1 - row.prediction.pUp : decision.pDown ?? null,
    state: row.state ?? null,
    stateLabel: row.stateLabel || null,
    confidence: row.confidence ?? null,
    entryTimestamp: row.entryTimestamp || nowIso(),
    entryMs: asMs(row.entryMs ?? row.entryTimestamp),
    startMs: asMs(row.startMs),
    endMs: asMs(row.endMs),
    startPrice: row.startPrice ?? null,
    entryPrice: row.entryPrice ?? null,
    reason: decision.reason || null,
    predictionDetails,
  };
}

function shouldOpenTrade(row) {
  const decision = row?.decision || {};
  if (!row?.slug || decision.action === "SKIP") return false;
  if (decision.side !== "UP" && decision.side !== "DOWN") return false;
  if (!Number.isFinite(safeNum(decision.cost, NaN))) return false;
  if (row.endMs && Date.now() >= Number(row.endMs)) return false;
  return true;
}

function settleTrade(trade, resolvedRow) {
  const outcome = resolvedRow?.outcome;
  if (outcome !== "UP" && outcome !== "DOWN") return trade;
  const won = trade.side === outcome;
  const stake = safeNum(trade.stakeUsd, 1);
  const shares = safeNum(trade.shares, 0);
  const payout = won ? shares : 0;
  return {
    ...trade,
    status: "SETTLED",
    settledAt: nowIso(),
    outcome,
    won,
    endPrice: resolvedRow.endPrice ?? trade.endPrice ?? null,
    payoutUsd: payout,
    netPnlUsd: payout - stake,
    roi: stake > 0 ? (payout - stake) / stake : 0,
  };
}

function markPendingIfPastEnd(trade) {
  if (trade.status !== "OPEN") return trade;
  const endMs = asMs(trade.endMs);
  if (!endMs || Date.now() < endMs + 60_000) return trade;
  return {
    ...trade,
    status: "PENDING_SETTLEMENT",
    pendingSettlementAt: trade.pendingSettlementAt || nowIso(),
  };
}

function summarizeState(state) {
  const trades = state.trades || [];
  const open = trades.filter((trade) => trade.status === "OPEN");
  const pending = trades.filter((trade) => trade.status === "PENDING_SETTLEMENT");
  const settled = trades.filter((trade) => trade.status === "SETTLED");
  const wins = settled.filter((trade) => trade.won).length;
  const stakeInvested = settled.reduce((sum, trade) => sum + safeNum(trade.stakeUsd, 0), 0);
  const netPnl = settled.reduce((sum, trade) => sum + safeNum(trade.netPnlUsd, 0), 0);
  return {
    totalTrades: trades.length,
    openTrades: open.length,
    pendingTrades: pending.length,
    settledTrades: settled.length,
    wins,
    losses: settled.length - wins,
    hitRate: settled.length ? wins / settled.length : 0,
    stakeInvested,
    netPnl,
    roi: stakeInvested > 0 ? netPnl / stakeInvested : 0,
  };
}

export async function getLivePaperSnapshot() {
  const state = await readLivePaperState();
  return {
    ok: true,
    store: getLivePaperStoreInfo(),
    summary: summarizeState(state),
    runs: [...state.runs].slice(-80).reverse(),
    trades: [...state.trades].slice(-300).reverse(),
  };
}

export async function runLivePaperTick(overrides = {}) {
  const runId = makeRunId();
  const startedAt = nowIso();
  const warnings = [];
  const config = resolveConfig(overrides);

  if (config.source === "local" || !config.apiKey) {
    await ensureDatasetUpToDate(config.dataset);
  }

  const store = getLivePaperStoreInfo();
  const state = await readLivePaperState();
  const research = await buildResearchWithFallback(config, warnings);
  const resolvedBySlug = resolvedRowsFromResearch(research);

  let settled = 0;
  const trades = (state.trades || []).map((trade) => {
    if (trade.status !== "OPEN" && trade.status !== "PENDING_SETTLEMENT") return trade;
    const resolved = resolvedBySlug.get(trade.marketSlug);
    if (resolved?.outcome) {
      settled += 1;
      return settleTrade(trade, resolved);
    }
    return markPendingIfPastEnd(trade);
  });

  const skipped = [];
  const opened = [];
  const existingMarketSlugs = new Set(trades.map((trade) => trade.marketSlug));
  for (const candidate of liveRowsFromResearch(research)) {
    const row = candidate.row;
    if (existingMarketSlugs.has(row.slug)) {
      skipped.push({ horizon: candidate.horizon, slug: row.slug, reason: "already tracked" });
      continue;
    }
    if (!shouldOpenTrade(row)) {
      skipped.push({
        horizon: candidate.horizon,
        slug: row.slug,
        action: row.decision?.action || "N/A",
        reason: row.decision?.reason || "no executable signal",
      });
      continue;
    }
    const trade = openTradeFromLiveRow({
      row,
      horizon: candidate.horizon,
      runId,
      stakeUsd: config.stakeUsd,
    });
    trades.push(trade);
    opened.push(trade);
    existingMarketSlugs.add(row.slug);
  }

  const run = {
    id: runId,
    startedAt,
    finishedAt: nowIso(),
    status: "ok",
    source: research.meta?.source || config.source,
    dataset: research.meta?.dataset || config.dataset || null,
    interval: research.meta?.interval || config.interval,
    chosenK: research.meta?.chosenK ?? null,
    storage: store.kind,
    opened: opened.length,
    settled,
    skipped,
    warnings,
  };

  const nextState = {
    ...state,
    runs: [...(state.runs || []), run].slice(-200),
    trades: trades.slice(-1000),
  };
  const writeInfo = await writeLivePaperState(nextState);
  return {
    ok: true,
    run,
    writeInfo,
    store,
    config: publicConfig(config),
    summary: summarizeState(nextState),
    opened,
    settled,
    skipped,
    warnings,
  };
}
