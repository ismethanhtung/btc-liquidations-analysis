"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, createChart, createSeriesMarkers } from "lightweight-charts";

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtInt(n) {
  return intFmt.format(Number.isFinite(n) ? n : 0);
}

function fmtUsd(n) {
  return `$${fmtInt(Math.round(Number(n) || 0))}`;
}

function fmtTs(iso) {
  if (!iso) return "N/A";
  return iso.replace(".000Z", "Z");
}

function fmtRetShort(ret) {
  const pct = Number(ret || 0) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function gradeScore(score) {
  const s = Number(score || 0);
  if (s >= 0.75) return { label: "Tốt", tone: "good", note: ">= 0.75" };
  if (s >= 0.6) return { label: "Khá", tone: "ok", note: "0.60-0.74" };
  if (s >= 0.45) return { label: "Trung tính", tone: "neutral", note: "0.45-0.59" };
  return { label: "Rủi ro", tone: "bad", note: "< 0.45" };
}

function gradeProbability(p) {
  const v = Number(p || 0);
  if (v >= 0.65) return { label: "Mạnh", tone: "good", note: ">= 65%" };
  if (v >= 0.55) return { label: "Nghiêng", tone: "ok", note: "55-64%" };
  if (v >= 0.45) return { label: "Cân bằng", tone: "neutral", note: "45-54%" };
  return { label: "Yếu", tone: "bad", note: "< 45%" };
}

function gradeExpectedRet(ret) {
  const r = Number(ret || 0);
  if (r >= 0.01) return { label: "Tốt", tone: "good", note: ">= 1.0%" };
  if (r >= 0.003) return { label: "Khá", tone: "ok", note: "0.3-0.99%" };
  if (r >= 0) return { label: "Mỏng", tone: "neutral", note: "0-0.29%" };
  return { label: "Âm", tone: "bad", note: "< 0%" };
}

function nearestRow(rows, targetMs) {
  if (!rows.length || !Number.isFinite(targetMs)) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid].ts < targetMs) lo = mid + 1;
    else hi = mid;
  }
  const a = rows[lo];
  const b = rows[Math.max(0, lo - 1)];
  return Math.abs(a.ts - targetMs) < Math.abs(b.ts - targetMs) ? a : b;
}

function sameHour(isoA, isoB) {
  if (!isoA || !isoB) return false;
  return isoA.slice(0, 13) === isoB.slice(0, 13);
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

function nearestIndexByTs(list, targetMs, accessor) {
  if (!list.length || !Number.isFinite(targetMs)) return -1;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (accessor(list[mid]) < targetMs) lo = mid + 1;
    else hi = mid;
  }
  const aIdx = lo;
  const bIdx = Math.max(0, lo - 1);
  const a = accessor(list[aIdx]);
  const b = accessor(list[bIdx]);
  return Math.abs(a - targetMs) < Math.abs(b - targetMs) ? aIdx : bIdx;
}

function buildEventDetail(rows, candles, opts, eventTs, eventRet, threshold, entryIso, exitIso) {
  if (!rows.length || !candles.length || !Number.isFinite(eventTs)) return null;
  const rowIdx = nearestIndexByTs(rows, eventTs, (r) => r.ts);
  if (rowIdx < 0) return null;

  const stepMs = medianStepMs(candles, rows);
  const barsPerHour = Math.max(1, Math.round(3600000 / stepMs));
  const zWindowBars = Math.max(10, Math.round((opts.zWindowHours || 168) * barsPerHour));
  const rowStart = 0;
  const rowEnd = rows.length - 1;
  const dataRows = rows;
  const totals = rows.map((r) => r.totalUsd);

  const pointAt = (idx) => {
    if (!Number.isFinite(idx) || idx < 0 || idx >= rows.length) return null;
    const r = rows[idx];
    const wStart = Math.max(0, idx - zWindowBars + 1);
    const w = totals.slice(wStart, idx + 1);
    const z = (r.totalUsd - mean(w)) / std(w);
    const longShare = r.totalUsd > 0 ? r.longUsd / r.totalUsd : 0;
    const candleIdx = nearestIndexByTs(candles, r.ts, (c) => Number(c.time) * 1000);
    const candle = candleIdx >= 0 ? candles[candleIdx] : null;
    return {
      ts: r.ts,
      iso: r.timestamp,
      totalUsd: r.totalUsd,
      longUsd: r.longUsd,
      shortUsd: r.shortUsd,
      longShare,
      longSharePct: longShare * 100,
      z,
      close: candle?.close ?? null
    };
  };

  const eventPoint = pointAt(rowIdx);

  const dataSeries = dataRows.map((r, offset) => {
    const i = rowStart + offset;
    const p = pointAt(i);
    return {
      time: Math.floor(r.ts / 1000),
      totalUsd: p.totalUsd,
      longUsd: p.longUsd,
      shortUsd: p.shortUsd,
      longSharePct: p.longSharePct,
      z: p.z,
      isEvent: r.ts === eventPoint.ts
    };
  });

  const priceCandles = candles;
  const entryMs = entryIso ? Date.parse(entryIso) : Number.NaN;
  const exitMs = exitIso ? Date.parse(exitIso) : Number.NaN;
  const entryIdx = Number.isFinite(entryMs) ? nearestIndexByTs(rows, entryMs, (r) => r.ts) : -1;
  const exitIdx = Number.isFinite(exitMs) ? nearestIndexByTs(rows, exitMs, (r) => r.ts) : -1;
  const entryPoint = pointAt(entryIdx);
  const exitPoint = pointAt(exitIdx);
  const priceByTime = new Map(priceCandles.map((c) => [Number(c.time), Number(c.close)]));
  const dataByTime = new Map(dataSeries.map((d) => [Number(d.time), d]));

  return {
    eventTs: eventPoint.ts,
    eventIso: eventPoint.iso,
    eventTotalUsd: eventPoint.totalUsd,
    eventLongUsd: eventPoint.longUsd,
    eventShortUsd: eventPoint.shortUsd,
    eventLongShare: eventPoint.longShare,
    eventZ: eventPoint.z,
    threshold,
    eventClose: eventPoint.close,
    eventRet: Number.isFinite(eventRet) ? eventRet : null,
    entryPoint,
    exitPoint,
    priceCandles,
    dataSeries,
    priceByTime,
    dataByTime
  };
}

function buildCascadeAnalysis(rows, candles, opts) {
  if (!rows.length || !candles.length) {
    return { events: [], summary: { count: 0, winRate: 0, avgRet: 0, holdBars: 0, entryDelayBars: 0 } };
  }

  const stepMs = medianStepMs(candles, rows);
  const barsPerHour = Math.max(1, Math.round(3600000 / stepMs));
  const zWindowBars = Math.max(10, Math.round((opts.zWindowHours || 168) * barsPerHour));
  const entryDelayBars = Math.max(0, Math.round((opts.entryDelayHours || 0) * barsPerHour));
  const holdBars = Math.max(1, Math.round((opts.holdHours || 8) * barsPerHour));

  const priceByTs = new Map(candles.map((c) => [Number(c.time) * 1000, c]));
  const merged = rows.map((r) => ({ ...r, candle: priceByTs.get(r.ts) })).filter((x) => x.candle);
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

    const entryIdx = i + entryDelayBars;
    const exitIdx = entryIdx + holdBars;
    if (exitIdx >= merged.length) continue;
    const entry = merged[entryIdx].candle.close;
    const exit = merged[exitIdx].candle.close;
    const ret = entry > 0 ? (exit - entry) / entry : 0;
    events.push({
      ts: m.ts,
      timestamp: m.timestamp,
      totalUsd: m.totalUsd,
      longShare,
      z,
      entryTs: merged[entryIdx].timestamp,
      exitTs: merged[exitIdx].timestamp,
      ret,
      win: ret > 0
    });
  }

  const winCount = events.filter((e) => e.win).length;
  return {
    events,
    summary: {
      count: events.length,
      winRate: events.length ? winCount / events.length : 0,
      avgRet: events.length ? mean(events.map((e) => e.ret)) : 0,
      holdBars,
      entryDelayBars,
      threshold
    }
  };
}

async function fetchBinanceCandles(startIso, endIso, interval = "1h") {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const out = [];
  let cursor = startMs;
  const stepMs = interval === "30m" ? 1800_000 : 3600_000;

  while (cursor < endMs) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endMs));
    url.searchParams.set("limit", "1000");

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const r of rows) {
      out.push({
        time: Math.floor(Number(r[0]) / 1000),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4])
      });
    }

    cursor = Number(rows[rows.length - 1][0]) + stepMs;
    if (rows.length < 1000) break;
  }

  return out;
}

export default function AnalysisDashboard({ datasets, chosen, stats, rows, cascadeOptions, mode = "analysis" }) {
  const chartRef = useRef(null);
  const chartApiRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const [candles, setCandles] = useState([]);
  const [hoverTs, setHoverTs] = useState(rows[rows.length - 1]?.ts ?? null);
  const [chartErr, setChartErr] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function run() {
      if (!stats?.summary?.rangeStart || !stats?.summary?.rangeEnd) return;
      try {
        setChartErr(null);
        const stepMs = medianStepMs([], rows);
        const interval = stepMs <= 1800_000 ? "30m" : "1h";
        const data = await fetchBinanceCandles(stats.summary.rangeStart, stats.summary.rangeEnd, interval);
        if (!mounted) return;
        setCandles(data);
      } catch (e) {
        if (!mounted) return;
        setChartErr(e.message || "Failed to fetch Binance candles");
      }
    }
    run();
    return () => { mounted = false; };
  }, [stats?.summary?.rangeStart, stats?.summary?.rangeEnd]);

  useEffect(() => {
    if (!chartRef.current) return;

    const chart = createChart(chartRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#6f7686"
      },
      rightPriceScale: { borderColor: "#e2e4e8" },
      timeScale: { borderColor: "#e2e4e8", timeVisible: true, secondsVisible: false },
      grid: {
        vertLines: { color: "#f0f2f5" },
        horzLines: { color: "#f0f2f5" }
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626"
    });

    chartApiRef.current = chart;
    candleSeriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      if (!param || !param.time) return;
      const t = typeof param.time === "number" ? param.time * 1000 : null;
      if (t) setHoverTs(t);
    });

    return () => chart.remove();
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    candleSeriesRef.current.setData(candles);
    if (chartApiRef.current && candles.length) {
      chartApiRef.current.timeScale().fitContent();
      setHoverTs(candles[candles.length - 1].time * 1000);
    }
  }, [candles]);

  const hoverIso = hoverTs ? new Date(hoverTs).toISOString() : null;
  const near = useMemo(() => nearestRow(rows, hoverTs), [rows, hoverTs]);
  const hoverMonth = hoverIso ? hoverIso.slice(0, 7) : null;
  const hoverMonthCoverage = stats.byMonth.find((m) => m.month === hoverMonth) || null;
  const cascade = useMemo(() => buildCascadeAnalysis(rows, candles, cascadeOptions || {}), [rows, candles, cascadeOptions]);
  const isAnalysis2 = mode === "analysis2";
  const isAnalysis3 = mode === "analysis3";
  const basePath = isAnalysis2 ? "/analysis-2" : (isAnalysis3 ? "/analysis-3" : "/analysis");
  const [optResult, setOptResult] = useState(null);
  const [optLoading, setOptLoading] = useState(false);
  const [optError, setOptError] = useState("");
  const [futureInferResult, setFutureInferResult] = useState(null);
  const [futureInferLoading, setFutureInferLoading] = useState(false);
  const [futureInferError, setFutureInferError] = useState("");
  const [startingCapital, setStartingCapital] = useState(1000);
  const [selectedEventTs, setSelectedEventTs] = useState(null);
  const [selectedCustomTrade, setSelectedCustomTrade] = useState(null);
  const [detailHoverTs, setDetailHoverTs] = useState(null);
  const detailPriceRef = useRef(null);
  const detailDataRef = useRef(null);
  const detailPriceChartApiRef = useRef(null);
  const detailDataChartApiRef = useRef(null);
  const detailPriceSeriesApiRef = useRef(null);
  const detailDataSeriesApiRef = useRef(null);
  const syncRangeRef = useRef(false);
  const syncCrosshairRef = useRef(false);
  const [optRanges, setOptRanges] = useState({
    qMin: 0.9, qMax: 0.99, qStep: 0.01,
    longMin: 0.6, longMax: 0.9, longStep: 0.05,
    zMin: 1, zMax: 3, zStep: 0.5,
    delayMin: 0, delayMax: 3, delayStep: 0.5,
    holdMin: 1, holdMax: 24, holdStep: 1,
    zWindowHours: Number(cascadeOptions?.zWindowHours || 168),
    minEvents: 15
  });
  const [inferRanges, setInferRanges] = useState({
    delayMin: 0,
    delayMax: 3,
    delayStep: 0.5,
    holdMin: 1,
    holdMax: 24,
    holdStep: 1
  });
  const [inferScoring, setInferScoring] = useState({
    riskPenalty: 0.5,
    holdPenaltyPerHour: 0.0005,
    delayPenaltyPerHour: 0.0002,
    uncertaintyPenalty: 0.35,
    minExpectedRet: -0.03,
    regimeBias: 0.01
  });
  const [inferMemory, setInferMemory] = useState({
    k: 40,
    minHistoryEvents: 80
  });
  const [inferRegime, setInferRegime] = useState({
    horizonHours: 6,
    retThreshold: 0.008,
    drawdownThreshold: 0.015
  });

  const selectedCascadeEvent = useMemo(
    () => cascade.events.find((e) => e.ts === selectedEventTs) || null,
    [cascade.events, selectedEventTs]
  );

  const selectedTrade = selectedCustomTrade || selectedCascadeEvent || null;

  const selectedEventDetail = useMemo(
    () => buildEventDetail(
      rows,
      candles,
      cascadeOptions || {},
      selectedEventTs,
      selectedTrade?.ret,
      cascade.summary.threshold || 0,
      selectedTrade?.entryTs,
      selectedTrade?.exitTs
    ),
    [rows, candles, cascadeOptions, selectedEventTs, selectedTrade?.ret, cascade.summary.threshold, selectedTrade?.entryTs, selectedTrade?.exitTs]
  );

  const allCascadeEventSecSet = useMemo(
    () => new Set(cascade.events.map((e) => Math.floor(e.ts / 1000))),
    [cascade.events]
  );

  const allFutureRelatedSecSet = useMemo(
    () => new Set((futureInferResult?.regime?.topNeighbors || []).map((e) => Math.floor(Number(e.ts || 0) / 1000))),
    [futureInferResult]
  );

  const detailPriceMarkers = useMemo(() => {
    if (!selectedEventDetail) return [];
    const selectedSec = Math.floor(selectedEventDetail.eventTs / 1000);
    return cascade.events
      .filter((e) => selectedEventDetail.priceByTime.has(Math.floor(e.ts / 1000)))
      .map((e) => {
        const sec = Math.floor(e.ts / 1000);
        const wl = e.win ? "W" : "L";
        return {
        time: sec,
        position: "aboveBar",
        shape: sec === selectedSec ? "square" : "circle",
        color: sec === selectedSec ? "#dc2626" : "#f59e0b",
        text: sec === selectedSec ? `E ${wl} ${fmtRetShort(e.ret)}` : `E ${wl} ${fmtRetShort(e.ret)}`,
        size: sec === selectedSec ? 2 : 1
      };
      });
  }, [selectedEventDetail, cascade.events]);

  const detailDataMarkers = useMemo(() => {
    if (!selectedEventDetail) return [];
    const selectedSec = Math.floor(selectedEventDetail.eventTs / 1000);
    return cascade.events
      .filter((e) => selectedEventDetail.dataByTime.has(Math.floor(e.ts / 1000)))
      .map((e) => {
        const sec = Math.floor(e.ts / 1000);
        const wl = e.win ? "W" : "L";
        return {
        time: sec,
        position: "inBar",
        shape: sec === selectedSec ? "square" : "circle",
        color: sec === selectedSec ? "#dc2626" : "#f59e0b",
        text: sec === selectedSec ? `E ${wl} ${fmtRetShort(e.ret)}` : `E ${wl} ${fmtRetShort(e.ret)}`,
        size: sec === selectedSec ? 2 : 1
      };
      });
  }, [selectedEventDetail, cascade.events]);

  useEffect(() => {
    if (selectedEventTs === null) return;
    if (!cascade.events.some((e) => e.ts === selectedEventTs) && !allFutureRelatedSecSet.has(Math.floor(selectedEventTs / 1000))) {
      setSelectedEventTs(null);
      setSelectedCustomTrade(null);
    }
  }, [cascade.events, selectedEventTs, allFutureRelatedSecSet]);

  useEffect(() => {
    setDetailHoverTs(selectedEventDetail?.eventTs ?? null);
  }, [selectedEventDetail]);

  useEffect(() => {
    if (!detailPriceRef.current || !selectedEventDetail) return;

    const chart = createChart(detailPriceRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#6f7686"
      },
      rightPriceScale: { borderColor: "#e2e4e8" },
      timeScale: { borderColor: "#e2e4e8", timeVisible: true, secondsVisible: false },
      grid: {
        vertLines: { color: "#f0f2f5" },
        horzLines: { color: "#f0f2f5" }
      },
      autoSize: true
    });

    const candlesSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626"
    });
    candlesSeries.setData(selectedEventDetail.priceCandles);
    createSeriesMarkers(candlesSeries, detailPriceMarkers);
    detailPriceChartApiRef.current = chart;
    detailPriceSeriesApiRef.current = candlesSeries;

    if (Number.isFinite(selectedEventDetail.eventClose) && selectedEventDetail.priceCandles.length) {
      const first = selectedEventDetail.priceCandles[0].time;
      const last = selectedEventDetail.priceCandles[selectedEventDetail.priceCandles.length - 1].time;
      const eventPriceLine = chart.addSeries(LineSeries, {
        color: "#0f172a",
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false
      });
      eventPriceLine.setData([
        { time: first, value: selectedEventDetail.eventClose },
        { time: last, value: selectedEventDetail.eventClose }
      ]);
    }

    const onPriceRange = (range) => {
      if (!range || syncRangeRef.current || !detailDataChartApiRef.current) return;
      syncRangeRef.current = true;
      try {
        detailDataChartApiRef.current.timeScale().setVisibleLogicalRange(range);
      } finally {
        syncRangeRef.current = false;
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onPriceRange);

    const onPriceCrosshairMove = (param) => {
      if (!param?.time) {
        detailDataChartApiRef.current?.clearCrosshairPosition();
        return;
      }
      if (typeof param.time !== "number") return;
      const dataIdx = nearestIndexByTs(selectedEventDetail.dataSeries, param.time * 1000, (d) => Number(d.time) * 1000);
      if (dataIdx < 0) return;
      const mapped = selectedEventDetail.dataSeries[dataIdx];
      const time = Number(mapped.time);
      setDetailHoverTs(time * 1000);
      if (syncCrosshairRef.current || !detailDataChartApiRef.current || !detailDataSeriesApiRef.current) return;
      syncCrosshairRef.current = true;
      try {
        detailDataChartApiRef.current.setCrosshairPosition(mapped.totalUsd, time, detailDataSeriesApiRef.current);
      } finally {
        syncCrosshairRef.current = false;
      }
    };
    chart.subscribeCrosshairMove(onPriceCrosshairMove);

    chart.timeScale().fitContent();
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onPriceRange);
      chart.unsubscribeCrosshairMove(onPriceCrosshairMove);
      detailPriceSeriesApiRef.current = null;
      detailPriceChartApiRef.current = null;
      chart.remove();
    };
  }, [selectedEventDetail, detailPriceMarkers]);

  useEffect(() => {
    if (!detailDataRef.current || !selectedEventDetail) return;

    const chart = createChart(detailDataRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#6f7686"
      },
      leftPriceScale: { visible: false, borderColor: "#e2e4e8" },
      rightPriceScale: { visible: true, borderColor: "#e2e4e8" },
      timeScale: { borderColor: "#e2e4e8", timeVisible: true, secondsVisible: false },
      grid: {
        vertLines: { color: "#f0f2f5" },
        horzLines: { color: "#f0f2f5" }
      },
      autoSize: true
    });

    const totalSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      priceFormat: { type: "volume" },
      color: "#334155"
    });
    totalSeries.setData(selectedEventDetail.dataSeries.map((d) => ({
      time: d.time,
      value: d.totalUsd,
      color: d.isEvent ? "#dc2626" : (allCascadeEventSecSet.has(d.time) ? "#f59e0b" : "#334155")
    })));
    createSeriesMarkers(totalSeries, detailDataMarkers);
    detailDataChartApiRef.current = chart;
    detailDataSeriesApiRef.current = totalSeries;

    const longShareSeries = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: "#2563eb",
      lineWidth: 2,
      priceLineVisible: false
    });
    longShareSeries.setData(selectedEventDetail.dataSeries.map((d) => ({ time: d.time, value: d.longSharePct })));

    const zSeries = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      color: "#7c3aed",
      lineWidth: 2,
      priceLineVisible: false
    });
    zSeries.setData(selectedEventDetail.dataSeries.map((d) => ({ time: d.time, value: d.z })));

    const onDataRange = (range) => {
      if (!range || syncRangeRef.current || !detailPriceChartApiRef.current) return;
      syncRangeRef.current = true;
      try {
        detailPriceChartApiRef.current.timeScale().setVisibleLogicalRange(range);
      } finally {
        syncRangeRef.current = false;
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onDataRange);

    const onDataCrosshairMove = (param) => {
      if (!param?.time) {
        detailPriceChartApiRef.current?.clearCrosshairPosition();
        return;
      }
      if (typeof param.time !== "number") return;
      const priceIdx = nearestIndexByTs(selectedEventDetail.priceCandles, param.time * 1000, (c) => Number(c.time) * 1000);
      if (priceIdx < 0) return;
      const pricePoint = selectedEventDetail.priceCandles[priceIdx];
      const time = Number(pricePoint.time);
      setDetailHoverTs(time * 1000);
      if (syncCrosshairRef.current || !detailPriceChartApiRef.current || !detailPriceSeriesApiRef.current) return;
      const close = Number(pricePoint.close);
      if (!Number.isFinite(close)) return;
      syncCrosshairRef.current = true;
      try {
        detailPriceChartApiRef.current.setCrosshairPosition(close, time, detailPriceSeriesApiRef.current);
      } finally {
        syncCrosshairRef.current = false;
      }
    };
    chart.subscribeCrosshairMove(onDataCrosshairMove);

    chart.timeScale().fitContent();
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onDataRange);
      chart.unsubscribeCrosshairMove(onDataCrosshairMove);
      detailDataSeriesApiRef.current = null;
      detailDataChartApiRef.current = null;
      chart.remove();
    };
  }, [selectedEventDetail, detailDataMarkers, allCascadeEventSecSet]);

  async function runOptimize() {
    setOptError("");
    setOptLoading(true);
    try {
      const payloadRows = rows.map((r) => ({ ts: r.ts, totalUsd: r.totalUsd, longUsd: r.longUsd }));
      const payloadCandles = candles.map((c) => ({ time: c.time, close: c.close }));
      const res = await fetch("/api/analysis/cascade-optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payloadRows, candles: payloadCandles, ranges: optRanges })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Optimize failed: ${res.status}`);
      setOptResult(json);
    } catch (e) {
      setOptError(e?.message || "Tối ưu thất bại.");
      setOptResult(null);
    } finally {
      setOptLoading(false);
    }
  }

  async function runFutureInfer() {
    setFutureInferError("");
    setFutureInferLoading(true);
    try {
      const payloadRows = rows.map((r) => ({
        ts: r.ts,
        timestamp: r.timestamp,
        totalUsd: r.totalUsd,
        longUsd: r.longUsd,
        shortUsd: r.shortUsd
      }));
      const payloadCandles = candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }));
      const res = await fetch("/api/analysis/cascade-future-infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: payloadRows,
          candles: payloadCandles,
          filters: {
            q: Number(cascadeOptions?.q ?? 0.95),
            minLongShare: Number(cascadeOptions?.minLongShare ?? 0.65),
            zMin: Number(cascadeOptions?.zMin ?? 1.5),
            zWindowHours: Number(cascadeOptions?.zWindowHours ?? 168)
          },
          ranges: inferRanges,
          scoring: inferScoring,
          memory: inferMemory,
          regime: inferRegime,
          targetTs: Number(selectedEventTs || 0),
          baseline: {
            entryDelayHours: Number(cascadeOptions?.entryDelayHours ?? 1),
            holdHours: Number(cascadeOptions?.holdHours ?? 8)
          }
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Future inference failed: ${res.status}`);
      setFutureInferResult(json);
      if (json?.targetEvent?.ts) {
        setSelectedEventTs(Number(json.targetEvent.ts));
      }
    } catch (e) {
      setFutureInferError(e?.message || "Suy luận tương lai thất bại.");
      setFutureInferResult(null);
    } finally {
      setFutureInferLoading(false);
    }
  }

  const capitalProjection = useMemo(() => {
    const initial = Number(startingCapital || 0);
    if (!Number.isFinite(initial) || initial <= 0) {
      return { initial: 0, final: 0, pnl: 0, roi: 0 };
    }
    let capital = initial;
    for (const e of cascade.events) {
      capital *= (1 + Number(e.ret || 0));
    }
    const pnl = capital - initial;
    const roi = initial > 0 ? pnl / initial : 0;
    return { initial, final: capital, pnl, roi };
  }, [startingCapital, cascade.events]);

  const detailHoverSnapshot = useMemo(() => {
    if (!selectedEventDetail || !Number.isFinite(detailHoverTs)) return null;
    const dataIdx = nearestIndexByTs(selectedEventDetail.dataSeries, detailHoverTs, (d) => Number(d.time) * 1000);
    const priceIdx = nearestIndexByTs(selectedEventDetail.priceCandles, detailHoverTs, (c) => Number(c.time) * 1000);
    if (dataIdx < 0 && priceIdx < 0) return null;
    const dataPoint = dataIdx >= 0 ? selectedEventDetail.dataSeries[dataIdx] : null;
    const pricePoint = priceIdx >= 0 ? selectedEventDetail.priceCandles[priceIdx] : null;
    const ts = dataPoint ? dataPoint.time * 1000 : pricePoint.time * 1000;
    return {
      iso: new Date(ts).toISOString(),
      close: pricePoint?.close ?? null,
      totalUsd: dataPoint?.totalUsd ?? null,
      longUsd: dataPoint?.longUsd ?? null,
      shortUsd: dataPoint?.shortUsd ?? null,
      longSharePct: dataPoint?.longSharePct ?? null,
      z: dataPoint?.z ?? null
    };
  }, [selectedEventDetail, detailHoverTs]);

  const regimeMeanRevertGrade = gradeProbability(futureInferResult?.regime?.probs?.mean_revert || 0);
  const regimeTrendDownGrade = gradeProbability(futureInferResult?.regime?.probs?.trend_down || 0);
  const regimeChopGrade = gradeProbability(futureInferResult?.regime?.probs?.chop || 0);
  const chosenScoreGrade = gradeScore(futureInferResult?.actions?.chosen?.score || 0);
  const chosenRetGrade = gradeExpectedRet(futureInferResult?.actions?.chosen?.expectedRet || 0);

  return (
    <div className="panel-shell space-y-4">
      <div className="panel-header px-5 py-4">
        <h1 className="text-[18px] font-semibold">
          {isAnalysis2 ? "Phân tích 2 (Tối ưu tham số)" : (isAnalysis3 ? "Phân tích 3 (Future Inference theo Event)" : "Phân tích Liquidation (Dễ hiểu cho người mới)")}
        </h1>
        <p className="text-[12px] text-[var(--text-muted)]">Di chuột trên chart nến BTC để đồng bộ các số liệu bên dưới theo mốc thời gian.</p>
      </div>

      <div className="px-5 pt-4">
        <div className="flex flex-wrap gap-2">
          {datasets.map((name) => (
            <a key={name} href={`${basePath}?dataset=${encodeURIComponent(name)}`} className={`badge ${name === chosen ? "" : "opacity-70"}`}>
              {name}
            </a>
          ))}
        </div>
        <p className="text-[11px] text-[var(--text-muted)] mt-2">Dataset đang xem: {chosen || "N/A"}</p>
      </div>

      <div className="px-5">
        <div className="border border-[var(--border-color)] p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[12px] font-semibold">BTCUSDT Candlestick (Binance, TradingView)</p>
            <p className="text-[11px] text-[var(--text-muted)]">Cursor: {fmtTs(hoverIso)}</p>
          </div>
          <div ref={chartRef} className="w-full h-[460px]" />
          {chartErr && <p className="text-[11px] text-[var(--danger-text)] mt-2">Lỗi tải dữ liệu chart: {chartErr}</p>}
        </div>
      </div>

      {isAnalysis2 ? (
        <div className="px-5">
          <div className="border border-[var(--border-color)] p-3 space-y-3">
            <p className="text-[12px] font-semibold">Tối ưu tham số (quét tổ hợp)</p>
            <div className="grid gap-2 lg:grid-cols-6">
              <InputSmall label="Q min" value={optRanges.qMin} onChange={(v) => setOptRanges((s) => ({ ...s, qMin: v }))} />
              <InputSmall label="Q max" value={optRanges.qMax} onChange={(v) => setOptRanges((s) => ({ ...s, qMax: v }))} />
              <InputSmall label="Q step" value={optRanges.qStep} onChange={(v) => setOptRanges((s) => ({ ...s, qStep: v }))} />
              <InputSmall label="Long min" value={optRanges.longMin} onChange={(v) => setOptRanges((s) => ({ ...s, longMin: v }))} />
              <InputSmall label="Long max" value={optRanges.longMax} onChange={(v) => setOptRanges((s) => ({ ...s, longMax: v }))} />
              <InputSmall label="Long step" value={optRanges.longStep} onChange={(v) => setOptRanges((s) => ({ ...s, longStep: v }))} />
              <InputSmall label="Z min" value={optRanges.zMin} onChange={(v) => setOptRanges((s) => ({ ...s, zMin: v }))} />
              <InputSmall label="Z max" value={optRanges.zMax} onChange={(v) => setOptRanges((s) => ({ ...s, zMax: v }))} />
              <InputSmall label="Z step" value={optRanges.zStep} onChange={(v) => setOptRanges((s) => ({ ...s, zStep: v }))} />
              <InputSmall label="Delay min (giờ)" value={optRanges.delayMin} onChange={(v) => setOptRanges((s) => ({ ...s, delayMin: v }))} />
              <InputSmall label="Delay max (giờ)" value={optRanges.delayMax} onChange={(v) => setOptRanges((s) => ({ ...s, delayMax: v }))} />
              <InputSmall label="Delay step (giờ)" value={optRanges.delayStep} onChange={(v) => setOptRanges((s) => ({ ...s, delayStep: v }))} />
              <InputSmall label="Hold min (giờ)" value={optRanges.holdMin} onChange={(v) => setOptRanges((s) => ({ ...s, holdMin: v }))} />
              <InputSmall label="Hold max (giờ)" value={optRanges.holdMax} onChange={(v) => setOptRanges((s) => ({ ...s, holdMax: v }))} />
              <InputSmall label="Hold step (giờ)" value={optRanges.holdStep} onChange={(v) => setOptRanges((s) => ({ ...s, holdStep: v }))} />
              <InputSmall label="Z window (h)" value={optRanges.zWindowHours} onChange={(v) => setOptRanges((s) => ({ ...s, zWindowHours: v }))} />
              <InputSmall label="Min events" value={optRanges.minEvents} onChange={(v) => setOptRanges((s) => ({ ...s, minEvents: v }))} />
            </div>
            <button onClick={runOptimize} className="border border-[var(--border-color)] px-3 py-2 text-[11px] font-semibold">
              {optLoading ? "Đang tối ưu..." : "Tối ưu ngay"}
            </button>
            <p className="text-[11px] text-[var(--text-muted)]">Tất cả Delay/Hold đều tính theo giờ. Bạn có thể nhập step thập phân (ví dụ 0.5 giờ) để quét chi tiết cho dataset 30m. Mặc định quét Quantile từ 0.90 đến 0.99.</p>
            {optError ? <p className="text-[11px] text-[var(--danger-text)]">{optError}</p> : null}
            {optResult ? (
              <div className="max-h-[320px] overflow-auto thin-scrollbar">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                      <th className="py-2">Q</th><th className="py-2">Long</th><th className="py-2">Z</th><th className="py-2">Delay</th><th className="py-2">Hold</th><th className="py-2">Events</th><th className="py-2">Win</th><th className="py-2">AvgRet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optResult.top.map((x, i) => (
                      <tr key={`${x.q}-${x.minLongShare}-${x.zMin}-${x.entryDelayHours}-${x.holdHours}-${i}`} className="border-b border-[var(--border-color)]/70">
                        <td className="py-2">{x.q}</td><td className="py-2">{x.minLongShare}</td><td className="py-2">{x.zMin}</td><td className="py-2">{x.entryDelayHours}h</td><td className="py-2">{x.holdHours}h</td><td className="py-2">{x.count}</td><td className="py-2">{pctFmt.format(x.winRate * 100)}%</td><td className="py-2">{pctFmt.format(x.avgRet * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-[var(--text-muted)] mt-2">Đã test {fmtInt(optResult.tested)} tổ hợp.</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {isAnalysis3 ? (
        <div className="px-5">
          <div className="border border-[var(--border-color)] p-3 space-y-3">
            <p className="text-[12px] font-semibold">Future Inference (Snapshot hiện tại -&gt; so với event quá khứ -&gt; logits/softmax -&gt; chọn Delay/Hold)</p>
            <div className="grid gap-2 lg:grid-cols-6">
              <InputSmall label="Delay min (giờ)" value={inferRanges.delayMin} onChange={(v) => setInferRanges((s) => ({ ...s, delayMin: v }))} info="Độ trễ vào lệnh nhỏ nhất hệ thống sẽ thử. 0 nghĩa là vào ngay khi event xuất hiện." />
              <InputSmall label="Delay max (giờ)" value={inferRanges.delayMax} onChange={(v) => setInferRanges((s) => ({ ...s, delayMax: v }))} info="Độ trễ vào lệnh lớn nhất hệ thống sẽ thử khi chấm action." />
              <InputSmall label="Delay step (giờ)" value={inferRanges.delayStep} onChange={(v) => setInferRanges((s) => ({ ...s, delayStep: v }))} info="Bước nhảy của delay. Ví dụ min=0, max=2, step=0.5 sẽ tạo 0h, 0.5h, 1h, 1.5h, 2h." />
              <InputSmall label="Hold min (giờ)" value={inferRanges.holdMin} onChange={(v) => setInferRanges((s) => ({ ...s, holdMin: v }))} info="Thời gian giữ lệnh ngắn nhất hệ thống xét." />
              <InputSmall label="Hold max (giờ)" value={inferRanges.holdMax} onChange={(v) => setInferRanges((s) => ({ ...s, holdMax: v }))} info="Thời gian giữ lệnh dài nhất hệ thống xét." />
              <InputSmall label="Hold step (giờ)" value={inferRanges.holdStep} onChange={(v) => setInferRanges((s) => ({ ...s, holdStep: v }))} info="Bước nhảy của hold. Step nhỏ hơn cho nhiều phương án hơn nhưng chạy lâu hơn." />
              <InputSmall label="K neighbors" value={inferMemory.k} onChange={(v) => setInferMemory((s) => ({ ...s, k: v }))} info="Số event quá khứ giống nhất được lấy làm bộ nhớ để vote regime và ước lượng expected return/risk." />
              <InputSmall label="Min history events" value={inferMemory.minHistoryEvents} onChange={(v) => setInferMemory((s) => ({ ...s, minHistoryEvents: v }))} info="Số lượng event lịch sử tối thiểu trước target. Nếu ít hơn ngưỡng này, hệ thống từ chối suy luận để tránh overfit." />
              <InputSmall label="Regime horizon (h)" value={inferRegime.horizonHours} onChange={(v) => setInferRegime((s) => ({ ...s, horizonHours: v }))} info="Khoảng thời gian nhìn về phía trước để gán nhãn regime lịch sử khi train online memory." />
              <InputSmall label="Regime ret threshold" value={inferRegime.retThreshold} onChange={(v) => setInferRegime((s) => ({ ...s, retThreshold: v }))} info="Ngưỡng return để coi là quay đầu hoặc sập tiếp. Ví dụ 0.008 tức +/-0.8%." />
              <InputSmall label="Regime drawdown thres" value={inferRegime.drawdownThreshold} onChange={(v) => setInferRegime((s) => ({ ...s, drawdownThreshold: v }))} info="Ngưỡng drawdown âm dùng để nhận diện trạng thái trend-down mạnh." />
              <InputSmall label="Risk penalty (MAE)" value={inferScoring.riskPenalty} onChange={(v) => setInferScoring((s) => ({ ...s, riskPenalty: v }))} info="Hệ số phạt rủi ro MAE khi tính raw score. Càng cao thì hệ thống càng né phương án có drawdown lớn." />
              <InputSmall label="Hold penalty/h" value={inferScoring.holdPenaltyPerHour} onChange={(v) => setInferScoring((s) => ({ ...s, holdPenaltyPerHour: v }))} info="Phí phạt theo mỗi giờ giữ lệnh để tránh ưu tiên phương án giữ quá lâu." />
              <InputSmall label="Delay penalty/h" value={inferScoring.delayPenaltyPerHour} onChange={(v) => setInferScoring((s) => ({ ...s, delayPenaltyPerHour: v }))} info="Phí phạt theo mỗi giờ chờ vào lệnh. Dùng để ưu tiên các setup phản ứng nhanh hơn khi lợi thế tương đương." />
              <InputSmall label="Uncertainty penalty" value={inferScoring.uncertaintyPenalty} onChange={(v) => setInferScoring((s) => ({ ...s, uncertaintyPenalty: v }))} info="Phạt độ bất định của expected return (độ lệch chuẩn trên tập neighbors)." />
              <InputSmall label="Regime bias" value={inferScoring.regimeBias} onChange={(v) => setInferScoring((s) => ({ ...s, regimeBias: v }))} info="Bias cộng thêm khi xác suất mean-revert cao hơn trend-down, giúp ưu tiên action phù hợp regime." />
              <InputSmall label="Min expected ret" value={inferScoring.minExpectedRet} onChange={(v) => setInferScoring((s) => ({ ...s, minExpectedRet: v }))} info="Ngưỡng lợi nhuận kỳ vọng tối thiểu để giữ lại action. Action thấp hơn ngưỡng sẽ bị loại." />
            </div>
            <button onClick={runFutureInfer} className="border border-[var(--border-color)] px-3 py-2 text-[11px] font-semibold">
              {futureInferLoading ? "Đang suy luận..." : "Suy luận cho event đang chọn (hoặc event mới nhất)"}
            </button>
            <p className="text-[11px] text-[var(--text-muted)]">
              Luồng chạy: lấy snapshot feature tại <code>t0</code> của event target, tìm <code>K</code> event quá khứ giống nhất bằng cosine similarity (trên feature đã chuẩn hóa), cộng trọng số theo class để ra <code>raw regime scores -&gt; logits -&gt; softmax probabilities</code>, rồi tính expected metrics từng <code>Delay/Hold</code> bằng weighted average từ chính nhóm neighbors này.
            </p>
            <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
              <p className="text-[11px] font-semibold mb-2">Thang đọc nhanh để user căn quyết định</p>
              <div className="grid gap-2 lg:grid-cols-2 text-[10px] text-[var(--text-muted)]">
                <p><b>Score:</b> Tốt <code>&gt;=0.75</code>, Khá <code>0.60-0.74</code>, Trung tính <code>0.45-0.59</code>, Rủi ro <code>&lt;0.45</code>.</p>
                <p><b>Regime Prob:</b> Mạnh <code>&gt;=65%</code>, Nghiêng <code>55-64%</code>, Cân bằng <code>45-54%</code>, Yếu <code>&lt;45%</code>.</p>
                <p><b>Expected Ret:</b> Tốt <code>&gt;=1.0%</code>, Khá <code>0.3-0.99%</code>, Mỏng <code>0-0.29%</code>, Âm <code>&lt;0%</code>.</p>
                <p><b>Expected MAE:</b> càng gần 0 càng an toàn; ví dụ <code>-0.5%</code> thường an toàn hơn <code>-2.0%</code>.</p>
              </div>
            </div>
            {futureInferError ? <p className="text-[11px] text-[var(--danger-text)]">{futureInferError}</p> : null}
            {futureInferResult ? (
              <div className="space-y-3">
                <div className="grid gap-3 lg:grid-cols-4">
                  <Metric label="Detected events" value={fmtInt(futureInferResult?.meta?.detectedEvents || 0)} helper="Số event thoả filter q/longShare/z." info="Tổng event hệ thống phát hiện trong dataset với bộ lọc hiện tại. Đây là tập nguồn để tạo target và lịch sử." />
                  <Metric label="History events" value={fmtInt(futureInferResult?.meta?.historyEvents || 0)} helper="Số event quá khứ trước target để so sánh." info="Chỉ đếm các event có thời gian trước target event. Điều này đảm bảo suy luận mô phỏng đúng điều kiện tương lai (không nhìn trước)." />
                  <Metric label="K used" value={fmtInt(futureInferResult?.meta?.kUsed || 0)} helper="Số neighbors dùng để vote regime + estimate action." info="Sau khi tính similarity, hệ thống chỉ giữ top-K event giống nhất để làm bộ nhớ gần nhất cho quyết định." />
                  <Metric label="Target event" value={fmtTs(futureInferResult?.targetEvent?.timestamp)} helper="Event đang được suy luận như thể nó vừa xảy ra." info="Đây là event được xem như thời điểm hiện tại t0. Mọi dự đoán delay/hold đều được sinh ra từ snapshot tại mốc này." />
                </div>
                <div className="grid gap-3 lg:grid-cols-4">
                  <Metric label="Mean Revert %" value={`${pctFmt.format((futureInferResult?.regime?.probs?.mean_revert || 0) * 100)}% (${regimeMeanRevertGrade.label})`} helper={`logit=${Number(futureInferResult?.regime?.logits?.mean_revert || 0).toFixed(3)} | ${regimeMeanRevertGrade.note}`} info="Xác suất regime quay đầu tăng. Được tính bằng softmax từ logits do top-K neighbors bỏ phiếu trọng số." />
                  <Metric label="Trend Down %" value={`${pctFmt.format((futureInferResult?.regime?.probs?.trend_down || 0) * 100)}% (${regimeTrendDownGrade.label})`} helper={`logit=${Number(futureInferResult?.regime?.logits?.trend_down || 0).toFixed(3)} | ${regimeTrendDownGrade.note}`} info="Xác suất regime tiếp tục giảm sau event hiện tại." />
                  <Metric label="Chop %" value={`${pctFmt.format((futureInferResult?.regime?.probs?.chop || 0) * 100)}% (${regimeChopGrade.label})`} helper={`logit=${Number(futureInferResult?.regime?.logits?.chop || 0).toFixed(3)} | ${regimeChopGrade.note}`} info="Xác suất regime đi ngang/nhiễu, tức lợi thế directional thấp." />
                  <Metric label="Actions evaluated" value={fmtInt(futureInferResult?.actions?.totalEvaluated || 0)} helper="Số cặp delay/hold đủ sample để chấm điểm." info="Không phải tất cả cặp delay/hold đều hợp lệ; cặp nào sample từ neighbors quá ít sẽ bị loại." />
                </div>
                {futureInferResult?.actions?.chosen ? (
                  <div className="border border-[var(--border-color)] p-3">
                    <p className="text-[11px] font-semibold">Action được chọn và đối chiếu baseline</p>
                    <div className="grid gap-3 lg:grid-cols-4 mt-2">
                      <Metric label="Chosen Delay/Hold" value={`${futureInferResult.actions.chosen.delayHours}h / ${futureInferResult.actions.chosen.holdHours}h`} helper={`score=${pctFmt.format((futureInferResult.actions.chosen.score || 0) * 100)}% (${chosenScoreGrade.label}, ${chosenScoreGrade.note})`} info="Action có score cao nhất sau khi cân bằng lợi nhuận kỳ vọng, rủi ro, độ bất định và bias regime." />
                      <Metric label="Expected Ret / MAE" value={`${pctFmt.format((futureInferResult.actions.chosen.expectedRet || 0) * 100)}% / ${pctFmt.format((futureInferResult.actions.chosen.expectedMae || 0) * 100)}%`} helper={`ret=${chosenRetGrade.label} (${chosenRetGrade.note}) | uncertainty=${pctFmt.format((futureInferResult.actions.chosen.uncertainty || 0) * 100)}%`} info="Expected Ret là lợi nhuận kỳ vọng từ top-K neighbors. Expected MAE là drawdown tệ nhất kỳ vọng trong thời gian giữ lệnh." />
                      <Metric label="Realized Chosen (back-check)" value={futureInferResult?.actions?.chosenTradeRealized ? `${pctFmt.format((futureInferResult.actions.chosenTradeRealized.ret || 0) * 100)}%` : "N/A"} helper="Chỉ để audit trên lịch sử, không dùng khi live." info="Kết quả thực tế khi áp action đã chọn lên chính target event lịch sử. Dùng để kiểm tra logic, không phải tín hiệu live." />
                      <Metric label="Realized Baseline (1h/8h)" value={futureInferResult?.actions?.baseline?.realized ? `${pctFmt.format((futureInferResult.actions.baseline.realized.ret || 0) * 100)}%` : "N/A"} helper="So với timing cố định." info="Mốc tham chiếu để biết action động tốt/xấu hơn chiến lược delay-hold cố định." />
                    </div>
                    {futureInferResult?.actions?.chosenTradeRealized ? (
                      <button
                        type="button"
                        className="border border-[var(--border-color)] px-2 py-1 text-[11px] mt-2"
                        onClick={() => setSelectedCustomTrade({
                          ts: futureInferResult.targetEvent.ts,
                          ret: futureInferResult.actions.chosenTradeRealized.ret,
                          entryTs: futureInferResult.actions.chosenTradeRealized.entryTs,
                          exitTs: futureInferResult.actions.chosenTradeRealized.exitTs
                        })}
                      >
                        Gắn detail chart theo action đã chọn
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="max-h-[380px] overflow-auto thin-scrollbar">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                        <ThWithInfo label="Delay" info="Số giờ chờ sau event trước khi vào lệnh." />
                        <ThWithInfo label="Hold" info="Số giờ giữ lệnh sau khi vào." />
                        <ThWithInfo label="Expected Ret" info="Lợi nhuận kỳ vọng (trung bình trọng số từ top-K event tương đồng)." />
                        <ThWithInfo label="Expected MAE" info="MAE kỳ vọng: mức âm lớn nhất trong thời gian giữ lệnh; càng gần 0 càng an toàn." />
                        <ThWithInfo label="Win Prob" info="Xác suất win ước lượng từ top-K event tương đồng." />
                        <ThWithInfo label="Uncertainty" info="Độ bất định của expected return, tính từ độ lệch chuẩn return trên neighbors." />
                        <ThWithInfo label="Sample" info="Số neighbor có đủ dữ liệu để tính action này." />
                        <ThWithInfo label="RawScore" info="Điểm thô trước sigmoid, gồm ret - các penalty + regime bias." />
                        <ThWithInfo label="Score" info="Điểm chuẩn hóa 0-1 để xếp hạng action. Càng cao càng ưu tiên." />
                        <ThWithInfo label="Xếp loại" info="Đánh giá nhanh theo các ngưỡng Score để dễ ra quyết định." />
                      </tr>
                    </thead>
                    <tbody>
                      {(futureInferResult?.actions?.top || []).map((a, i) => (
                        (() => {
                          const scoreGrade = gradeScore(a.score);
                          const retGrade = gradeExpectedRet(a.expectedRet);
                          return (
                        <tr key={`${a.delayHours}-${a.holdHours}-${i}`} className="border-b border-[var(--border-color)]/70">
                          <td className="py-2">{a.delayHours}h</td>
                          <td className="py-2">{a.holdHours}h</td>
                          <td className="py-2">{pctFmt.format((a.expectedRet || 0) * 100)}%</td>
                          <td className="py-2">{pctFmt.format((a.expectedMae || 0) * 100)}%</td>
                          <td className="py-2">{pctFmt.format((a.winProb || 0) * 100)}%</td>
                          <td className="py-2">{pctFmt.format((a.uncertainty || 0) * 100)}%</td>
                          <td className="py-2">{fmtInt(a.sampleSize || 0)}</td>
                          <td className="py-2">{pctFmt.format((a.rawScore || 0) * 100)}%</td>
                          <td className="py-2 font-semibold">{pctFmt.format((a.score || 0) * 100)}%</td>
                          <td className="py-2">
                            <div className="flex items-center gap-1">
                              <GradeBadge grade={scoreGrade} />
                              <span className="text-[10px] text-[var(--text-muted)]">{retGrade.label}</span>
                            </div>
                          </td>
                        </tr>
                          );
                        })()
                      ))}
                      {(futureInferResult?.actions?.top || []).length === 0 ? (
                        <tr><td colSpan={10} className="py-3 text-[var(--text-muted)]">Không có action đủ sample.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                <div className="max-h-[320px] overflow-auto thin-scrollbar">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                        <ThWithInfo label="Neighbor event" info="Event quá khứ có snapshot giống target event theo cosine similarity." />
                        <ThWithInfo label="Similarity" info="Mức giống nhau của vector feature (đã đưa về thang 0-100%)." />
                        <ThWithInfo label="Weight" info="Trọng số dùng trong vote regime và expected metrics; similarity cao sẽ có weight cao hơn." />
                        <ThWithInfo label="Regime label" info="Nhãn regime lịch sử của neighbor (mean_revert, trend_down, chop)." />
                        <ThWithInfo label="Total" info="Tổng liquidation USD tại event neighbor." />
                        <ThWithInfo label="Long%" info="Tỷ lệ long liquidation trên tổng liquidation của neighbor." />
                        <ThWithInfo label="Z" info="Độ bất thường liquidation của neighbor so với cửa sổ lịch sử gần đó." />
                        <th className="py-2 text-right">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(futureInferResult?.regime?.topNeighbors || []).map((n) => (
                        <tr key={`${n.ts}-${n.regime}`} className="border-b border-[var(--border-color)]/70">
                          <td className="py-2">{fmtTs(n.timestamp)}</td>
                          <td className="py-2">{pctFmt.format((n.similarity || 0) * 100)}%</td>
                          <td className="py-2">{pctFmt.format((n.weight || 0) * 100)}%</td>
                          <td className="py-2">{n.regime}</td>
                          <td className="py-2">{fmtUsd(n.totalUsd)}</td>
                          <td className="py-2">{pctFmt.format((n.longShare || 0) * 100)}%</td>
                          <td className="py-2">{Number(n.z || 0).toFixed(2)}</td>
                          <td className="py-2 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedEventTs(Number(n.ts));
                                setSelectedCustomTrade(null);
                              }}
                              className={`border border-[var(--border-color)] px-2 py-1 font-semibold ${selectedEventTs === Number(n.ts) ? "bg-[var(--bg-secondary)]" : ""}`}
                            >
                              Detail
                            </button>
                          </td>
                        </tr>
                      ))}
                      {(futureInferResult?.regime?.topNeighbors || []).length === 0 ? (
                        <tr><td colSpan={8} className="py-3 text-[var(--text-muted)]">Không có neighbors.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                <div className="max-h-[220px] overflow-auto thin-scrollbar">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                        <ThWithInfo label="Feature" info="Tên biến đặc trưng trong snapshot tại thời điểm target event xảy ra." />
                        <ThWithInfo label="Value @target t0" info="Giá trị cụ thể của feature tại t0, chỉ dùng dữ liệu quá khứ/hiện tại (không dùng tương lai)." />
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(futureInferResult?.targetEvent?.features || {}).map(([k, v]) => (
                        <tr key={k} className="border-b border-[var(--border-color)]/70">
                          <td className="py-2">{k}</td>
                          <td className="py-2">{Number(v).toFixed(6)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="px-5">
        <div className="border border-[var(--border-color)] p-3 space-y-3">
          <p className="text-[12px] font-semibold">Cascade Lab (Có thể chỉnh tham số)</p>
          <form className="grid gap-2 lg:grid-cols-7" method="GET" action={basePath}>
            <input type="hidden" name="dataset" value={chosen || ""} />
            <Input name="q" defaultValue={cascadeOptions?.q ?? 0.95} label="Quantile" />
            <Input name="minLongShare" defaultValue={cascadeOptions?.minLongShare ?? 0.65} label="Long share tối thiểu" />
            <Input name="zMin" defaultValue={cascadeOptions?.zMin ?? 1.5} label="Z-Score tối thiểu" />
            <Input name="zWindowHours" defaultValue={cascadeOptions?.zWindowHours ?? 168} label="Cửa sổ Z (giờ)" />
            <Input name="entryDelayHours" defaultValue={cascadeOptions?.entryDelayHours ?? 1} label="Trễ vào lệnh (giờ)" />
            <Input name="holdHours" defaultValue={cascadeOptions?.holdHours ?? 8} label="Thời gian giữ (giờ)" />
            <button className="border border-[var(--border-color)] px-2 py-2 text-[11px] font-semibold">Tính lại</button>
          </form>
          <p className="text-[11px] text-[var(--text-muted)]">
            Cascade = <code>totalUsd &gt;= quantile</code> + <code>longShare &gt;= minLongShare</code> + <code>zScore &gt;= zMin</code>. Win/Lose = vào lệnh sau <code>entryDelayHours</code>, đóng lệnh sau <code>holdHours</code>, win nếu return &gt; 0.
          </p>
          <div className="text-[11px] text-[var(--text-muted)] space-y-1">
            <p><b>Quantile:</b> Ngưỡng độ lớn liquidation. Ví dụ <code>0.95</code> nghĩa là chỉ lấy các nến thuộc top 5% mạnh nhất.</p>
            <p><b>Long share tối thiểu:</b> Tỷ trọng long liquidation trong tổng liquidation của nến. Ví dụ <code>0.65</code> nghĩa là long phải chiếm ít nhất 65%.</p>
            <p><b>Z-Score tối thiểu:</b> Mức độ bất thường so với lịch sử gần đây. Z càng cao thì cú thanh lý càng đột biến.</p>
            <p><b>Cửa sổ Z (giờ):</b> Số giờ dùng để tính trung bình và độ lệch chuẩn cho Z-Score. Cửa sổ lớn = mượt hơn, ít nhiễu hơn.</p>
            <p><b>Trễ vào lệnh (giờ):</b> Chờ bao lâu sau nến cascade mới vào lệnh. <code>0</code> = vào ngay, <code>1</code> = chờ 1 giờ.</p>
            <p><b>Thời gian giữ (giờ):</b> Giữ lệnh bao lâu rồi thoát. Win/Lose hiện tại được tính đúng theo thông số này.</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-4">
            <Metric label="Số Cascade" value={fmtInt(cascade.summary.count)} helper="Số sự kiện đạt điều kiện cascade." />
            <Metric label="Tỷ lệ Win" value={`${pctFmt.format((cascade.summary.winRate || 0) * 100)}%`} helper="Tỷ lệ win theo bộ tham số vào/ra hiện tại." />
            <Metric label="Lợi nhuận TB/Lệnh" value={`${pctFmt.format((cascade.summary.avgRet || 0) * 100)}%`} helper="Return trung bình mỗi lệnh." />
            <Metric label="Ngưỡng Cascade" value={fmtUsd(cascade.summary.threshold || 0)} helper="Ngưỡng total liquidation theo quantile." />
          </div>
        </div>
      </div>

      <div className="px-5 grid gap-3 lg:grid-cols-4">
        <Metric label="Thời điểm con trỏ" value={fmtTs(hoverIso)} helper="Mốc thời gian bạn đang hover trên chart." />
        <Metric label="Event gần nhất" value={near ? fmtTs(near.timestamp) : "N/A"} helper="Event liquidation gần nhất với con trỏ." />
        <Metric label="Tổng liquidation event" value={near ? fmtUsd(near.totalUsd) : "N/A"} helper="Tổng liquidation ở event gần nhất." />
        <Metric label="Coverage theo tháng" value={hoverMonthCoverage ? `${pctFmt.format(hoverMonthCoverage.coveragePct)}%` : "N/A"} helper="Độ đầy đủ dữ liệu trong tháng chứa con trỏ." />
      </div>

      <div className="px-5 grid gap-3 lg:grid-cols-3">
        <Metric label="Số điểm dữ liệu" value={fmtInt(stats.summary.rows)} helper="Số dòng record trong file." />
        <Metric label="Số điểm kỳ vọng" value={fmtInt(stats.summary.expectedRows || 0)} helper="Nếu đầy đủ theo khung thời gian chuẩn thì cần bấy nhiêu điểm." />
        <Metric label="Độ đầy đủ (coverage)" value={`${pctFmt.format(Number(stats.summary.coveragePct || 0))}%`} helper="Coverage càng cao thì backtest càng đáng tin." />
        <Metric label="Tổng liquidation" value={fmtUsd(stats.summary.totalUsd || 0)} helper="Tổng long + short toàn bộ range." />
        <Metric label="Trung bình mỗi điểm" value={fmtUsd(stats.summary.avgUsd || 0)} helper="Liquidation trung bình/event." />
        <Metric label="Median mỗi điểm" value={fmtUsd(stats.summary.medianUsd || 0)} helper="Mốc 50%, ít bị ảnh hưởng bởi outlier." />
        <Metric label="P90" value={fmtUsd(stats.summary.p90 || 0)} helper="10% sự kiện lớn hơn mốc này." />
        <Metric label="P95" value={fmtUsd(stats.summary.p95 || 0)} helper="5% sự kiện lớn hơn mốc này." />
        <Metric label="P99 / Max" value={`${fmtUsd(stats.summary.p99 || 0)} / ${fmtUsd(stats.summary.max || 0)}`} helper="Rủi ro tail và đỉnh cực trị." />
      </div>

      <div className="px-5 grid gap-3 lg:grid-cols-2">
        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Top Spikes (Sự kiện cực trị)</p>
          <div className="space-y-1 text-[11px]">
            {stats.topEvents.slice(0, 10).map((e) => (
              <div key={e.timestamp} className={`flex justify-between gap-3 px-2 py-1 ${sameHour(e.timestamp, hoverIso) ? "bg-[var(--bg-secondary)]" : ""}`}>
                <span className="text-[var(--text-muted)]">{fmtTs(e.timestamp)}</span>
                <span className="font-semibold">{fmtUsd(e.totalUsd)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Top Missing Gaps</p>
          <div className="space-y-1 text-[11px]">
            {stats.topGaps.length === 0 && <p className="text-[var(--text-muted)]">Không có gap &gt; 1h.</p>}
            {stats.topGaps.slice(0, 10).map((g) => (
              <div key={`${g.from}-${g.to}`} className={`flex justify-between gap-3 px-2 py-1 ${hoverIso && hoverIso >= g.from && hoverIso <= g.to ? "bg-[var(--bg-secondary)]" : ""}`}>
                <span className="text-[var(--text-muted)]">{fmtTs(g.from)} - {fmtTs(g.to)}</span>
                <span className="font-semibold">{g.missingHours}h</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="px-5 pb-5 grid gap-3 lg:grid-cols-2">
        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Coverage theo tháng</p>
          <div className="space-y-2 max-h-[280px] overflow-auto thin-scrollbar pr-1">
            {stats.byMonth.map((m) => (
              <BarRow key={m.month} label={m.month} value={m.coveragePct} right={`${m.observed}/${m.expected}`} color={m.month === hoverMonth ? "var(--danger-text)" : "var(--color-accent)"} />
            ))}
          </div>
        </div>

        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Khung giờ UTC nóng nhất</p>
          <div className="space-y-2">
            {stats.byHour.slice(0, 10).map((h) => (
              <BarRow
                key={h.hour}
                label={`${String(h.hour).padStart(2, "0")}:00`}
                value={stats.byHour[0]?.avgUsd ? (h.avgUsd / stats.byHour[0].avgUsd) * 100 : 0}
                right={fmtUsd(h.avgUsd)}
                color={hoverIso && Number(hoverIso.slice(11, 13)) === h.hour ? "var(--danger-text)" : "var(--success-text)"}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="px-5 pb-5 grid gap-3 lg:grid-cols-2">
        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Ngày trong tuần nóng nhất (UTC)</p>
          <div className="space-y-2">
            {stats.byWeekday.map((d) => (
              <BarRow
                key={d.weekday}
                label={weekdayNames[d.weekday]}
                value={stats.byWeekday[0]?.avgUsd ? (d.avgUsd / stats.byWeekday[0].avgUsd) * 100 : 0}
                right={fmtUsd(d.avgUsd)}
                color={hoverIso && new Date(hoverIso).getUTCDay() === d.weekday ? "var(--danger-text)" : "var(--color-accent)"}
              />
            ))}
          </div>
        </div>

        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Phân bố mức Liquidation</p>
          <div className="space-y-2">
            {stats.distribution.map((d) => (
              <BarRow key={d.label} label={d.label} value={stats.summary.rows ? (d.count / stats.summary.rows) * 100 : 0} right={`${d.count} rows`} color="var(--success-text)" />
            ))}
          </div>
        </div>
      </div>

      <div className="px-5 pb-5">
        <div className="border border-[var(--border-color)] p-3">
          <p className="text-[12px] font-semibold mb-2">Danh sách đầy đủ Cascade Events</p>
          <div className="max-h-[420px] overflow-auto thin-scrollbar">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                  <th className="py-2">Thời điểm cascade</th>
                  <th className="py-2">Total USD</th>
                  <th className="py-2">Tỷ trọng Long</th>
                  <th className="py-2">Z</th>
                  <th className="py-2">Vào lệnh</th>
                  <th className="py-2">Thoát lệnh</th>
                  <th className="py-2">Lợi nhuận</th>
                  <th className="py-2">Kết quả</th>
                  <th className="py-2 text-right">Detail</th>
                </tr>
              </thead>
              <tbody>
                {cascade.events.map((e) => (
                  <tr key={`${e.ts}-${e.entryTs}`} className="border-b border-[var(--border-color)]/70">
                    <td className="py-2">{fmtTs(e.timestamp)}</td>
                    <td className="py-2">{fmtUsd(e.totalUsd)}</td>
                    <td className="py-2">{pctFmt.format(e.longShare * 100)}%</td>
                    <td className="py-2">{e.z.toFixed(2)}</td>
                    <td className="py-2">{fmtTs(e.entryTs)}</td>
                    <td className="py-2">{fmtTs(e.exitTs)}</td>
                    <td className="py-2">{pctFmt.format(e.ret * 100)}%</td>
                    <td className="py-2 font-semibold">{e.win ? "WIN" : "LOSE"}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedEventTs(e.ts);
                          setSelectedCustomTrade(null);
                        }}
                        className={`border border-[var(--border-color)] px-2 py-1 font-semibold ${selectedEventTs === e.ts ? "bg-[var(--bg-secondary)]" : ""}`}
                      >
                        Detail
                      </button>
                    </td>
                  </tr>
                ))}
                {cascade.events.length === 0 ? (
                  <tr><td colSpan={9} className="py-3 text-[var(--text-muted)]">Không có event theo tham số hiện tại.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {selectedEventDetail ? (
            <div className="mt-4 border-t border-[var(--border-color)] pt-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-semibold">Detail Cascade Event: {fmtTs(selectedEventDetail.eventIso)}</p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedEventTs(null);
                    setSelectedCustomTrade(null);
                  }}
                  className="border border-[var(--border-color)] px-2 py-1 text-[11px]"
                >
                  Đóng chi tiết
                </button>
              </div>
              <div className="grid gap-3 lg:grid-cols-4">
                <Metric label="Giá BTC tại event" value={selectedEventDetail.eventClose ? `$${selectedEventDetail.eventClose.toLocaleString()}` : "N/A"} helper="Giá close ở nến gần nhất với thời điểm cascade." />
                <Metric label="Long/Short/Total" value={`${fmtUsd(selectedEventDetail.eventLongUsd)} / ${fmtUsd(selectedEventDetail.eventShortUsd)} / ${fmtUsd(selectedEventDetail.eventTotalUsd)}`} helper="Cấu phần liquidation tại event." />
                <Metric label="Long share + Z" value={`${pctFmt.format(selectedEventDetail.eventLongShare * 100)}% / ${selectedEventDetail.eventZ.toFixed(2)}`} helper="So với ngưỡng lọc cascade hiện tại." />
                <Metric label="Return chiến lược" value={selectedEventDetail.eventRet === null ? "N/A" : `${pctFmt.format(selectedEventDetail.eventRet * 100)}%`} helper={`Ngưỡng total hiện tại: ${fmtUsd(selectedEventDetail.threshold || 0)}.`} />
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <Metric label="Con trỏ đồng bộ" value={detailHoverSnapshot ? fmtTs(detailHoverSnapshot.iso) : "N/A"} helper="Kéo/zoom/rê chuột ở chart nào thì chart còn lại đồng bộ theo cùng mốc." />
                <Metric label="Giá BTC tại con trỏ" value={Number.isFinite(detailHoverSnapshot?.close) ? `$${detailHoverSnapshot.close.toLocaleString()}` : "N/A"} helper="Close ở chart giá tại thời điểm con trỏ." />
                <Metric label="Liquidation tại con trỏ" value={Number.isFinite(detailHoverSnapshot?.totalUsd) ? `${fmtUsd(detailHoverSnapshot.totalUsd)} (L:${fmtUsd(detailHoverSnapshot.longUsd)} / S:${fmtUsd(detailHoverSnapshot.shortUsd)})` : "N/A"} helper={detailHoverSnapshot ? `Long share ${pctFmt.format(detailHoverSnapshot.longSharePct || 0)}%, Z=${(detailHoverSnapshot.z || 0).toFixed(2)}.` : "Dữ liệu liquidation tại mốc con trỏ."} />
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
                  <p className="text-[11px] text-[var(--text-muted)]">Data thời điểm Vào lệnh</p>
                  <p className="text-[13px] font-semibold mt-1">{selectedEventDetail.entryPoint ? fmtTs(selectedEventDetail.entryPoint.iso) : "N/A"}</p>
                  {selectedEventDetail.entryPoint ? (
                    <div className="text-[11px] text-[var(--text-muted)] mt-2 space-y-1">
                      <p>Giá BTC close: <b>${selectedEventDetail.entryPoint.close?.toLocaleString() || "N/A"}</b></p>
                      <p>Total: <b>{fmtUsd(selectedEventDetail.entryPoint.totalUsd)}</b> | Long: <b>{fmtUsd(selectedEventDetail.entryPoint.longUsd)}</b> | Short: <b>{fmtUsd(selectedEventDetail.entryPoint.shortUsd)}</b></p>
                      <p>Long share: <b>{pctFmt.format(selectedEventDetail.entryPoint.longSharePct)}%</b> | Z: <b>{selectedEventDetail.entryPoint.z.toFixed(2)}</b></p>
                    </div>
                  ) : <p className="text-[11px] text-[var(--text-muted)] mt-2">Không có dữ liệu tại mốc vào lệnh.</p>}
                </div>
                <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
                  <p className="text-[11px] text-[var(--text-muted)]">Data thời điểm Thoát lệnh</p>
                  <p className="text-[13px] font-semibold mt-1">{selectedEventDetail.exitPoint ? fmtTs(selectedEventDetail.exitPoint.iso) : "N/A"}</p>
                  {selectedEventDetail.exitPoint ? (
                    <div className="text-[11px] text-[var(--text-muted)] mt-2 space-y-1">
                      <p>Giá BTC close: <b>${selectedEventDetail.exitPoint.close?.toLocaleString() || "N/A"}</b></p>
                      <p>Total: <b>{fmtUsd(selectedEventDetail.exitPoint.totalUsd)}</b> | Long: <b>{fmtUsd(selectedEventDetail.exitPoint.longUsd)}</b> | Short: <b>{fmtUsd(selectedEventDetail.exitPoint.shortUsd)}</b></p>
                      <p>Long share: <b>{pctFmt.format(selectedEventDetail.exitPoint.longSharePct)}%</b> | Z: <b>{selectedEventDetail.exitPoint.z.toFixed(2)}</b></p>
                    </div>
                  ) : <p className="text-[11px] text-[var(--text-muted)] mt-2">Không có dữ liệu tại mốc thoát lệnh.</p>}
                </div>
              </div>
              <div className="border border-[var(--border-color)] p-3">
                <p className="text-[11px] font-semibold mb-2">Chart 1: Giá BTC toàn bộ dataset (highlight tất cả cascade events)</p>
                <div ref={detailPriceRef} className="w-full h-[260px]" />
              </div>
              <div className="border border-[var(--border-color)] p-3">
                <p className="text-[11px] font-semibold mb-2">Chart 2: Total liquidation (histogram) + Long share (%) + Z-Score toàn bộ dataset</p>
                <div ref={detailDataRef} className="w-full h-[260px]" />
              </div>
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-[var(--text-muted)]">Bấm nút <b>Detail</b> ở cuối mỗi dòng để xem 2 chart chi tiết theo thời điểm event.</p>
          )}
          <div className="mt-4 border-t border-[var(--border-color)] pt-3 space-y-2">
            <p className="text-[12px] font-semibold">Giả lập vốn nếu vào tất cả events</p>
            <div className="grid gap-3 lg:grid-cols-4 items-end">
              <label className="text-[10px] text-[var(--text-muted)]">
                Vốn ban đầu (USD)
                <input
                  type="number"
                  min={1}
                  value={startingCapital}
                  onChange={(e) => setStartingCapital(Number(e.target.value))}
                  className="input-ui mt-1 w-full px-2 py-1.5 text-[11px]"
                />
              </label>
              <Metric label="Vốn cuối" value={fmtUsd(capitalProjection.final)} helper="Compound qua toàn bộ events theo thứ tự thời gian." />
              <Metric label="Lãi/Lỗ tuyệt đối" value={fmtUsd(capitalProjection.pnl)} helper="Vốn cuối - vốn ban đầu." />
              <Metric label="ROI" value={`${pctFmt.format(capitalProjection.roi * 100)}%`} helper="Tỷ suất sinh lời trên vốn ban đầu." />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoHint({ text }) {
  if (!text) return null;
  return (
    <span className="relative inline-flex group align-middle ml-1">
      <span className="inline-flex items-center justify-center h-4 w-4 rounded-full border border-[var(--border-color)] text-[10px] font-semibold text-[var(--text-muted)] cursor-help">i</span>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-[260px] -translate-x-1/2 rounded border border-[var(--border-color)] bg-[var(--bg-main)] p-2 text-[10px] font-normal leading-4 text-[var(--text-muted)] shadow-sm group-hover:block">
        {text}
      </span>
    </span>
  );
}

function Metric({ label, value, helper, info }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
      <p className="text-[11px] text-[var(--text-muted)]">{label}<InfoHint text={info} /></p>
      <p className="text-[16px] font-semibold mt-1 break-all">{value}</p>
      <p className="text-[10px] text-[var(--text-muted)] mt-1">{helper}</p>
    </div>
  );
}

function BarRow({ label, value, right, color }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1 gap-2">
        <span>{label}</span>
        <span className="text-[var(--text-muted)]">{right}</span>
      </div>
      <div className="h-2.5 bg-[var(--bg-secondary)] rounded overflow-hidden">
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-1">{pct.toFixed(1)}%</p>
    </div>
  );
}

function Input({ name, defaultValue, label }) {
  return (
    <label className="text-[10px] text-[var(--text-muted)]">
      {label}
      <input name={name} defaultValue={defaultValue} className="input-ui mt-1 w-full px-2 py-1.5 text-[11px]" />
    </label>
  );
}

function InputSmall({ label, value, onChange, info }) {
  return (
    <label className="text-[10px] text-[var(--text-muted)]">
      <span>{label}<InfoHint text={info} /></span>
      <input
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input-ui mt-1 w-full px-2 py-1.5 text-[11px]"
      />
    </label>
  );
}

function ThWithInfo({ label, info }) {
  return (
    <th className="py-2">
      <span>{label}<InfoHint text={info} /></span>
    </th>
  );
}

function GradeBadge({ grade }) {
  const g = grade || { label: "N/A", tone: "neutral", note: "" };
  let cls = "border-[var(--border-color)] text-[var(--text-muted)]";
  if (g.tone === "good") cls = "border-[color:color-mix(in_oklab,var(--success-text)_55%,white)] text-[var(--success-text)]";
  if (g.tone === "ok") cls = "border-[color:color-mix(in_oklab,var(--color-accent)_55%,white)] text-[var(--color-accent)]";
  if (g.tone === "bad") cls = "border-[color:color-mix(in_oklab,var(--danger-text)_55%,white)] text-[var(--danger-text)]";
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{g.label}</span>;
}
