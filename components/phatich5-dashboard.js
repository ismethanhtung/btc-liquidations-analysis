"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import {
  AlertTriangle,
  BarChart3,
  Compass,
  Database,
  GitCommitHorizontal,
  LoaderCircle,
  Play,
  RefreshCcw,
  Route,
  Sigma,
  Table2,
  Waves,
} from "lucide-react";
import Phatich5PolymarketPanel from "@/components/phatich5-polymarket-panel";
import Phatich5LivePaperPanel from "@/components/phatich5-live-paper-panel";

const pctFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const featureLabels = {
  priceRet24: "Price ret 24h",
  priceRet72: "Price ret 72h",
  priceVol24: "Vol 24h",
  priceVol72: "Vol 72h",
  liqShock: "Liq shock",
  liqImbalance: "Liq imbalance",
  fundingShock: "Funding shock",
  oiRet24: "OI ret 24h",
  oiMomentum: "OI momentum",
  oiWeightRet24: "OI-weight 24h",
  cvdRet24: "CVD ret 24h",
  cvdMomentum: "CVD momentum",
  corrOiPrice24: "OI-price corr",
  corrCvdPrice24: "CVD-price corr",
  corrFundingOi24: "Funding-OI corr",
  maxDrawdown24: "Max DD 24h",
};

const featureGroups = [
  {
    key: "price",
    label: "Price action",
    features: ["priceRet24", "priceRet72", "priceVol24", "priceVol72", "maxDrawdown24"],
  },
  {
    key: "derivatives",
    label: "Derivatives",
    features: ["fundingShock", "oiRet24", "oiMomentum", "oiWeightRet24", "cvdRet24", "cvdMomentum"],
  },
  {
    key: "liquidation",
    label: "Liquidation",
    features: ["liqShock", "liqImbalance"],
  },
  {
    key: "correlation",
    label: "Correlation",
    features: ["corrOiPrice24", "corrCvdPrice24", "corrFundingOi24"],
  },
];

const featurePresets = [
  { key: "all", label: "All", features: Object.keys(featureLabels) },
  { key: "priceOnly", label: "Price only", features: featureGroups[0].features },
  {
    key: "derivativesCore",
    label: "Derivatives core",
    features: ["priceVol24", "priceVol72", "fundingShock", "oiRet24", "oiMomentum", "oiWeightRet24", "liqShock"],
  },
  {
    key: "cascadeRisk",
    label: "Cascade risk",
    features: ["priceVol24", "priceVol72", "liqShock", "liqImbalance", "fundingShock", "oiRet24", "maxDrawdown24"],
  },
  {
    key: "minimalClean",
    label: "Minimal clean",
    features: ["priceRet24", "priceVol24", "liqShock", "fundingShock", "oiRet24"],
  },
];

function fmtPct(v) {
  const n = Number(v || 0) * 100;
  const sign = n >= 0 ? "+" : "";
  return `${sign}${pctFmt.format(n)}%`;
}

function fmtUsdCompact(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  const sign = n >= 0 ? "" : "-";
  if (abs >= 1e6) {
    return `${sign}$${fmtNum(abs / 1e6, 2)}M`;
  }
  if (abs >= 1e3) {
    return `${sign}$${fmtNum(abs / 1e3, 1)}K`;
  }
  return `${sign}$${fmtNum(abs, 0)}`;
}


function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

function fmtHours(v) {
  const n = Number(v || 0);
  if (n >= 48) return `${fmtNum(n / 24, 1)}d`;
  return `${fmtNum(n, 1)}h`;
}

function toneClass(tone) {
  if (tone === "good") return "border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]";
  if (tone === "bad") return "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]";
  if (tone === "ok") return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-main)]";
}

function Metric({ label, value, helper, icon: Icon }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-[18px] font-semibold leading-5">{value}</div>
      {helper ? <div className="mt-1 text-[10px] text-[var(--text-muted)]">{helper}</div> : null}
    </div>
  );
}

function FieldLabel({ children, icon: Icon }) {
  return (
    <div className="mb-1 flex items-center gap-1 text-[10px] uppercase text-[var(--text-muted)]">
      {Icon ? <Icon className="h-3 w-3" /> : null}
      <span>{children}</span>
    </div>
  );
}


function intervalToMs(interval) {
  const str = String(interval || "1h").trim().toLowerCase();
  const match = str.match(/^(\d+)([mhd])$/);
  if (match) {
    const val = Number(match[1]);
    const unit = match[2];
    if (unit === "m") return val * 60000;
    if (unit === "h") return val * 3600000;
    if (unit === "d") return val * 86400000;
  }
  if (str === "30m") return 30 * 60000;
  if (str === "4h") return 4 * 3600000;
  if (str === "1d") return 24 * 3600000;
  return 3600000;
}

function hoursToSteps(hours, interval) {
  const ms = intervalToMs(interval);
  if (ms <= 0) return hours;
  return Math.round((hours * 3600000) / ms);
}

function tintColor(state, k) {
  const palette = ["#2563eb", "#dc2626", "#16a34a", "#7c3aed", "#d97706", "#0891b2", "#be185d", "#475569"];
  return palette[state % Math.max(1, k)] || "#475569";
}

function fmtDurationHours(bars, interval) {
  const hours = (bars * intervalToMs(interval)) / 3600000;
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins} phút`;
  }
  return `${hours.toFixed(1)} giờ`;
}

function computeDurationDependentRollout(currState, currentDuration, empiricalTransitions, baseTransMatrix, steps) {
  const K = baseTransMatrix.length;
  const stateProbs = Array.from({ length: steps + 1 }, () => Array(K).fill(0));
  
  let jointDist = Array.from({ length: K }, () => ({}));
  jointDist[currState][currentDuration] = 1.0;
  stateProbs[0][currState] = 1.0;
  
  for (let h = 1; h <= steps; h++) {
    const nextJointDist = Array.from({ length: K }, () => ({}));
    
    for (let s = 0; s < K; s++) {
      const baseTrans = baseTransMatrix[s] || [];
      const empTransMap = empiricalTransitions[s] || {};
      
      const empDurations = Object.keys(empTransMap).map(Number);
      const maxDur = empDurations.length ? Math.max(...empDurations) : 0;
      
      for (const dStr in jointDist[s]) {
        const d = Number(dStr);
        const pJoint = jointDist[s][d];
        if (pJoint <= 0) continue;
        
        let trans = empTransMap[d];
        if (!trans) {
          trans = maxDur > 0 && d > maxDur ? empTransMap[maxDur] : baseTrans;
        }
        
        for (let ns = 0; ns < K; ns++) {
          const pTrans = trans[ns] || 0;
          const pNext = pJoint * pTrans;
          if (pNext <= 0) continue;
          
          if (ns === s) {
            const nextD = d + 1;
            nextJointDist[s][nextD] = (nextJointDist[s][nextD] || 0) + pNext;
          } else {
            nextJointDist[ns][1] = (nextJointDist[ns][1] || 0) + pNext;
          }
        }
      }
    }
    
    jointDist = nextJointDist;
    for (let s = 0; s < K; s++) {
      let sum = 0;
      for (const dStr in jointDist[s]) {
        sum += jointDist[s][dStr];
      }
      stateProbs[h][s] = sum;
    }
  }
  
  return { stateProbs };
}

function LivePaperLogsTab() {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadLogs() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/phatich5/live-paper/logs", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Failed to load logs.");
      setLogs(json.logs || "No log content.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-4 px-4 py-4 border border-[var(--border-color)] bg-[var(--bg-main)] rounded">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-2 mb-2">
        <h2 className="text-[12px] font-semibold text-[var(--text-main)]">Runner / System Logs (cron.log)</h2>
        <button
          onClick={loadLogs}
          disabled={loading}
          className="inline-flex h-7 items-center justify-center gap-1 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[10px] font-semibold hover:bg-[var(--border-color)] transition-colors rounded"
        >
          {loading && <span className="animate-spin inline-block mr-1">⌛</span>}
          Refresh Logs
        </button>
      </div>

      {error ? (
        <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 p-2 rounded">
          {error}
        </div>
      ) : (
        <pre className="font-mono text-[10px] leading-relaxed p-4 bg-slate-950 text-slate-100 rounded overflow-auto h-[60vh] thin-scrollbar whitespace-pre-wrap">
          {logs}
        </pre>
      )}
    </div>
  );
}

export default function Phatich5Dashboard() {
  const chartRef = useRef(null);
  const chartApiRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const didAutoRunRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [error, setError] = useState("");
  const [datasets, setDatasets] = useState([]);
  const [selectedDataset, setSelectedDataset] = useState("");
  const [result, setResult] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [activeTab, setActiveTab] = useState("regimes");
  const [projectionTimeframe, setProjectionTimeframe] = useState("1h");
  const [valMetric, setValMetric] = useState("vol");
  const [valTimeframe, setValTimeframe] = useState("24h");
  const [activeRadarStates, setActiveRadarStates] = useState(new Set());
  const [selectedFeatures, setSelectedFeatures] = useState(() => Object.keys(featureLabels));
  const [params, setParams] = useState({
    years: 1,
    interval: "1h",
    exchangeList: "Binance,Bybit,OKX",
    symbol: "BTC",
    fitK: "auto",
    maxK: 10,
    hmmIterations: 10,
  });

  const latestState = result?.states?.[result.latest?.state] || null;
  const selectedPoint = useMemo(() => {
    const rows = result?.timeline || [];
    if (!rows.length) return null;
    if (!selectedTime) return rows[rows.length - 1];
    let best = rows[0];
    let bestDist = Math.abs(rows[0].time - selectedTime);
    for (const row of rows) {
      const dist = Math.abs(row.time - selectedTime);
      if (dist < bestDist) {
        best = row;
        bestDist = dist;
      }
    }
    return best;
  }, [result, selectedTime]);
  const selectedSegment = useMemo(() => {
    const segments = result?.segments || [];
    if (!segments.length || !selectedPoint) return null;
    return segments.find((segment) => (
      selectedPoint.time >= segment.startTime && selectedPoint.time <= segment.endTime
    )) || null;
  }, [result, selectedPoint]);

    const currState = selectedPoint !== null ? selectedPoint.state : (result?.latest?.state ?? 0);
  const selectedStateObj = result?.states?.[currState];

  const displayTransitionProbs = useMemo(() => {
    if (!result) return [];
    const timeline = result.timeline || [];
    let idx = selectedPoint ? timeline.findIndex(p => p.time === selectedPoint.time) : -1;
    if (idx === -1 && timeline.length) {
      idx = timeline.length - 1;
    }
    if (idx === -1) return [];

    const selectedCandle = timeline[idx];
    const currState = selectedCandle.state;
    
    // Calculate current duration
    let currentDuration = 1;
    for (let i = idx - 1; i >= 0; i--) {
      if (timeline[i].state === currState) {
        currentDuration++;
      } else {
        break;
      }
    }

    const empiricalTransitions = result.empiricalTransitions || [];
    const baseTransitions = result.transitions || [];
    const K = result.meta?.chosenK || 2;
    const baseTransMatrix = Array.from({ length: K }, () => Array(K).fill(0));
    baseTransitions.forEach(row => {
      row.forEach(cell => {
        baseTransMatrix[cell.from][cell.to] = cell.p;
      });
    });

    const interval = result.meta?.interval || "1h";
    let steps = 1;
    if (projectionTimeframe === "6h") steps = Math.max(1, hoursToSteps(6, interval));
    else if (projectionTimeframe === "12h") steps = Math.max(1, hoursToSteps(12, interval));
    else if (projectionTimeframe === "24h") steps = Math.max(1, hoursToSteps(24, interval));
    else {
      steps = Math.max(1, hoursToSteps(1, interval));
    }

    const rollout = computeDurationDependentRollout(
      currState,
      currentDuration,
      empiricalTransitions,
      baseTransMatrix,
      steps
    );

    return rollout.stateProbs[steps].map((p, stateIdx) => ({
      state: stateIdx,
      label: `State ${stateIdx + 1}`,
      probability: p,
      color: tintColor(stateIdx, K)
    }));
  }, [result, selectedPoint, projectionTimeframe]);

  const transitionTimingForecast = useMemo(() => {
    if (!result) return null;
    const timeline = result.timeline || [];
    let idx = selectedPoint ? timeline.findIndex(p => p.time === selectedPoint.time) : -1;
    if (idx === -1 && timeline.length) {
      idx = timeline.length - 1;
    }
    if (idx === -1) return null;

    const selectedCandle = timeline[idx];
    const currState = selectedCandle.state;
    
    // Calculate duration
    let currentDuration = 1;
    for (let i = idx - 1; i >= 0; i--) {
      if (timeline[i].state === currState) {
        currentDuration++;
      } else {
        break;
      }
    }

    const empiricalTransitions = result.empiricalTransitions || [];
    const baseTransitions = result.transitions || [];
    const K = result.meta?.chosenK || 2;
    const baseTransMatrix = Array.from({ length: K }, () => Array(K).fill(0));
    baseTransitions.forEach(row => {
      row.forEach(cell => {
        baseTransMatrix[cell.from][cell.to] = cell.p;
      });
    });

    const interval = result.meta?.interval || "1h";
    const intervalMs = intervalToMs(interval);
    
    // Project forward up to 36 hours to find transition peaks
    const maxHours = 36;
    const maxSteps = Math.max(12, Math.round((maxHours * 3600000) / intervalMs));

    const timingProbs = Array.from({ length: maxSteps + 1 }, () => Array(K).fill(0));
    
    let stayJointDist = {};
    stayJointDist[currentDuration] = 1.0;
    
    for (let h = 1; h <= maxSteps; h++) {
      const nextStayJointDist = {};
      const baseTrans = baseTransMatrix[currState] || [];
      const empTransMap = empiricalTransitions[currState] || {};
      
      const empDurations = Object.keys(empTransMap).map(Number);
      const maxDur = empDurations.length ? Math.max(...empDurations) : 0;
      
      for (const dStr in stayJointDist) {
        const d = Number(dStr);
        const pJoint = stayJointDist[d];
        if (pJoint <= 0) continue;
        
        let trans = empTransMap[d];
        if (!trans) {
          trans = maxDur > 0 && d > maxDur ? empTransMap[maxDur] : baseTrans;
        }
        
        for (let ns = 0; ns < K; ns++) {
          const pTrans = trans[ns] || 0;
          const pNext = pJoint * pTrans;
          if (pNext <= 0) continue;
          
          if (ns === currState) {
            nextStayJointDist[d + 1] = (nextStayJointDist[d + 1] || 0) + pNext;
          } else {
            timingProbs[h][ns] += pNext;
          }
        }
      }
      stayJointDist = nextStayJointDist;
    }

    const forecasts = [];
    for (let ns = 0; ns < K; ns++) {
      if (ns === currState) continue;
      
      let peakStep = 0;
      let peakProb = 0;
      let cumulativeProb = 0;
      
      for (let h = 1; h <= maxSteps; h++) {
        cumulativeProb += timingProbs[h][ns];
        if (timingProbs[h][ns] > peakProb) {
          peakProb = timingProbs[h][ns];
          peakStep = h;
        }
      }
      
      const peakHours = (peakStep * intervalMs) / 3600000;
      
      forecasts.push({
        state: ns,
        label: `State ${ns + 1}`,
        color: tintColor(ns, K),
        peakStep,
        peakHours,
        peakProb,
        cumulativeProb
      });
    }

    let expectedRemainingSteps = 0;
    let sumExitProb = 0;
    for (let h = 1; h <= maxSteps; h++) {
      let exitProbAtH = 0;
      for (let ns = 0; ns < K; ns++) {
        if (ns !== currState) exitProbAtH += timingProbs[h][ns];
      }
      expectedRemainingSteps += h * exitProbAtH;
      sumExitProb += exitProbAtH;
    }
    if (sumExitProb > 0) {
      expectedRemainingSteps = expectedRemainingSteps / sumExitProb;
    }
    const expectedRemainingHours = (expectedRemainingSteps * intervalMs) / 3600000;

    return {
      currentDuration,
      expectedRemainingHours,
      forecasts
    };
  }, [result, selectedPoint]);

  const timelineTail = useMemo(() => {
    const rows = result?.timeline || [];
    return rows.slice(Math.max(0, rows.length - 240));
  }, [result]);
  const selectedFeatureSet = useMemo(() => new Set(selectedFeatures), [selectedFeatures]);

  function setFeaturePreset(features) {
    setSelectedFeatures([...new Set(features)].filter((feature) => featureLabels[feature]));
  }

  function toggleFeature(feature) {
    setSelectedFeatures((curr) => {
      if (curr.includes(feature)) return curr.filter((item) => item !== feature);
      return [...curr, feature];
    });
  }

  function toggleFeatureGroup(features) {
    const allOn = features.every((feature) => selectedFeatureSet.has(feature));
    setSelectedFeatures((curr) => {
      const next = new Set(curr);
      for (const feature of features) {
        if (allOn) next.delete(feature);
        else next.add(feature);
      }
      return [...next].filter((feature) => featureLabels[feature]);
    });
  }

  useEffect(() => {
    if (!chartRef.current || !result?.chart?.candles?.length) return;

    const chart = createChart(chartRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#6f7686",
      },
      rightPriceScale: { borderColor: "#e2e4e8" },
      timeScale: {
        borderColor: "#e2e4e8",
        timeVisible: true,
        secondsVisible: false,
      },
      grid: {
        vertLines: { color: "#f0f2f5" },
        horzLines: { color: "#f0f2f5" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderVisible: false,
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });
    series.setData(result.chart.candles);
    createSeriesMarkers(series, result.chart.markers || []);

    const onCrosshairMove = (param) => {
      if (!param?.time || typeof param.time !== "number") return;
      setSelectedTime(param.time);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    chartApiRef.current = chart;
    candleSeriesRef.current = series;
    chart.timeScale().fitContent();

    return () => {
      candleSeriesRef.current = null;
      chartApiRef.current = null;
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
    };
  }, [result]);

  useEffect(() => {
    let mounted = true;
    async function loadDatasets() {
      setDatasetsLoading(true);
      setError("");
      try {
        const res = await fetch("/api/phatich5/regime", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json?.ok) throw new Error(json?.error || `Dataset request failed: ${res.status}`);
        if (!mounted) return;
        setDatasets(json.datasets || []);
        setSelectedDataset(json.defaultDataset || "");
      } catch (err) {
        if (mounted) setError(err?.message || "Failed to list local datasets.");
      } finally {
        if (mounted) setDatasetsLoading(false);
      }
    }
    loadDatasets();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedDataset || didAutoRunRef.current) return;
    didAutoRunRef.current = true;
    runAnalysis(selectedDataset);
  }, [selectedDataset]);

  async function runAnalysis(dataset = selectedDataset, overrideParams = null) {
    const p = overrideParams || params;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/phatich5/regime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "local",
          dataset,
          fitK: p.fitK,
          maxK: p.maxK,
          hmmIterations: p.hmmIterations,
          selectedFeatures,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `Request failed: ${res.status}`);
      }
      setResult(json);
      if (json?.states) {
        setActiveRadarStates(new Set(json.states.map(s => s.state)));
      }
      setSelectedTime(null);
    } catch (err) {
      setError(err?.message || "Failed to build regime model.");
    } finally {
      setLoading(false);
    }
  }

  function handleSelectK(kValue) {
    setParams((p) => {
      const next = { ...p, fitK: String(kValue) };
      setTimeout(() => {
        runAnalysis(selectedDataset, next);
      }, 0);
      return next;
    });
  }

  const metricTone = latestState?.tone || "neutral";
  const tabs = [
    { key: "regimes", label: "Regimes" },
    { key: "durations", label: "Duration" },
    { key: "transitions", label: "Transitions" },
    { key: "features", label: "Timeline" },
    { key: "diagnostics", label: "Diagnostics" },
    { key: "k", label: "K check" },
    { key: "validation", label: "Predictive Power" },
    { key: "radar", label: "Regime Radar" },
    { key: "polymarket", label: "Polymarket" },
    { key: "paper", label: "Paper Live" },
    { key: "logs", label: "System Logs" },
  ];

  return (
    <div className="space-y-3">
      <div className="panel-shell overflow-hidden">
        <div className="panel-header px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold leading-6">Phan tich 5 - Regime Routing (Short-term)</h1>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                HMM regime model tu dataset local: liquidation, funding, OI, OI-weight funding, CVD va price.
              </p>
            </div>
            <div className={`max-w-[360px] truncate border px-3 py-2 text-[11px] font-semibold ${toneClass(metricTone)}`}>
              {result?.latest?.label || "Waiting for dataset"}
            </div>
          </div>
        </div>

        <div className="border-b border-[var(--border-color)] px-4 py-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(280px,1fr)_96px_96px_96px_auto_auto]">
            <label className="block">
              <FieldLabel icon={Database}>Local dataset</FieldLabel>
              <select
                className="input-ui w-full px-3 py-2 text-[12px]"
                value={selectedDataset}
                onChange={(e) => {
                  setSelectedDataset(e.target.value);
                  didAutoRunRef.current = true;
                  if (e.target.value) runAnalysis(e.target.value);
                }}
              >
                {datasets.length ? null : <option value="">No dataset</option>}
                {datasets.map((dataset) => (
                  <option key={dataset} value={dataset}>{dataset}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <FieldLabel>Fit K</FieldLabel>
              <select
                className="input-ui h-9 w-full px-3 text-[12px]"
                value={params.fitK}
                onChange={(e) => setParams((p) => ({ ...p, fitK: e.target.value }))}
              >
                <option value="auto">Auto</option>
                {Array.from({ length: 9 }, (_, i) => i + 2).map((k) => (
                  <option key={k} value={String(k)}>{k}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <FieldLabel>Scan K</FieldLabel>
              <input
                className="input-ui h-9 w-full px-3 text-[12px]"
                type="number"
                min="2"
                max="10"
                step="1"
                value={params.maxK}
                onChange={(e) => setParams((p) => ({ ...p, maxK: Number(e.target.value || 10) }))}
              />
            </label>
            <label className="block">
              <FieldLabel>HMM iters</FieldLabel>
              <input
                className="input-ui h-9 w-full px-3 text-[12px]"
                type="number"
                min="3"
                max="40"
                step="1"
                value={params.hmmIterations}
                onChange={(e) => setParams((p) => ({ ...p, hmmIterations: Number(e.target.value || 10) }))}
              />
            </label>
            <button
              onClick={() => runAnalysis()}
              disabled={loading || !selectedDataset}
              className="mt-4 inline-flex h-9 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-main)] px-3 text-[12px] font-semibold lg:mt-[17px]"
            >
              {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {loading ? "Running" : "Build"}
            </button>
            <button
              onClick={async () => {
                setDatasetsLoading(true);
                setError("");
                try {
                  const res = await fetch("/api/phatich5/regime", { cache: "no-store" });
                  const json = await res.json();
                  if (!res.ok || !json?.ok) throw new Error(json?.error || `Dataset request failed: ${res.status}`);
                  setDatasets(json.datasets || []);
                  setSelectedDataset((curr) => curr || json.defaultDataset || "");
                } catch (err) {
                  setError(err?.message || "Failed to refresh datasets.");
                } finally {
                  setDatasetsLoading(false);
                }
              }}
              disabled={datasetsLoading}
              className="mt-4 inline-flex h-9 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-main)] px-3 text-[12px] font-semibold lg:mt-[17px]"
            >
              {datasetsLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          </div>

          <div className="mt-3 border border-[var(--border-color)] bg-[var(--bg-main)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-color)] px-3 py-2">
              <div>
                <div className="text-[12px] font-semibold">Feature filter before model fit</div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  HMM/KMeans will run only on selected features. Current: {selectedFeatures.length}/{Object.keys(featureLabels).length}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {featurePresets.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => setFeaturePreset(preset.features)}
                    className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[10px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)]"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 px-3 py-3 xl:grid-cols-4">
              {featureGroups.map((group) => {
                const checkedCount = group.features.filter((feature) => selectedFeatureSet.has(feature)).length;
                return (
                  <div key={group.key} className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleFeatureGroup(group.features)}
                      className="mb-2 flex w-full items-center justify-between gap-2 text-left"
                    >
                      <span className="text-[11px] font-semibold">{group.label}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{checkedCount}/{group.features.length}</span>
                    </button>
                    <div className="space-y-1">
                      {group.features.map((feature) => (
                        <label key={feature} className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-muted)]">
                          <input
                            type="checkbox"
                            checked={selectedFeatureSet.has(feature)}
                            onChange={() => toggleFeature(feature)}
                            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                          />
                          <span>{featureLabels[feature]}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {selectedFeatures.length < 2 ? (
              <div className="border-t border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11px] text-[var(--danger-text)]">
                Select at least 2 features. The backend will fallback to all features if fewer than 2 are selected.
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="mt-3 flex items-start gap-2 border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] text-[var(--danger-text)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div className="px-5 py-4">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Latest regime"
              value={result?.latest?.label || "N/A"}
              helper={result ? "Neutral hidden-state label" : "Chua co ket qua"}
              icon={Route}
            />
            <Metric
              label="State confidence"
              value={result ? fmtPct(result.latest?.confidence || 0) : "N/A"}
              helper="Posterior max cua state hien tai"
              icon={Sigma}
            />
            <Metric
              label="State runs"
              value={result ? fmtInt(result.segments?.length) : "N/A"}
              helper="So lan regime segment trong lich su"
              icon={GitCommitHorizontal}
            />
	            <Metric
	              label="Selected K"
	              value={result ? fmtInt(result.meta?.chosenK) : "N/A"}
	              helper={result?.meta?.kSelection ? `mode=${result.meta.kSelection.method}, score=${result.meta.kSelection.chosenByScore}, sil=${result.meta.kSelection.chosenBySilhouette}` : "K diagnostics"}
	              icon={BarChart3}
	            />
            <Metric
              label="Aligned rows"
              value={result ? fmtInt(result.meta?.rows) : "N/A"}
              helper={result?.meta?.dataset || "Liquidation + funding + OI + CVD + price"}
              icon={Waves}
            />
          </div>
        </div>
      </div>

      {result ? (
        <>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_360px]">
            <div className="panel-shell overflow-hidden">
              <div className="panel-header flex items-center justify-between px-4 py-3">
                <div>
                  <h2 className="text-[14px] font-semibold">BTC price + state switches</h2>
                  <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Dots mark only regime changes. The strip below shows state coverage for the full dataset.</p>
                </div>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {result.meta?.startTime?.slice(0, 10)} - {result.meta?.endTime?.slice(0, 10)}
                </span>
              </div>
              <div className="h-[420px] px-2 py-2">
                <div ref={chartRef} className="h-full w-full" />
              </div>
              <StateStrip segments={result.segments || []} />
            </div>

            <div className="panel-shell overflow-hidden">
              <div className="panel-header px-4 py-3">
                <h2 className="text-[14px] font-semibold">Selected candle state</h2>
              </div>
              <div className="space-y-2 px-4 py-3 text-[12px]">
                <div className={`border px-3 py-2 ${toneClass(result.states?.[selectedPoint?.state]?.tone)}`}>
                  <div className="text-[10px] uppercase text-current opacity-70">Selected time</div>
                  <div className="mt-1 font-semibold">{selectedPoint?.timestamp || result.latest?.timestamp}</div>
                </div>
                <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2">
                  <div className="text-[10px] uppercase text-[var(--text-muted)]">Most likely state</div>
                  <div className="mt-1 font-semibold">
                    {selectedPoint ? `State ${selectedPoint.state + 1}` : result.latest?.label} ({fmtPct(selectedPoint?.confidence || result.latest?.confidence || 0)})
                  </div>
                </div>
                <div className="space-y-1 border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2">
                  <div className="text-[10px] uppercase text-[var(--text-muted)]">State probabilities</div>
                  {(selectedPoint?.stateProbs || []).map((prob) => (
                    <div key={prob.state} className="grid grid-cols-[58px_1fr_48px] items-center gap-2 text-[11px]">
                      <div className="font-semibold" style={{ color: prob.color }}>{prob.label}</div>
                      <div className="h-2 bg-[var(--bg-secondary)]">
                        <div className="h-full" style={{ width: `${Math.max(0, Math.min(100, prob.probability * 100))}%`, backgroundColor: prob.color }} />
                      </div>
                      <div className="text-right tabular-nums">{fmtPct(prob.probability)}</div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <SmallMetric label="Vol" value={fmtNum(selectedPoint?.priceVol24, 3)} />
                  <SmallMetric label="Funding" value={fmtNum(selectedPoint?.fundingShock, 3)} />
                  <SmallMetric label="OI" value={fmtNum(selectedPoint?.oiRet24, 3)} />
                  <SmallMetric label="Liq" value={fmtNum(selectedPoint?.liqShock, 3)} />
                </div>
                                <div className="space-y-2 border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2 border-b border-[var(--border-color)] pb-1.5">
                    <div className="text-[10px] uppercase text-[var(--text-muted)] font-semibold">State transitions</div>
                    <div className="flex gap-1">
                      {["1h", "6h", "12h", "24h"].map((tf) => (
                        <button
                          key={tf}
                          type="button"
                          onClick={() => setProjectionTimeframe(tf)}
                          className={`px-1.5 py-0.5 text-[9px] font-semibold border ${
                            projectionTimeframe === tf
                              ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_12%,white)] text-[var(--text-main)]"
                              : "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)]"
                          }`}
                        >
                          {tf === "1h" ? "1h (hist)" : tf}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5 pt-0.5">
                    {displayTransitionProbs.length ? (
                      displayTransitionProbs.map((prob) => (
                        <div key={prob.state} className="grid grid-cols-[58px_1fr_48px] items-center gap-2 text-[11px]">
                          <div className="font-semibold" style={{ color: prob.color }}>{prob.label}</div>
                          <div className="h-2 bg-[var(--bg-secondary)]">
                            <div className="h-full" style={{ width: `${Math.max(0, Math.min(100, prob.probability * 100))}%`, backgroundColor: prob.color }} />
                          </div>
                          <div className="text-right tabular-nums">{fmtPct(prob.probability)}</div>
                        </div>
                      ))
                    ) : (
                      <div className="text-[10px] text-[var(--text-muted)]">No transition data available</div>
                    )}
                  </div>

                  {/* Duration-dependent transition timing forecast */}
                  {transitionTimingForecast && (
                    <div className="mt-3 pt-2.5 border-t border-[var(--border-color)]/50 space-y-1.5 text-[10px]">
                      <div className="flex justify-between items-center text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                        <span>Transition Forecast</span>
                        <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-pulse" />
                      </div>
                      
                      <div className="bg-[var(--bg-secondary)] px-2 py-1.5 border border-[var(--border-color)]/60 space-y-0.5 rounded font-mono text-[9px]">
                        <div className="flex justify-between">
                          <span className="text-[var(--text-muted)]">Duration:</span>
                          <span className="font-bold text-[var(--text-main)]">
                            {transitionTimingForecast.currentDuration} nến ({fmtDurationHours(transitionTimingForecast.currentDuration, result?.meta?.interval)})
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[var(--text-muted)]">Expected remaining:</span>
                          <span className="font-bold text-amber-400">
                            ~{transitionTimingForecast.expectedRemainingHours.toFixed(1)} giờ
                          </span>
                        </div>
                      </div>

                      <div className="space-y-1 pt-0.5">
                        {transitionTimingForecast.forecasts.map(f => (
                          <div key={f.state} className="flex items-center justify-between border-b border-[var(--border-color)]/20 pb-0.5 text-[9px]">
                            <div className="flex items-center gap-1">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: f.color }} />
                              <span className="font-semibold" style={{ color: f.color }}>{f.label}</span>
                            </div>
                            <div className="text-right">
                              <span className="font-bold text-[var(--text-main)]">
                                {f.peakHours === 0 ? "N/A" : `sau ~${f.peakHours.toFixed(1)}h`}
                              </span>
                              <span className="text-[8px] text-[var(--text-muted)] ml-1">
                                (đỉnh {fmtPct(f.peakProb)})
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {selectedSegment ? (
                  <div className="space-y-2 border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] uppercase text-[var(--text-muted)]">Selected segment</div>
                      <div className="font-semibold" style={{ color: selectedSegment.color }}>{selectedSegment.label}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <SmallMetric label="Length" value={fmtHours(selectedSegment.hours)} />
                      <SmallMetric label="Bars" value={fmtInt(selectedSegment.bars)} />
                      <SmallMetric label="Price move" value={fmtPct(selectedSegment.priceReturn)} />
                      <SmallMetric label="Close range" value={fmtPct(selectedSegment.closeRange)} />
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)]">
                      Same state means similar market-feature vector and transition context, not one-way price movement.
                    </div>
                  </div>
                ) : null}
                <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
                  Every candle has a state. Chart dots mark only state changes.
                </div>
              </div>
            </div>
          </div>

          <div className="panel-shell overflow-hidden">
            <div className="panel-header flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <div className="flex items-center gap-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`border px-3 py-1.5 text-[11px] font-semibold ${
                      activeTab === tab.key
                        ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_12%,white)] text-[var(--text-main)]"
                        : "border-[var(--border-color)] bg-[var(--bg-main)] text-[var(--text-muted)]"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {fmtInt(result.meta?.featureRows)} feature rows | logLik {fmtNum(result.meta?.logLik, 2)}
              </div>
            </div>

            {activeTab === "regimes" ? (
              <div className="overflow-auto thin-scrollbar">
                <table className="min-w-[860px] w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                      <th className="px-5 py-3">State</th>
                      <th className="px-5 py-3">Share</th>
                      <th className="px-5 py-3">State</th>
                      <th className="px-5 py-3">Confidence</th>
                      <th className="px-5 py-3">Vol</th>
                      <th className="px-5 py-3">Funding</th>
                      <th className="px-5 py-3">OI</th>
                      <th className="px-5 py-3">CVD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.states?.map((state) => (
                      <tr key={state.state} className="border-b border-[var(--border-color)]/70 align-top">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: state.color }}
                            />
                            <span className="font-semibold">R{state.state + 1}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">{fmtPct(state.share || 0)}</td>
                        <td className="px-5 py-3 font-semibold">{state.label}</td>
                        <td className="px-5 py-3">{fmtPct(state.confidence || 0)}</td>
                        <td className="px-5 py-3">{fmtNum(state.highlights?.vol, 3)}</td>
                        <td className="px-5 py-3">{fmtNum(state.highlights?.funding, 3)}</td>
                        <td className="px-5 py-3">{fmtNum(state.highlights?.oi, 3)}</td>
                        <td className="px-5 py-3">{fmtNum(state.highlights?.cvd, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {activeTab === "durations" ? (
              <div className="grid gap-4 px-4 py-4 xl:grid-cols-[1fr_1.2fr]">
                <div className="overflow-auto thin-scrollbar">
                  <table className="min-w-[560px] w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                        <th className="py-2">State</th>
                        <th className="py-2 text-right">Runs</th>
                        <th className="py-2 text-right">Avg</th>
                        <th className="py-2 text-right">Median</th>
                        <th className="py-2 text-right">Max</th>
                        <th className="py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.durationStats?.map((row) => (
                        <tr key={row.state} className="border-b border-[var(--border-color)]/70">
                          <td className="py-2">
                            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                            <span className="font-semibold">{row.label}</span>
                          </td>
                          <td className="py-2 text-right">{fmtInt(row.runs)}</td>
                          <td className="py-2 text-right">{fmtHours(row.avgHours)}</td>
                          <td className="py-2 text-right">{fmtHours(row.medianHours)}</td>
                          <td className="py-2 text-right">{fmtHours(row.maxHours)}</td>
                          <td className="py-2 text-right">{fmtHours(row.totalHours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-2">
                  {(result.segments || []).slice(-18).reverse().map((segment, idx) => (
                    <div key={`${segment.startTime}-${idx}`} className="grid grid-cols-[80px_1fr_70px] items-center gap-3 border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2 text-[11px]">
                      <div className="font-semibold" style={{ color: segment.color }}>{segment.label}</div>
                      <div className="truncate text-[var(--text-muted)]">
                        {segment.startTimestamp} &gt; {segment.endTimestamp} | move {fmtPct(segment.priceReturn)} | range {fmtPct(segment.closeRange)}
                      </div>
                      <div className="text-right font-semibold">{fmtHours(segment.hours)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {activeTab === "transitions" ? (
              <div className="px-4 py-4 space-y-3">
                <div className="flex justify-between items-center border-b border-[var(--border-color)] pb-2 flex-wrap gap-2">
                  <div className="text-[12px] font-semibold text-[var(--text-main)]">Transition Probability Projections</div>
                  <div className="flex gap-1">
                    {["1h", "6h", "12h", "24h"].map((tf) => (
                      <button
                        key={tf}
                        type="button"
                        onClick={() => setProjectionTimeframe(tf)}
                        className={`px-2 py-1 text-[10px] font-semibold border ${
                          projectionTimeframe === tf
                            ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_12%,white)] text-[var(--text-main)]"
                            : "border-[var(--border-color)] bg-[var(--bg-main)] text-[var(--text-muted)]"
                        }`}
                      >
                        {tf === "1h" ? "1h (hist)" : tf}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="overflow-auto thin-scrollbar">
                  <table className="min-w-[520px] w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                        <th className="py-2">From / To</th>
                        {result.states?.map((state) => (
                          <th key={state.state} className="py-2 text-right">R{state.state + 1}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.states?.map((stateRow, i) => {
                        const row = projectionTimeframe === "1h"
                          ? (result.transitions?.[i] || []).map(cell => ({ p: cell.p }))
                          : (stateRow.projections?.[projectionTimeframe] || []).map(cell => ({ p: cell.p }));
                        return (
                          <tr key={i} className="border-b border-[var(--border-color)]/70">
                            <td className="py-2 font-semibold">R{i + 1}</td>
                            {row.map((cell, j) => (
                              <td key={j} className="py-2 text-right">{fmtPct(cell.p || 0)}</td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {activeTab === "features" ? (
              <div className="px-4 py-4">
                <StateStrip segments={result.segments || []} tall />
                <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {result.states?.map((state) => (
                    <div key={state.state} className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2 text-[11px]">
                      <div className="flex items-center gap-2 font-semibold">
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: state.color }} />
                        {state.label}
                      </div>
                      <div className="mt-1 text-[var(--text-muted)]">Share {fmtPct(state.share)} | Avg confidence {fmtPct(state.confidence)}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[11px] text-[var(--text-muted)]">Compressed full-history state strip. Hover each segment to inspect start/end and duration.</div>
              </div>
            ) : null}

            {activeTab === "diagnostics" ? (
              <div className="space-y-4 px-4 py-4">
                <KDecisionPanel meta={result.meta} onSelectK={handleSelectK} />
                <ProjectionExplanation featureCount={result.featureNames?.length || 0} />
                <QualityPanel diagnostics={result.diagnostics} meta={result.meta} />
                <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                  <PcaPlot data={result.diagnostics?.pca} />
                  <div className="grid gap-3">
                    <DiagnosticBars rows={result.meta?.candidateKs || []} field="silhouette" label="Silhouette by K" />
                    <DiagnosticBars rows={result.meta?.candidateKs || []} field="elbowDrop" label="Elbow drop by K" percent />
                    <ConfidenceHistogram timeline={result.timeline || []} states={result.states || []} />
                  </div>
                </div>
                <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                  <ScatterPlot points={result.diagnostics?.scatter || []} />
                  <StateDistanceMatrix diagnostics={result.diagnostics} states={result.states || []} />
                </div>
                <FeatureHeatmap states={result.states || []} featureStats={result.featureStats || {}} />
                <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                  <TransitionHeatmap transitions={result.transitions || []} states={result.states || []} />
                  <DurationProfile durationStats={result.durationStats || []} />
                </div>
              </div>
            ) : null}

            {activeTab === "k" ? (
              <div className="space-y-4 px-4 py-4">
                <div>
                  <div className="text-[12px] font-semibold text-[var(--text-main)] mb-2">Optimal K Recommendation Strategies</div>
                  <KDecisionPanel meta={result.meta} onSelectK={handleSelectK} />
                </div>
                <div className="overflow-auto thin-scrollbar pt-2">
                  <div className="text-[12px] font-semibold text-[var(--text-main)] mb-2">Detailed K Evaluation Metrics</div>
	                  <table className="min-w-[940px] w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                        <th className="py-2">K</th>
                        <th className="py-2">Inertia</th>
                        <th className="py-2">Silhouette</th>
                        <th className="py-2">Elbow Drop</th>
                        <th className="py-2">AIC</th>
                        <th className="py-2">BIC</th>
	                        <th className="py-2">Persistence</th>
	                        <th className="py-2">Balance</th>
	                        <th className="py-2">Min share</th>
	                        <th className="py-2">Max share</th>
	                        <th className="py-2">Interpretability</th>
	                        <th className="py-2">Score</th>
                        <th className="py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.meta?.candidateKs?.map((row) => (
                        <tr key={row.k} className={`border-b border-[var(--border-color)]/70 ${row.k === Number(result.meta.chosenK) ? "bg-[color-mix(in_oklab,var(--color-accent)_6%,white)]" : ""}`}>
                          <td className="py-2 font-semibold">
                            {row.k} {row.k === Number(result.meta.chosenK) ? <span className="ml-1 text-[9px] text-[var(--color-accent)] font-normal">(Active)</span> : ""}
                          </td>
                          <td className="py-2">{fmtNum(row.inertia, 2)}</td>
                          <td className="py-2">{fmtNum(row.silhouette, 3)}</td>
                          <td className="py-2">{fmtPct(row.elbowDrop || 0)}</td>
                          <td className="py-2">{row.aic !== undefined ? fmtNum(row.aic, 0) : "N/A"}</td>
                          <td className="py-2">{row.bic !== undefined ? fmtNum(row.bic, 0) : "N/A"}</td>
	                          <td className="py-2">{row.persistence !== undefined ? fmtPct(row.persistence) : "N/A"}</td>
	                          <td className="py-2">{row.balance !== undefined ? fmtPct(row.balance) : "N/A"}</td>
	                          <td className="py-2">{row.minShare !== undefined ? fmtPct(row.minShare) : "N/A"}</td>
	                          <td className="py-2">{row.maxShare !== undefined ? fmtPct(row.maxShare) : "N/A"}</td>
	                          <td className="py-2 font-semibold" style={{ color: row.k === Number(result.meta.chosenK) ? "var(--color-accent)" : undefined }}>
                            {row.interpretability !== undefined ? fmtPct(row.interpretability) : "N/A"}
                          </td>
                          <td className="py-2">{fmtNum(row.score, 3)}</td>
                          <td className="py-2 text-right text-[10px]">
                            {row.k === Number(result.meta.chosenK) ? (
                              <span className="text-[10px] text-[var(--color-accent)] font-semibold">Current</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSelectK(row.k)}
                                className="border border-[var(--border-color)] bg-[var(--bg-main)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] hover:border-[var(--text-muted)] cursor-pointer"
                              >
                                Apply
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border-color)] pt-2 space-y-1">
                  <div>• <strong>Silhouette</strong>: Measures cluster separation (higher is better). Good for identifying distinct shapes.</div>
                  <div>• <strong>Elbow Drop</strong>: Measures reduction in within-cluster variance. We look for the "elbow" where the drop starts to slow down.</div>
                  <div>• <strong>AIC / BIC</strong>: Information criteria from GMM/HMM log-likelihood (lower is better). BIC penalizes parameters more heavily to favor simpler models.</div>
                  <div>• <strong>Persistence</strong>: Mean probability of remaining in the same state. High persistence prevents noise/flip-flopping.</div>
                  <div>• <strong>Balance</strong>: Entropy of state distributions. High balance means state coverage is distributed rather than dominated by a single state.</div>
                  <div>• <strong>Interpretability</strong>: Combination of Persistence and Balance. Maximizing this results in highly stable, meaningful, and well-distributed regimes.</div>
                </div>
              </div>
            ) : null}


            {activeTab === "validation" ? (
              <div className="space-y-4 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-color)] pb-3">
                  <div>
                    <h3 className="text-[12px] font-semibold text-[var(--text-main)]">Regime Out-of-Sample Validation</h3>
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                      Tests the predictive power of each regime by analyzing price action in the subsequent 24h/72h.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <div className="flex items-center gap-1.5 border border-[var(--border-color)] bg-[var(--bg-main)] px-2 py-1">
                      <span className="text-[10px] uppercase text-[var(--text-muted)]">Metric:</span>
                      <select
                        className="bg-transparent border-0 font-semibold focus:outline-none focus:ring-0 cursor-pointer text-[11px] p-0"
                        value={valMetric}
                        onChange={(e) => setValMetric(e.target.value)}
                      >
                        <option value="vol">Volatility</option>
                        <option value="dd">Max Drawdown</option>
                        <option value="range">Price Range</option>
                        <option value="ret">Future Return</option>
                        <option value="liq">Future Liquidations</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5 border border-[var(--border-color)] bg-[var(--bg-main)] px-2 py-1">
                      <span className="text-[10px] uppercase text-[var(--text-muted)]">Horizon:</span>
                      <select
                        className="bg-transparent border-0 font-semibold focus:outline-none focus:ring-0 cursor-pointer text-[11px] p-0"
                        value={valTimeframe}
                        onChange={(e) => setValTimeframe(e.target.value)}
                      >
                        <option value="24h">24 Hours</option>
                        <option value="72h">72 Hours</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[11px] text-[var(--text-muted)] rounded">
                  <strong>How to evaluate predictive power:</strong> Volatility, Drawdown, Range, Return, and Liquidations metrics are computed for the future window starting <em>after</em> the candle is assigned to a state. If the boxplots below are cleanly separated, the states have true predictive value. If the boxes overlap heavily, the states capture in-sample features but have no forecasting ability.
                </div>

                {/* Boxplots Container */}
                <div className="space-y-3">
                  {(() => {
                    const statsList = result?.validationStats || [];
                    const metricKey = `${valMetric}${valTimeframe === "24h" ? "24" : "72"}`;
                    
                    const mins = statsList.map(s => s[metricKey]?.min ?? 0);
                    const maxs = statsList.map(s => s[metricKey]?.max ?? 0);
                    const gMin = Math.min(...mins, 0);
                    const gMax = Math.max(...maxs, 0.001);
                    const gRange = gMax - gMin || 1;
                    
                    const scale = (val) => ((val - gMin) / gRange) * 100;
                    
                    const formatVal = (v) => {
                      if (valMetric === "liq") {
                        return fmtUsdCompact(v);
                      }
                      return fmtPct(v);
                    };

                    return statsList.map((stateRow) => {
                      const box = stateRow[metricKey] || { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, count: 0 };
                      const minPct = scale(box.min);
                      const maxPct = scale(box.max);
                      const q1Pct = scale(box.q1);
                      const q3Pct = scale(box.q3);
                      const medianPct = scale(box.median);
                      const meanPct = scale(box.mean);

                      return (
                        <div key={stateRow.state} className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3 space-y-2">
                          <div className="flex justify-between items-center text-[11px]">
                            <div className="flex items-center gap-2 font-semibold">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stateRow.color }} />
                              <span>{stateRow.label} (N = {fmtInt(box.count)} candles)</span>
                            </div>
                            <div className="text-[var(--text-muted)] text-[10px] flex items-center gap-2">
                              {valMetric === "ret" && box.winRate !== undefined && (
                                <span className="mr-2">Win Rate: <span className="font-semibold text-emerald-500">{(box.winRate * 100).toFixed(1)}%</span> |</span>
                              )}
                              <span>Mean: <span className="font-semibold text-[var(--text-main)]">{formatVal(box.mean)}</span></span> |
                              <span>Median: <span className="font-semibold text-[var(--text-main)]">{formatVal(box.median)}</span></span>
                            </div>
                          </div>
                          
                          {/* Custom Boxplot Grid */}
                          <div className="relative h-9 flex items-center bg-[var(--bg-secondary)] border border-[var(--border-color)]/30 rounded px-1">
                            {/* Scale lines */}
                            <div className="absolute inset-0 flex justify-between pointer-events-none opacity-[0.07]">
                              <div className="border-r border-[var(--text-muted)] h-full" />
                              <div className="border-r border-[var(--text-muted)] h-full" />
                              <div className="border-r border-[var(--text-muted)] h-full" />
                              <div className="border-r border-[var(--text-muted)] h-full" />
                              <div className="border-r border-[var(--text-muted)] h-full" />
                            </div>

                            {/* Whisker Line */}
                            <div 
                              className="absolute h-0.5 bg-slate-400 opacity-60 top-1/2 -translate-y-1/2"
                              style={{
                                left: `${minPct}%`,
                                width: `${maxPct - minPct}%`
                              }}
                            />
                            {/* Left Whisker Cap */}
                            <div 
                              className="absolute w-0.5 h-3 bg-slate-400 opacity-60 top-1/2 -translate-y-1/2"
                              style={{ left: `${minPct}%` }}
                            />
                            {/* Right Whisker Cap */}
                            <div 
                              className="absolute w-0.5 h-3 bg-slate-400 opacity-60 top-1/2 -translate-y-1/2"
                              style={{ left: `${maxPct}%` }}
                            />

                            {/* IQR Box */}
                            <div 
                              className="absolute h-4.5 border border-current shadow-sm rounded-sm top-1/2 -translate-y-1/2"
                              style={{
                                left: `${q1Pct}%`,
                                width: `${q3Pct - q1Pct}%`,
                                backgroundColor: `color-mix(in oklab, ${stateRow.color} 75%, transparent)`,
                                color: stateRow.color
                              }}
                            />

                            {/* Median Line */}
                            <div 
                              className="absolute w-0.5 h-4.5 bg-white z-10 top-1/2 -translate-y-1/2"
                              style={{ left: `${medianPct}%` }}
                            />

                            {/* Mean Marker */}
                            <div 
                              className="absolute w-2 h-2 rounded-full bg-slate-800 border border-white z-10 top-1/2 -translate-y-1/2 -translate-x-1/2"
                              style={{ left: `${meanPct}%` }}
                            />
                          </div>

                          {/* Tick Labels */}
                          <div className="flex justify-between text-[9px] text-[var(--text-muted)] px-1">
                            <span>Min: {formatVal(box.min)}</span>
                            <span>Q1: {formatVal(box.q1)}</span>
                            <span>Median: {formatVal(box.median)}</span>
                            <span>Q3: {formatVal(box.q3)}</span>
                            <span>Max: {formatVal(box.max)}</span>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>

                {/* Summary Table */}
                {(() => {
                  const statsList = result?.validationStats || [];
                  const metricKey = `${valMetric}${valTimeframe === "24h" ? "24" : "72"}`;
                  
                  return (
                    <div className="overflow-auto thin-scrollbar pt-2">
                      <div className="text-[12px] font-semibold text-[var(--text-main)] mb-2">Metrics Summary Table ({valTimeframe} Horizon)</div>
                      <table className="min-w-[700px] w-full text-[11px]">
                        <thead>
                          <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                            <th className="py-2">State</th>
                            <th className="py-2 text-right">Sample size (N)</th>
                            <th className="py-2 text-right">Min</th>
                            <th className="py-2 text-right">Q1 (25th)</th>
                            <th className="py-2 text-right">Median (50th)</th>
                            {valMetric === "ret" && <th className="py-2 text-right text-emerald-500 font-semibold">Win Rate</th>}
                            <th className="py-2 text-right">Mean</th>
                            <th className="py-2 text-right">Q3 (75th)</th>
                            <th className="py-2 text-right">Max</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statsList.map((stateRow) => {
                            const box = stateRow[metricKey] || { min: 0, q1: 0, median: 0, q3: 0, max: 0, mean: 0, count: 0 };
                            const formatValLocal = (v) => {
                              if (valMetric === "liq") {
                                return fmtUsdCompact(v);
                              }
                              return fmtPct(v);
                            };
                            return (
                              <tr key={stateRow.state} className="border-b border-[var(--border-color)]/70">
                                <td className="py-2 font-semibold">
                                  <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: stateRow.color }} />
                                  {stateRow.label}
                                </td>
                                <td className="py-2 text-right tabular-nums">{fmtInt(box.count)}</td>
                                <td className="py-2 text-right tabular-nums">{formatValLocal(box.min)}</td>
                                <td className="py-2 text-right tabular-nums">{formatValLocal(box.q1)}</td>
                                <td className="py-2 text-right tabular-nums font-semibold" style={{ color: stateRow.color }}>{formatValLocal(box.median)}</td>
                                {valMetric === "ret" && (
                                  <td className="py-2 text-right tabular-nums font-semibold text-emerald-500">
                                    {(box.winRate * 100).toFixed(1)}%
                                  </td>
                                )}
                                <td className="py-2 text-right tabular-nums">{formatValLocal(box.mean)}</td>
                                <td className="py-2 text-right tabular-nums">{formatValLocal(box.q3)}</td>
                                <td className="py-2 text-right tabular-nums">{formatValLocal(box.max)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            ) : null}

            {activeTab === "radar" ? (
              <div className="space-y-6 px-4 py-4">
                <div className="border-b border-[var(--border-color)] pb-3">
                  <h3 className="text-[12px] font-semibold text-[var(--text-main)]">Regime Attribute Radar (Hồ sơ thuộc tính HMM)</h3>
                  <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    So sánh các trạng thái thị trường trên 6 chiều thuộc tính cốt lõi (được chuẩn hóa tương đối từ 20 đến 100).
                  </p>
                </div>

                {/* Radar calculation */}
                {(() => {
                  const timeline = result?.timeline || [];
                  const states = result?.states || [];
                  const radarAxes = [
                    { key: "vol", label: "Volatility" },
                    { key: "liq", label: "Liquidation" },
                    { key: "funding", label: "Funding Skew" },
                    { key: "oi", label: "OI Growth" },
                    { key: "cvd", label: "Buy Volume" },
                    { key: "stability", label: "Stability" }
                  ];

                  // 1. Calculate raw averages per state
                  const rawAverages = states.map((s) => {
                    const stateTimeline = timeline.filter(c => c.state === s.state);
                    const count = stateTimeline.length || 1;
                    
                    const avgVol = stateTimeline.reduce((acc, c) => acc + (c.priceVol24 || 0), 0) / count;
                    const avgLiq = stateTimeline.reduce((acc, c) => acc + (c.liqShock || 0), 0) / count;
                    const avgFunding = stateTimeline.reduce((acc, c) => acc + (c.fundingShock || 0), 0) / count;
                    const avgOi = stateTimeline.reduce((acc, c) => acc + (c.oiRet24 || 0), 0) / count;
                    const avgCvd = stateTimeline.reduce((acc, c) => acc + (c.cvdRet24 || 0), 0) / count;
                    
                    // Transition stability P(S_i -> S_i)
                    const stability = result.transitions?.[s.state]?.find(t => t.to === s.state)?.p ?? 0;
                    
                    return {
                      state: s.state,
                      label: s.label,
                      color: s.color,
                      count: s.count,
                      share: s.share,
                      rawValues: {
                        vol: avgVol,
                        liq: avgLiq,
                        funding: avgFunding,
                        oi: avgOi,
                        cvd: avgCvd,
                        stability: stability
                      }
                    };
                  });

                  // 2. Normalize values from 20 to 100 relative to all states
                  const keys = ["vol", "liq", "funding", "oi", "cvd", "stability"];
                  const minMax = {};
                  for (const k of keys) {
                    const vals = rawAverages.map(r => r.rawValues[k]);
                    minMax[k] = {
                      min: Math.min(...vals),
                      max: Math.max(...vals)
                    };
                  }

                  const statesData = rawAverages.map((r) => {
                    const scaledValues = {};
                    for (const k of keys) {
                      const min = minMax[k].min;
                      const max = minMax[k].max;
                      const diff = max - min;
                      scaledValues[k] = diff > 0 ? ((r.rawValues[k] - min) / diff) * 80 + 20 : 50;
                    }
                    return {
                      ...r,
                      scaledValues
                    };
                  });

                  const toggleState = (stateIdx) => {
                    setActiveRadarStates((prev) => {
                      const next = new Set(prev);
                      if (next.has(stateIdx)) {
                        if (next.size > 1) next.delete(stateIdx);
                      } else {
                        next.add(stateIdx);
                      }
                      return next;
                    });
                  };

                  return (
                    <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
                      {/* Unified Overlay Chart */}
                      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-4 flex flex-col justify-between">
                        <div>
                          <h4 className="text-[12px] font-semibold mb-2">Overlaid Comparison (Radar So Sánh Chung)</h4>
                          <p className="text-[10px] text-[var(--text-muted)] mb-4">
                            Biểu đồ radar xếp chồng giúp so sánh tương quan giữa các regime. Tích chọn các ô bên dưới để bật/tắt hiển thị từng regime.
                          </p>
                        </div>
                        <div className="flex justify-center items-center py-2">
                          <OverlaidRadarChart
                            cx={170}
                            cy={170}
                            r={110}
                            axes={radarAxes}
                            statesData={statesData}
                            activeStates={activeRadarStates}
                          />
                        </div>
                        {/* Selector switches */}
                        <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-[var(--border-color)]/70">
                          {statesData.map((s) => (
                            <button
                              key={s.state}
                              type="button"
                              onClick={() => toggleState(s.state)}
                              className={`flex items-center gap-2 border px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                                activeRadarStates.has(s.state)
                                  ? "bg-[var(--bg-secondary)] text-[var(--text-main)]"
                                  : "bg-transparent text-[var(--text-muted)] border-dashed"
                              }`}
                              style={{ borderColor: activeRadarStates.has(s.state) ? s.color : "var(--border-color)" }}
                            >
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: activeRadarStates.has(s.state) ? s.color : "#94a3b8" }} />
                              <span>{s.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Individual State Cards Grid */}
                      <div className="grid gap-4 md:grid-cols-2">
                        {statesData.map((s) => (
                          <div key={s.state} className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3 flex flex-col justify-between">
                            <div className="flex justify-between items-center border-b border-[var(--border-color)]/60 pb-2 mb-2">
                              <div className="flex items-center gap-1.5">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                                <span className="font-semibold text-[11px]">{s.label}</span>
                              </div>
                              <span className="text-[9px] text-[var(--text-muted)]">N={fmtInt(s.count)} ({fmtPct(s.share)})</span>
                            </div>
                            <div className="flex justify-center py-1 max-h-[160px] overflow-hidden">
                              <RadarChart
                                cx={160}
                                cy={160}
                                r={100}
                                axes={radarAxes}
                                data={s.scaledValues}
                                color={s.color}
                              />
                            </div>
                            {/* Raw values list */}
                            <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-[9px] border-t border-[var(--border-color)]/50 pt-2">
                              <div className="flex justify-between">
                                <span className="text-[var(--text-muted)]">Volatility:</span>
                                <span className="font-mono font-semibold">{fmtNum(s.rawValues.vol, 4)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--text-muted)]">Liquidation:</span>
                                <span className="font-mono font-semibold">{fmtNum(s.rawValues.liq, 2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--text-muted)]">Funding:</span>
                                <span className="font-mono font-semibold">{fmtNum(s.rawValues.funding, 2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--text-muted)]">OI Growth:</span>
                                <span className="font-mono font-semibold">{fmtPct(s.rawValues.oi)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--text-muted)]">CVD Buy:</span>
                                <span className="font-mono font-semibold">{fmtNum(s.rawValues.cvd, 0)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[var(--text-muted)]">Stability:</span>
                                <span className="font-mono font-semibold">{fmtPct(s.rawValues.stability)}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : null}

            {activeTab === "polymarket" ? (
              <Phatich5PolymarketPanel
                datasets={datasets}
                selectedDataset={selectedDataset}
                selectedFeatures={selectedFeatures}
                params={params}
              />
            ) : null}

            {activeTab === "paper" ? (
              <Phatich5LivePaperPanel />
            ) : null}

            {activeTab === "logs" ? (
              <LivePaperLogsTab />
            ) : null}

          </div>
        </>
      ) : (
        <div className="panel-shell px-5 py-8 text-[12px] text-[var(--text-muted)]">
          <div className="flex items-start gap-2">
            <Table2 className="mt-0.5 h-4 w-4" />
            <div>
              Chon dataset local trong data folder de tao regime vector. Trang se fit HMM truc tiep tren CSV da tai ve,
              khong goi Coinglass API moi lan.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SmallMetric({ label, value }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2">
      <div className="text-[10px] uppercase text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-semibold">{value}</div>
    </div>
  );
}

function StateStrip({ segments, tall = false }) {
  const adjustedWidths = useMemo(() => {
    if (!segments.length) return [];
    const minWidth = 0.08;
    const totalBars = segments.reduce((sum, s) => sum + Number(s.bars || 0), 0) || 1;
    let adjusted = segments.map(s => Math.max(minWidth, (Number(s.bars || 0) / totalBars) * 100));
    
    let iterations = 0;
    while (iterations < 10) {
      let currentSum = adjusted.reduce((a, b) => a + b, 0);
      let error = currentSum - 100;
      
      let shrinkableSum = 0;
      for (let i = 0; i < adjusted.length; i++) {
        if (adjusted[i] > minWidth) {
          shrinkableSum += (adjusted[i] - minWidth);
        }
      }
      
      if (shrinkableSum <= 0 || Math.abs(error) < 0.001) {
        break;
      }
      
      for (let i = 0; i < adjusted.length; i++) {
        if (adjusted[i] > minWidth) {
          const excess = adjusted[i] - minWidth;
          const reduction = (excess / shrinkableSum) * error;
          adjusted[i] = Math.max(minWidth, adjusted[i] - reduction);
        }
      }
      iterations++;
    }
    return adjusted;
  }, [segments]);

  return (
    <div className="border-t border-[var(--border-color)] px-3 py-2">
      <div className={`flex w-full overflow-hidden border border-[var(--border-color)] bg-[var(--bg-secondary)] ${tall ? "h-14" : "h-5"}`}>
        {segments.map((segment, idx) => (
          <div
            key={`${segment.startTime}-${idx}`}
            title={`${segment.label} | ${segment.startTimestamp} -> ${segment.endTimestamp} | ${fmtHours(segment.hours)} | conf ${fmtPct(segment.avgConfidence || 0)}`}
            className="h-full shrink-0"
            style={{
              width: `${adjustedWidths[idx]}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-[var(--text-muted)]">
        {Array.from(new Map(segments.map((segment) => [segment.state, segment])).values()).map((segment) => (
          <span key={segment.state} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: segment.color }} />
            {segment.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScatterPlot({ points }) {
  const xs = points.map((p) => Number(p.x)).filter(Number.isFinite);
  const ys = points.map((p) => Number(p.y)).filter(Number.isFinite);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 1;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 1;
  const scale = (v, min, max) => {
    if (!Number.isFinite(v) || max === min) return 50;
    return ((v - min) / (max - min)) * 100;
  };

  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2">
        <div className="text-[12px] font-semibold">Feature scatter: Vol 24h vs Liquidation shock</div>
        <div className="text-[10px] text-[var(--text-muted)]">This is only a 2-feature slice. Overlap here is expected if states are separated by other features or time dynamics.</div>
      </div>
      <div className="relative h-[320px]">
        <div className="absolute inset-4 border-l border-b border-[var(--border-color)]">
          {points.map((point, idx) => (
            <div
              key={`${point.time}-${idx}`}
              title={`${point.timestamp} | State ${point.state + 1} | vol=${fmtNum(point.x, 4)} | liq=${fmtNum(point.y, 3)} | conf=${fmtPct(point.confidence)}`}
              className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${scale(point.x, minX, maxX)}%`,
                bottom: `${scale(point.y, minY, maxY)}%`,
                backgroundColor: point.color,
                opacity: 0.72,
              }}
            />
          ))}
        </div>
        <div className="absolute bottom-1 left-4 text-[10px] text-[var(--text-muted)]">Vol 24h</div>
        <div className="absolute left-1 top-4 -rotate-90 text-[10px] text-[var(--text-muted)]">Liq shock</div>
      </div>
    </div>
  );
}

function PcaPlot({ data }) {
  const rawPoints = data?.points || [];
  const explained = data?.explained || [0, 0, 0];

  // 1. Sanitize and memoize points to filter out any NaNs or infinites
  const points = useMemo(() => {
    return rawPoints.filter(p => 
      p && 
      Number.isFinite(p.x) && 
      Number.isFinite(p.y) && 
      Number.isFinite(p.z || 0)
    );
  }, [rawPoints]);

  const [is3d, setIs3d] = useState(true);
  const [isSpinning, setIsSpinning] = useState(false);
  const [isPerspective, setIsPerspective] = useState(true);
  const [trajectoryMode, setTrajectoryMode] = useState("trailing"); // "none", "trailing", "full"
  const [visibleStates, setVisibleStates] = useState(new Set());
  const [currentTimeIdx, setCurrentTimeIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState(null);

  const canvasRef = useRef(null);

  // High performance refs to bypass React rendering during drag/auto-spin/zoom
  const yawRef = useRef(0.4);
  const pitchRef = useRef(0.3);
  const zoomRef = useRef(1.0); // Interactive scale factor (0.3x to 4.0x)
  const pointsRef = useRef([]);
  const is3dRef = useRef(true);
  const isPerspectiveRef = useRef(true);
  const trajectoryModeRef = useRef("trailing");
  const visibleStatesRef = useRef(new Set());
  const currentTimeIdxRef = useRef(0);
  const hoveredPointRef = useRef(null);
  const projectedPointsRef = useRef([]);
  const centroidsRef = useRef({});

  // Static optimal cluster separation factor (no slider control needed)
  const clusterSpreadVal = 1.5;

  // Setup canvas size checking to avoid buffer re-allocation on every frame
  const lastDprRef = useRef(0);

  // Initialize visible states and set timeline index to final point on load
  useEffect(() => {
    if (points.length) {
      const allStates = new Set(points.map(p => p.state));
      setVisibleStates(allStates);
      setCurrentTimeIdx(points.length - 1);
    }
  }, [points]);

  // Pre-calculate and memoize shift and scale factors for rotation centering
  const { meanX, meanY, meanZ, scaleFactor } = useMemo(() => {
    if (!points.length) return { meanX: 0, meanY: 0, meanZ: 0, scaleFactor: 1 };
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const zs = points.map(p => p.z || 0);

    const mX = xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
    const mY = ys.reduce((s, v) => s + v, 0) / (ys.length || 1);
    const mZ = zs.reduce((s, v) => s + v, 0) / (zs.length || 1);

    const maxDist = Math.max(
      ...points.map(p => {
        const dx = p.x - mX;
        const dy = p.y - mY;
        const dz = (p.z || 0) - mZ;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }),
      0.001
    );

    return {
      meanX: mX,
      meanY: mY,
      meanZ: mZ,
      scaleFactor: 140 / maxDist // Scaled up from 110 to fit 640px canvas
    };
  }, [points]);

  // Pre-calculate cluster centroids to allow centroid-based cluster spreading
  const centroids = useMemo(() => {
    if (!points.length) return {};
    const counts = {};
    const sums = {};
    points.forEach(p => {
      if (!counts[p.state]) {
        counts[p.state] = 0;
        sums[p.state] = { x: 0, y: 0, z: 0 };
      }
      counts[p.state]++;
      sums[p.state].x += p.x;
      sums[p.state].y += p.y;
      sums[p.state].z += (p.z || 0);
    });
    
    const result = {};
    Object.keys(counts).forEach(st => {
      const k = Number(st);
      result[k] = {
        x: sums[k].x / counts[k],
        y: sums[k].y / counts[k],
        z: sums[k].z / counts[k]
      };
    });
    return result;
  }, [points]);

  // 2D bounds memoization
  const bounds2d = useMemo(() => {
    if (!points.length) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    const xs2d = points.map((p) => p.x);
    const ys2d = points.map((p) => p.y);
    return {
      minX: Math.min(...xs2d),
      maxX: Math.max(...xs2d),
      minY: Math.min(...ys2d),
      maxY: Math.max(...ys2d)
    };
  }, [points]);

  // Viewport centers for 640px canvas
  const cx = 320;
  const cy = 320;
  const D = 380; // camera focal distance

  // Drag & Zoom state trackers
  const dragRef = useRef({ isDragging: false, lastX: 0, lastY: 0 });
  const touchState = useRef({
    isDragging: false,
    lastX: 0,
    lastY: 0,
    isPinching: false,
    initialDistance: 0,
    initialZoom: 1.0
  });

  const handleCanvasMouseDown = (e) => {
    dragRef.current.isDragging = true;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
  };

  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (dragRef.current.isDragging) {
      if (e.cancelable) e.preventDefault();
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      
      // Update refs directly for 60fps interaction (bypassing React re-renders)
      yawRef.current += dx * 0.008;
      pitchRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitchRef.current - dy * 0.008));
      
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;

      // Reset hover during drag to avoid React state updates and lag
      if (hoveredPointRef.current) {
        hoveredPointRef.current = null;
        setHoveredPoint(null);
      }

      requestRedraw();
      return;
    }

    // Hover detection (only when NOT dragging)
    let closestPt = null;
    let minDist = 8; // pixel threshold

    const is3dVal = is3dRef.current;
    const currentPoints = projectedPointsRef.current;

    if (is3dVal) {
      currentPoints.forEach((p) => {
        if (!visibleStatesRef.current.has(p.state)) return;
        if (trajectoryModeRef.current !== "none" && p.isFuture) return;

        const dist = Math.hypot(p.sx - mouseX, p.sy - mouseY);
        if (dist < minDist) {
          minDist = dist;
          closestPt = p;
        }
      });
    } else {
      const pad = 40;
      const w = 640 - 2 * pad;
      const h = 640 - 2 * pad;
      const rangeX = bounds2d.maxX - bounds2d.minX || 1;
      const rangeY = bounds2d.maxY - bounds2d.minY || 1;
      const midX = (bounds2d.minX + bounds2d.maxX) / 2;
      const midY = (bounds2d.minY + bounds2d.maxY) / 2;
      const zoomVal = zoomRef.current;

      points.forEach((p, idx) => {
        if (!visibleStatesRef.current.has(p.state)) return;
        const isFuture = idx > currentTimeIdxRef.current;
        if (trajectoryModeRef.current !== "none" && isFuture) return;

        const c = centroidsRef.current[p.state] || { x: midX, y: midY };
        const centroidDx = c.x - midX;
        const centroidDy = c.y - midY;
        const pointDx = p.x - c.x;
        const pointDy = p.y - c.y;

        const dx = (centroidDx * clusterSpreadVal + pointDx) * zoomVal;
        const dy = (centroidDy * clusterSpreadVal + pointDy) * zoomVal;

        const sx = cx + (dx / rangeX) * w;
        const sy = cy - (dy / rangeY) * h;

        const dist = Math.hypot(sx - mouseX, sy - mouseY);
        if (dist < minDist) {
          minDist = dist;
          closestPt = { ...p, index: idx, sx, sy };
        }
      });
    }

    // Only update state if the hovered point actually changed
    if (hoveredPointRef.current?.index !== closestPt?.index) {
      hoveredPointRef.current = closestPt;
      setHoveredPoint(closestPt);
    }
  };

  const handleCanvasMouseUp = () => {
    dragRef.current.isDragging = false;
  };

  const handleCanvasMouseLeave = () => {
    dragRef.current.isDragging = false;
    if (hoveredPointRef.current !== null) {
      hoveredPointRef.current = null;
      setHoveredPoint(null);
    }
  };

  const handleCanvasTouchStart = (e) => {
    if (e.touches.length === 1) {
      touchState.current.isDragging = true;
      touchState.current.isPinching = false;
      touchState.current.lastX = e.touches[0].clientX;
      touchState.current.lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      touchState.current.isDragging = false;
      touchState.current.isPinching = true;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchState.current.initialDistance = Math.hypot(dx, dy);
      touchState.current.initialZoom = zoomRef.current;
    }
  };

  const handleCanvasTouchMove = (e) => {
    if (touchState.current.isPinching && e.touches.length === 2) {
      if (e.cancelable) e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDistance = Math.hypot(dx, dy);
      if (touchState.current.initialDistance > 0) {
        const ratio = currentDistance / touchState.current.initialDistance;
        zoomRef.current = Math.max(0.3, Math.min(4.0, touchState.current.initialZoom * ratio));
        requestRedraw();
      }
    } else if (touchState.current.isDragging && e.touches.length === 1) {
      if (e.cancelable) e.preventDefault();
      const dx = e.touches[0].clientX - touchState.current.lastX;
      const dy = e.touches[0].clientY - touchState.current.lastY;
      
      yawRef.current += dx * 0.01;
      pitchRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitchRef.current - dy * 0.01));
      
      touchState.current.lastX = e.touches[0].clientX;
      touchState.current.lastY = e.touches[0].clientY;

      if (hoveredPointRef.current) {
        hoveredPointRef.current = null;
        setHoveredPoint(null);
      }
      
      requestRedraw();
    }
  };

  const handleCanvasTouchEnd = (e) => {
    if (e.touches.length === 0) {
      touchState.current.isDragging = false;
      touchState.current.isPinching = false;
    } else if (e.touches.length === 1) {
      touchState.current.isDragging = true;
      touchState.current.isPinching = false;
      touchState.current.lastX = e.touches[0].clientX;
      touchState.current.lastY = e.touches[0].clientY;
    }
  };

  // Imperative drawing code
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const pts = pointsRef.current;
    if (!pts.length) return;

    const is3dVal = is3dRef.current;
    const isPerspectiveVal = isPerspectiveRef.current;
    const trajectoryModeVal = trajectoryModeRef.current;
    const visibleStatesVal = visibleStatesRef.current;
    const currentTimeIdxVal = currentTimeIdxRef.current;
    const currentHoveredPoint = hoveredPointRef.current;
    const currentCentroids = centroidsRef.current || {};

    const yaw = yawRef.current;
    const pitch = pitchRef.current;
    const zoomVal = zoomRef.current;

    // Fast resolution scale (only reset bounds when devicePixelRatio changes to avoid stutters)
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = 640 * dpr;
    const targetHeight = 640 * dpr;
    if (canvas.width !== targetWidth || canvas.height !== targetHeight || lastDprRef.current !== dpr) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      lastDprRef.current = dpr;
      ctx.scale(dpr, dpr);
    }

    ctx.clearRect(0, 0, 640, 640);

    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    if (is3dVal) {
      // 1. Draw Grid wireframe circles
      ctx.strokeStyle = "rgba(100, 116, 139, 0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);

      const gridRadii = [60, 120].map(r => r * zoomVal);
      const gridPlanes = ["XY", "YZ", "XZ"];
      gridRadii.forEach(radius => {
        gridPlanes.forEach(plane => {
          ctx.beginPath();
          const steps = 32;
          for (let i = 0; i <= steps; i++) {
            const t = (2 * Math.PI * i) / steps;
            let x = 0, y = 0, z = 0;
            if (plane === "XY") {
              x = radius * Math.cos(t);
              y = radius * Math.sin(t);
            } else if (plane === "YZ") {
              y = radius * Math.cos(t);
              z = radius * Math.sin(t);
            } else if (plane === "XZ") {
              x = radius * Math.cos(t);
              z = radius * Math.sin(t);
            }
            
            const x1 = x * cosY - z * sinY;
            const z1 = x * sinY + z * cosY;
            const y2 = y * cosP - z1 * sinP;
            const z2 = y * sinP + z1 * cosP;
            
            const factor = isPerspectiveVal ? D / Math.max(30, D + z2) : 1;
            const sx = cx + x1 * factor;
            const sy = cy - y2 * factor;

            if (i === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        });
      });
      ctx.setLineDash([]);

      // 2. Draw axes
      const axes = [
        { x: 150, y: 0, z: 0, label: "PC1 (x)", color: "#f87171" },
        { x: 0, y: 130, z: 0, label: "PC2 (y)", color: "#4ade80" },
        { x: 0, y: 0, z: 130, label: "PC3 (z)", color: "#60a5fa" }
      ];
      axes.forEach(axis => {
        const ax = axis.x * zoomVal;
        const ay = axis.y * zoomVal;
        const az = axis.z * zoomVal;

        const x1 = ax * cosY - az * sinY;
        const z1 = ax * sinY + az * cosY;
        const y2 = ay * cosP - z1 * sinP;
        const z2 = ay * sinP + az * cosP;

        const factor = isPerspectiveVal ? D / Math.max(30, D + z2) : 1;
        const sx = cx + x1 * factor;
        const sy = cy - y2 * factor;

        ctx.strokeStyle = axis.color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = 0.85;
        ctx.fillText(axis.label, sx, sy);
      });

      // 3. Project points dynamically with centroid spreading and zoom scaling
      const projected = pts.map((p, idx) => {
        // Find cluster centroid and vector offsets
        const c = currentCentroids[p.state] || { x: meanX, y: meanY, z: meanZ };
        const centroidDx = c.x - meanX;
        const centroidDy = c.y - meanY;
        const centroidDz = c.z - meanZ;

        const pointDx = p.x - c.x;
        const pointDy = p.y - c.y;
        const pointDz = (p.z || 0) - c.z;

        // Apply cluster spacing spreading + within-cluster offset
        const dx = centroidDx * clusterSpreadVal + pointDx;
        const dy = centroidDy * clusterSpreadVal + pointDy;
        const dz = centroidDz * clusterSpreadVal + pointDz;

        // Apply scaling factor and interactive zoom
        const rx = dx * scaleFactor * zoomVal;
        const ry = dy * scaleFactor * zoomVal;
        const rz = dz * scaleFactor * zoomVal;

        const x1 = rx * cosY - rz * sinY;
        const z1 = rx * sinY + rz * cosY;
        const y2 = ry * cosP - z1 * sinP;
        const z2 = ry * sinP + z1 * cosP;

        const factor = isPerspectiveVal ? D / Math.max(30, D + z2) : 1;
        const sx = cx + x1 * factor;
        const sy = cy - y2 * factor;

        const isFuture = idx > currentTimeIdxVal;
        const tailLength = 40;
        const isWithinTail = idx <= currentTimeIdxVal && idx >= currentTimeIdxVal - tailLength;
        const tailProgress = isWithinTail ? (idx - (currentTimeIdxVal - tailLength)) / tailLength : 0;

        return {
          ...p,
          index: idx,
          rotZ: z2,
          sx,
          sy,
          isFuture,
          isWithinTail,
          tailProgress,
          isCurrent: idx === currentTimeIdxVal
        };
      });

      // Update projectedPointsRef for mousemove hover detection
      projectedPointsRef.current = projected;

      // 4. Build elements list
      const renderElements = [];

      // Push points
      projected.forEach((p) => {
        if (!visibleStatesVal.has(p.state)) return;
        if (trajectoryModeVal !== "none" && p.isFuture) return;

        renderElements.push({
          type: "point",
          depth: p.rotZ,
          p
        });
      });

      // Push trajectory line segments
      if (trajectoryModeVal !== "none") {
        const startIdx = trajectoryModeVal === "trailing" ? Math.max(0, currentTimeIdxVal - 45) : 0;
        const endIdx = currentTimeIdxVal;
        
        for (let i = startIdx; i < endIdx; i++) {
          const p1 = projected[i];
          const p2 = projected[i+1];

          if (!visibleStatesVal.has(p1.state) || !visibleStatesVal.has(p2.state)) continue;

          const depth = (p1.rotZ + p2.rotZ) / 2;
          
          let opacity = 0.45;
          if (trajectoryModeVal === "trailing") {
            const age = endIdx - i;
            opacity = Math.max(0.04, 0.6 * (1 - age / 45));
          }

          renderElements.push({
            type: "line",
            depth,
            p1,
            p2,
            opacity,
            color: p2.color
          });
        }
      }

      // Depth sort (Painter's algorithm)
      renderElements.sort((a, b) => b.depth - a.depth);

      // Render elements
      renderElements.forEach((el) => {
        if (el.type === "line") {
          ctx.strokeStyle = el.color;
          ctx.lineWidth = 2.2;
          ctx.globalAlpha = el.opacity;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(el.p1.sx, el.p1.sy);
          ctx.lineTo(el.p2.sx, el.p2.sy);
          ctx.stroke();
        } else if (el.type === "point") {
          const p = el.p;
          const isHovered = currentHoveredPoint?.index === p.index;
          
          let opacity = 0.75;
          if (currentHoveredPoint && !isHovered) {
            opacity = 0.18;
          } else if (p.isFuture) {
            opacity = 0.15;
          }

          const baseSize = 3.5;
          const sizeFactor = isPerspectiveVal ? D / Math.max(30, D + p.rotZ) : 1;
          const size = Math.max(1.8, baseSize * sizeFactor * (isHovered ? 2.5 : 1));

          if (p.isCurrent) {
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, size * 3, 0, 2 * Math.PI);
            ctx.stroke();
          }

          ctx.fillStyle = p.color;
          ctx.globalAlpha = opacity;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, size, 0, 2 * Math.PI);
          ctx.fill();

          if (isHovered) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 1.0;
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, size, 0, 2 * Math.PI);
            ctx.stroke();
          }
        }
      });
      ctx.globalAlpha = 1.0;
    } else {
      // 2D VIEWPORT DRAWING WITH SPREAD & ZOOM
      const pad = 40;
      const w = 640 - 2 * pad;
      const h = 640 - 2 * pad;
      const rangeX = bounds2d.maxX - bounds2d.minX || 1;
      const rangeY = bounds2d.maxY - bounds2d.minY || 1;
      const midX = (bounds2d.minX + bounds2d.maxX) / 2;
      const midY = (bounds2d.minY + bounds2d.maxY) / 2;

      // Draw Grid / Borders
      ctx.strokeStyle = "rgba(100, 116, 139, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, pad);
      ctx.lineTo(pad, 640 - pad);
      ctx.lineTo(640 - pad, 640 - pad);
      ctx.stroke();

      // Axis labels
      ctx.fillStyle = "#64748b";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "left";
      ctx.fillText("PC1", 640 - pad + 8, 640 - pad);
      ctx.fillText("PC2", pad, pad - 12);

      // Trajectory connection line
      if (trajectoryModeVal !== "none") {
        ctx.strokeStyle = "rgba(100, 116, 139, 0.2)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        let first = true;

        pts.forEach((p, idx) => {
          if (!visibleStatesVal.has(p.state)) return;
          const isFuture = idx > currentTimeIdxVal;
          if (isFuture) return;

          const c = currentCentroids[p.state] || { x: midX, y: midY };
          const centroidDx = c.x - midX;
          const centroidDy = c.y - midY;
          const pointDx = p.x - c.x;
          const pointDy = p.y - c.y;

          const dx = (centroidDx * clusterSpreadVal + pointDx) * zoomVal;
          const dy = (centroidDy * clusterSpreadVal + pointDy) * zoomVal;

          const sx = cx + (dx / rangeX) * w;
          const sy = cy - (dy / rangeY) * h;

          if (first) {
            ctx.moveTo(sx, sy);
            first = false;
          } else {
            ctx.lineTo(sx, sy);
          }
        });
        ctx.stroke();
      }

      // Draw points
      pts.forEach((p, idx) => {
        if (!visibleStatesVal.has(p.state)) return;
        const isFuture = idx > currentTimeIdxVal;
        if (trajectoryModeVal !== "none" && isFuture) return;

        const c = currentCentroids[p.state] || { x: midX, y: midY };
        const centroidDx = c.x - midX;
        const centroidDy = c.y - midY;
        const pointDx = p.x - c.x;
        const pointDy = p.y - c.y;

        const dx = (centroidDx * clusterSpreadVal + pointDx) * zoomVal;
        const dy = (centroidDy * clusterSpreadVal + pointDy) * zoomVal;

        const sx = cx + (dx / rangeX) * w;
        const sy = cy - (dy / rangeY) * h;

        const isHovered = currentHoveredPoint?.index === idx;
        let opacity = 0.75;
        if (currentHoveredPoint && !isHovered) {
          opacity = 0.18;
        }

        if (idx === currentTimeIdxVal) {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.arc(sx, sy, 8, 0, 2 * Math.PI);
          ctx.stroke();
        }

        ctx.fillStyle = p.color;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.arc(sx, sy, isHovered ? 6 : 3.5, 0, 2 * Math.PI);
        ctx.fill();

        if (isHovered) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 1.0;
          ctx.beginPath();
          ctx.arc(sx, sy, 6, 0, 2 * Math.PI);
          ctx.stroke();
        }
      });
      ctx.globalAlpha = 1.0;
    }
  };

  // Keep drawRef updated with the latest draw function on every render
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });

  // Setup stable requestRedraw function
  const redrawPending = useRef(false);
  const requestRedraw = useCallback(() => {
    if (redrawPending.current) return;
    redrawPending.current = true;
    requestAnimationFrame(() => {
      redrawPending.current = false;
      if (drawRef.current) {
        drawRef.current();
      }
    });
  }, []);

  // Sync state values to refs on every render and trigger draw
  useEffect(() => {
    pointsRef.current = points;
    is3dRef.current = is3d;
    isPerspectiveRef.current = isPerspective;
    trajectoryModeRef.current = trajectoryMode;
    visibleStatesRef.current = visibleStates;
    currentTimeIdxRef.current = currentTimeIdx;
    hoveredPointRef.current = hoveredPoint;
    centroidsRef.current = centroids;
    requestRedraw();
  }, [points, is3d, isPerspective, trajectoryMode, visibleStates, currentTimeIdx, hoveredPoint, centroids, requestRedraw]);

  // Imperative scroll-wheel zoom handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e) => {
      e.preventDefault();
      const zoomDelta = e.deltaY * -0.0015;
      zoomRef.current = Math.max(0.3, Math.min(4.0, zoomRef.current + zoomDelta));
      requestRedraw();
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [requestRedraw]);

  // Request animation frame for auto-rotation
  useEffect(() => {
    if (!isSpinning) return;
    let animId;
    const tick = () => {
      yawRef.current += 0.005;
      requestRedraw();
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [isSpinning, requestRedraw]);

  // Playback timer for trajectory
  useEffect(() => {
    if (!isPlaying) return;
    let timer;
    const step = () => {
      setCurrentTimeIdx((prev) => {
        if (prev >= points.length - 1) {
          setIsPlaying(false);
          return points.length - 1;
        }
        return prev + 1;
      });
    };
    timer = setInterval(step, 60);
    return () => clearInterval(timer);
  }, [isPlaying, points.length]);

  // Toggle state helper vis
  const toggleStateVisibility = (stateIdx) => {
    setVisibleStates((prev) => {
      const next = new Set(prev);
      if (next.has(stateIdx)) {
        if (next.size > 1) next.delete(stateIdx);
      } else {
        next.add(stateIdx);
      }
      return next;
    });
  };

  // Unique state list (Memoized for performance)
  const uniqueStates = useMemo(() => {
    return Array.from(new Set(points.map(p => p.state)))
      .map(st => {
        const match = points.find(p => p.state === st);
        return {
          state: st,
          color: match?.color || "#fff",
          label: `State ${st + 1}`
        };
      })
      .sort((a, b) => a.state - b.state);
  }, [points]);

  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      {/* Header bar */}
      <div className="border-b border-[var(--border-color)] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-[var(--text-main)] flex items-center gap-2">
            <Compass className="h-4 w-4 text-[var(--text-muted)]" />
            <span>Interactive PCA Space Explorer</span>
          </div>
          <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
            PC1 {fmtPct(explained[0] || 0)} | PC2 {fmtPct(explained[1] || 0)} | PC3 {fmtPct(explained[2] || 0)} variance. Drag to orbit. Scroll wheel / pinch to Zoom.
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <button
            type="button"
            onClick={() => setIs3d(!is3d)}
            className={`px-2.5 py-1 font-semibold border ${
              is3d ? "bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-main)]" : "bg-transparent border-dashed text-[var(--text-muted)]"
            } cursor-pointer`}
          >
            {is3d ? "3D Orbit Space" : "2D Grid View"}
          </button>

          {is3d && (
            <>
              <button
                type="button"
                onClick={() => setIsSpinning(!isSpinning)}
                className={`px-2.5 py-1 font-semibold border flex items-center gap-1 ${
                  isSpinning ? "bg-emerald-950/40 border-emerald-500/50 text-emerald-400" : "bg-transparent border-dashed text-[var(--text-muted)]"
                } cursor-pointer`}
              >
                <RefreshCcw className={`h-3 w-3 ${isSpinning ? "animate-spin" : ""}`} />
                <span>Auto Spin</span>
              </button>

              <button
                type="button"
                onClick={() => setIsPerspective(!isPerspective)}
                className="px-2.5 py-1 font-semibold border border-dashed text-[var(--text-muted)] bg-transparent hover:bg-[var(--bg-secondary)] cursor-pointer"
              >
                {isPerspective ? "Perspective" : "Orthographic"}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => { 
              yawRef.current = 0.4; 
              pitchRef.current = 0.3; 
              zoomRef.current = 1.0; 
              requestRedraw(); 
            }}
            className="px-2 py-1 font-semibold border border-dashed text-[var(--text-muted)] bg-transparent hover:bg-[var(--bg-secondary)] cursor-pointer"
          >
            Reset view
          </button>
        </div>
      </div>

      <div className="flex flex-col border-b border-[var(--border-color)]/70">
        {/* Render Viewport - Stacked, Large centered viewport (640px dimension) */}
        <div 
          className="relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900/10 via-[var(--bg-main)] to-[var(--bg-main)] min-h-[680px] flex items-center justify-center p-6 select-none border-b border-[var(--border-color)]/50"
          style={{ touchAction: "none" }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: "640px", height: "640px", touchAction: "none" }}
            className="cursor-grab active:cursor-grabbing border border-[var(--border-color)]/30 rounded-lg bg-[var(--bg-main)]/40 shadow-inner"
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseLeave}
            onTouchStart={handleCanvasTouchStart}
            onTouchMove={handleCanvasTouchMove}
            onTouchEnd={handleCanvasTouchEnd}
          />

          {/* 3D HUD OVERLAY */}
          <div className="absolute top-4 right-4 bg-[var(--bg-main)]/95 backdrop-blur-md border border-[var(--border-color)] px-3 py-2 text-[9px] space-y-1.5 min-w-[170px] pointer-events-none rounded shadow-lg font-mono">
            <div className="text-[10px] font-bold text-[var(--text-main)] border-b border-[var(--border-color)]/70 pb-1 flex items-center justify-between">
              <span>TELEMETRY HUD</span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </div>
            {hoveredPoint ? (
              <>
                <div className="text-emerald-400 font-semibold">{hoveredPoint.timestamp}</div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">State:</span>
                  <span style={{ color: hoveredPoint.color }} className="font-bold">S{hoveredPoint.state + 1}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">PC1 (x):</span>
                  <span>{fmtNum(hoveredPoint.x, 3)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">PC2 (y):</span>
                  <span>{fmtNum(hoveredPoint.y, 3)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">PC3 (z):</span>
                  <span>{fmtNum(hoveredPoint.z || 0, 3)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Confidence:</span>
                  <span className="font-bold text-[var(--text-main)]">{fmtPct(hoveredPoint.confidence)}</span>
                </div>
              </>
            ) : (
              <div className="text-[var(--text-muted)] py-2 italic text-center">
                Hover points to inspect.
              </div>
            )}
            <div className="border-t border-[var(--border-color)]/40 pt-1 flex justify-between text-[8px] text-[var(--text-muted)]">
              <span>Zoom Scale:</span>
              <span className="font-bold text-[var(--text-main)]">{Math.round(zoomRef.current * 100)}%</span>
            </div>
          </div>
        </div>

        {/* Telemetry controls placed BELOW the viewport */}
        <div className="px-5 py-5 grid md:grid-cols-2 gap-6 bg-[var(--bg-main)]">
          
          {/* Regime Filters (Left Column) */}
          <div className="space-y-4">
            <div>
              <h4 className="text-[11px] font-semibold text-[var(--text-main)] uppercase tracking-wider">Regime Filters (Bộ Lọc Trạng Thái)</h4>
              <p className="text-[10px] text-[var(--text-muted)]">
                Tắt/bật từng trạng thái để phân tách cấu trúc hình học của cụm.
              </p>
              <div className="flex flex-wrap gap-2 pt-2">
                {uniqueStates.map((s) => (
                  <button
                    key={s.state}
                    type="button"
                    onClick={() => toggleStateVisibility(s.state)}
                    className={`flex items-center gap-2 border px-2.5 py-1 text-[10px] font-semibold cursor-pointer transition-all ${
                      visibleStates.has(s.state)
                        ? "bg-[var(--bg-secondary)] text-[var(--text-main)]"
                        : "bg-transparent text-[var(--text-muted)] border-dashed border-slate-700/60"
                    }`}
                    style={{ borderColor: visibleStates.has(s.state) ? s.color : "var(--border-color)" }}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: visibleStates.has(s.state) ? s.color : "#64748b" }} />
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Time Trajectory Tracing Controls (Right Column) */}
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h4 className="text-[11px] font-semibold text-[var(--text-main)] uppercase tracking-wider">Trajectory Trace (Dải Dẫn Thời Gian)</h4>
              
              <div className="flex border border-[var(--border-color)] bg-[var(--bg-main)] p-0.5 rounded text-[9px] font-bold">
                {["none", "trailing", "full"].map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTrajectoryMode(m)}
                    className={`px-2 py-0.5 rounded uppercase cursor-pointer ${
                      trajectoryMode === m ? "bg-[var(--bg-secondary)] text-[var(--text-main)]" : "text-[var(--text-muted)] bg-transparent"
                    }`}
                  >
                    {m === "none" ? "Scatter" : m === "trailing" ? "Tail" : "Full"}
                  </button>
                ))}
              </div>
            </div>
            
            <p className="text-[10px] text-[var(--text-muted)]">
              Kết nối các điểm nến sequential theo dòng thời gian để biểu diễn quỹ đạo chuyển dịch trạng thái thị trường.
            </p>

            <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] px-3 py-2.5 space-y-2.5 rounded">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setIsPlaying(!isPlaying)}
                    className="p-1 border border-[var(--border-color)] bg-[var(--bg-main)] hover:bg-[var(--bg-secondary)] cursor-pointer text-[var(--text-main)] flex items-center justify-center rounded"
                    title={isPlaying ? "Pause autoplay" : "Play trajectory trace"}
                  >
                    {isPlaying ? (
                      <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    ) : (
                      <Play className="h-3.5 w-3.5 fill-current" />
                    )}
                  </button>
                  <span className="text-[10px] font-bold text-[var(--text-main)]">
                    {isPlaying ? "Trajectory flowing..." : "Trace playback"}
                  </span>
                </div>
                <span className="text-[9px] font-mono text-[var(--text-muted)]">
                  Index: {currentTimeIdx} / {points.length - 1}
                </span>
              </div>

              <input
                type="range"
                min="0"
                max={points.length - 1}
                value={currentTimeIdx}
                onChange={(e) => {
                  setCurrentTimeIdx(Number(e.target.value));
                  setIsPlaying(false);
                }}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />

              <div className="text-[10px] font-mono text-center text-emerald-400 bg-[var(--bg-main)]/50 py-1 border border-[var(--border-color)]/40 rounded">
                Current Time: {projectedPointsRef.current[currentTimeIdx]?.timestamp || "N/A"}
              </div>
            </div>
          </div>

        </div>

        {/* Tip section taking full width at the very bottom */}
        <div className="px-5 py-3 text-[10px] text-[var(--text-muted)] border-t border-[var(--border-color)]/50 flex items-start gap-1.5 bg-slate-900/10">
          <span className="text-emerald-400 font-bold">💡 Tip:</span>
          <span>
            Kéo chuột để xoay tự do. <b>Cuộn chuột (hoặc dùng 2 ngón tay) để Phóng to/Thu nhỏ</b>. Các cụm dữ liệu tự động được phân tách khoảng cách tối ưu để dễ dàng quan sát.
          </span>
        </div>

      </div>
    </div>
  );
}


function QualityPanel({ diagnostics, meta }) {
  const q = diagnostics?.quality || {};
  const chosenK = meta?.chosenK;
  const silhouette = meta?.candidateKs?.find((row) => row.k === chosenK)?.silhouette;
  const lowConfidenceShare = Number(q.lowConfidenceShare || 0);
  const minDistance = Number(q.minNearestCenterDistance || 0);
  const warnings = [];
  if (Number.isFinite(silhouette) && silhouette < 0.25) warnings.push("Chosen K has weak geometric separation.");
  if (lowConfidenceShare > 0.1) warnings.push("Many candles have low posterior confidence.");
  if (minDistance < 1) warnings.push("At least two state centers are close in standardized feature space.");
  if (!warnings.length) warnings.push("No major quality warning from these diagnostics.");

  return (
    <div className="grid gap-3 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3">
        <div className="text-[12px] font-semibold">Model quality quick read</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <SmallMetric label="Silhouette" value={fmtNum(silhouette, 3)} />
          <SmallMetric label="Avg conf" value={fmtPct(q.avgConfidence || 0)} />
          <SmallMetric label="Low conf" value={fmtPct(lowConfidenceShare)} />
        </div>
      </div>
      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3">
        <div className="text-[12px] font-semibold">Read this before trusting colors</div>
        <div className="mt-2 space-y-1 text-[11px] text-[var(--text-muted)]">
          {warnings.map((warning) => (
            <div key={warning}>- {warning}</div>
          ))}
          <div>- If PCA and raw scatter both overlap heavily, K may be too high or features are not discriminative enough.</div>
        </div>
      </div>
    </div>
  );
}

function ProjectionExplanation({ featureCount }) {
  const count = featureCount || 16;
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3">
        <div className="text-[12px] font-semibold">Why colors can overlap</div>
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">
          The model assigns states from a {count}D standardized vector plus HMM transition probabilities. A 2D chart can put different high-dimensional points on top of each other.
        </div>
      </div>
      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3">
        <div className="text-[12px] font-semibold">What a long state means</div>
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">
          A long segment means the environment features stayed closer to one hidden state. It does not mean price must be flat or trend in one direction.
        </div>
      </div>
      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3">
        <div className="text-[12px] font-semibold">When to distrust K</div>
        <div className="mt-1 text-[11px] text-[var(--text-muted)]">
          If Silhouette is low, PCA overlaps heavily, and state-center distances are small, the chosen K is probably too granular for the current features.
        </div>
      </div>
    </div>
  );
}

function StateDistanceMatrix({ diagnostics, states }) {
  const distances = diagnostics?.stateDistances?.distances || [];
  const max = Math.max(...distances.flat().map((v) => Number(v || 0)), 1);
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2">
        <div className="text-[12px] font-semibold">State center distance</div>
        <div className="text-[10px] text-[var(--text-muted)]">Euclidean distance between state centers in standardized feature space. Low values mean overlap risk.</div>
      </div>
      <div className="overflow-auto thin-scrollbar px-3 py-3">
        <table className="min-w-[520px] w-full text-[11px]">
          <thead>
            <tr className="text-left text-[var(--text-muted)]">
              <th className="py-2">State</th>
              {states.map((state) => (
                <th key={state.state} className="py-2 text-right">{state.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {distances.map((row, i) => (
              <tr key={i} className="border-t border-[var(--border-color)]/70">
                <td className="py-2 font-semibold">State {i + 1}</td>
                {row.map((value, j) => (
                  <td
                    key={j}
                    className="py-2 text-right tabular-nums"
                    style={{
                      background: i === j
                        ? "var(--bg-secondary)"
                        : `color-mix(in oklab, ${states[j]?.color || "#2563eb"} ${Math.round((Number(value || 0) / max) * 30)}%, white)`,
                    }}
                  >
                    {i === j ? "-" : fmtNum(value, 2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiagnosticBars({ rows, field, label, percent = false }) {
  const vals = rows.map((row) => Number(row[field] || 0));
  const max = vals.length ? Math.max(...vals, 1e-9) : 1;
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-semibold">{label}</div>
      <div className="space-y-2 px-3 py-3">
        {rows.map((row) => {
          const value = Number(row[field] || 0);
          return (
            <div key={row.k} className="grid grid-cols-[34px_1fr_64px] items-center gap-2 text-[11px]">
              <div className="font-semibold">K{row.k}</div>
              <div className="h-2 bg-[var(--bg-secondary)]">
                <div className="h-full bg-[var(--color-accent)]" style={{ width: `${Math.max(1, (value / max) * 100)}%` }} />
              </div>
              <div className="text-right tabular-nums">{percent ? fmtPct(value) : fmtNum(value, 3)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KDecisionPanel({ meta, onSelectK }) {
  const selection = meta?.kSelection || {};
  const rows = meta?.candidateKs || [];
  const chosen = Number(meta?.chosenK || 0);
  const chosenRow = rows.find((row) => row.k === chosen);
  const elbowRow = rows.find((row) => row.k === selection.chosenByElbow);
  const silhouetteRow = rows.find((row) => row.k === selection.chosenBySilhouette);
  const aicRow = rows.find((row) => row.k === selection.chosenByAIC);
  const bicRow = rows.find((row) => row.k === selection.chosenByBIC);
  const interpretabilityRow = rows.find((row) => row.k === selection.chosenByInterpretability);

  return (
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      <DecisionCard
        title="Fit K"
        value={`K=${chosen || "N/A"}`}
        helper={`${selection.method || "auto"} mode | HMM states used`}
        tone="primary"
      />
      <DecisionCard
        title="Best separation"
        value={`K=${silhouetteRow?.k ?? "N/A"}`}
        helper={`Silhouette ${fmtNum(silhouetteRow?.silhouette, 3)}`}
        onClick={silhouetteRow?.k && onSelectK ? () => onSelectK(silhouetteRow.k) : null}
      />
      <DecisionCard
        title="Largest elbow"
        value={`K=${elbowRow?.k ?? "N/A"}`}
        helper={`Drop ${fmtPct(elbowRow?.elbowDrop || 0)}`}
        onClick={elbowRow?.k && onSelectK ? () => onSelectK(elbowRow.k) : null}
      />
      <DecisionCard
        title="BIC Minimizer"
        value={`K=${bicRow?.k ?? "N/A"}`}
        helper={`BIC ${fmtNum(bicRow?.bic, 0)}`}
        onClick={bicRow?.k && onSelectK ? () => onSelectK(bicRow.k) : null}
      />
      <DecisionCard
        title="AIC Minimizer"
        value={`K=${aicRow?.k ?? "N/A"}`}
        helper={`AIC ${fmtNum(aicRow?.aic, 0)}`}
        onClick={aicRow?.k && onSelectK ? () => onSelectK(aicRow.k) : null}
      />
      <DecisionCard
        title="Interpretability"
        value={`K=${interpretabilityRow?.k ?? "N/A"}`}
        helper={`Score ${fmtPct(interpretabilityRow?.interpretability || 0)}`}
        onClick={interpretabilityRow?.k && onSelectK ? () => onSelectK(interpretabilityRow.k) : null}
      />
    </div>
  );
}

function DecisionCard({ title, value, helper, tone, onClick }) {
  const isClickable = !!onClick;
  return (
    <div
      onClick={onClick || undefined}
      className={`border px-4 py-3 transition-all ${
        isClickable ? "cursor-pointer hover:border-[var(--color-accent)] hover:shadow-sm" : ""
      } ${
        tone === "primary"
          ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_9%,white)]"
          : "border-[var(--border-color)] bg-[var(--bg-main)]"
      }`}
    >
      <div className="text-[10px] uppercase text-[var(--text-muted)] flex justify-between items-center">
        <span>{title}</span>
        {isClickable && <span className="text-[9px] text-[var(--color-accent)] opacity-80">Apply K</span>}
      </div>
      <div className="mt-1 text-[20px] font-semibold">{value}</div>
      <div className="mt-1 text-[11px] text-[var(--text-muted)]">{helper}</div>
    </div>
  );
}

function FeatureHeatmap({ states, featureStats }) {
  const features = Object.keys(featureLabels).filter((feature) => states.some((state) => Number.isFinite(Number(state.averages?.[feature]))));
  const zValue = (state, feature) => {
    const avg = Number(state.averages?.[feature] || 0);
    const stat = featureStats?.[feature] || {};
    const m = Number(stat.mean || 0);
    const s = Number(stat.std || 1) || 1;
    return (avg - m) / s;
  };
  const colorFor = (z) => {
    const clipped = Math.max(-2.5, Math.min(2.5, z));
    if (clipped >= 0) {
      const alpha = 8 + Math.round((clipped / 2.5) * 34);
      return `color-mix(in oklab, #dc2626 ${alpha}%, white)`;
    }
    const alpha = 8 + Math.round((Math.abs(clipped) / 2.5) * 34);
    return `color-mix(in oklab, #2563eb ${alpha}%, white)`;
  };

  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2">
        <div className="text-[12px] font-semibold">State feature heatmap</div>
        <div className="text-[10px] text-[var(--text-muted)]">Each cell is z-score vs full dataset. Red means above average, blue means below average.</div>
      </div>
      <div className="overflow-auto thin-scrollbar">
        <table className="min-w-[980px] w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
              <th className="px-3 py-2">Feature</th>
              {states.map((state) => (
                <th key={state.state} className="px-3 py-2 text-right">
                  <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: state.color }} />
                  {state.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {features.map((feature) => (
              <tr key={feature} className="border-b border-[var(--border-color)]/70">
                <td className="px-3 py-2 font-semibold">{featureLabels[feature] || feature}</td>
                {states.map((state) => {
                  const z = zValue(state, feature);
                  return (
                    <td key={state.state} className="px-3 py-2 text-right tabular-nums" style={{ background: colorFor(z) }}>
                      {fmtNum(z, 2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TransitionHeatmap({ transitions, states }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2">
        <div className="text-[12px] font-semibold">Transition heatmap</div>
        <div className="text-[10px] text-[var(--text-muted)]">High diagonal means state persistence. Off-diagonal means regime switching pressure.</div>
      </div>
      <div className="overflow-auto thin-scrollbar px-3 py-3">
        <table className="min-w-[520px] w-full text-[11px]">
          <thead>
            <tr className="text-left text-[var(--text-muted)]">
              <th className="py-2">From / To</th>
              {states.map((state) => (
                <th key={state.state} className="py-2 text-right">{state.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {transitions.map((row, i) => (
              <tr key={i} className="border-t border-[var(--border-color)]/70">
                <td className="py-2 font-semibold">State {i + 1}</td>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="py-2 text-right tabular-nums"
                    style={{ background: `color-mix(in oklab, ${cell.color} ${Math.round((cell.p || 0) * 38)}%, white)` }}
                  >
                    {fmtPct(cell.p || 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfidenceHistogram({ timeline, states }) {
  const bins = [
    { label: "<60", min: 0, max: 0.6 },
    { label: "60-75", min: 0.6, max: 0.75 },
    { label: "75-90", min: 0.75, max: 0.9 },
    { label: "90-97", min: 0.9, max: 0.97 },
    { label: ">97", min: 0.97, max: 1.01 },
  ].map((bin) => ({
    ...bin,
    count: timeline.filter((row) => row.confidence >= bin.min && row.confidence < bin.max).length,
  }));
  const max = Math.max(...bins.map((bin) => bin.count), 1);
  const avg = meanLocal(timeline.map((row) => Number(row.confidence || 0)));
  const low = timeline.filter((row) => Number(row.confidence || 0) < 0.75).length;

  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2">
        <div className="text-[12px] font-semibold">Posterior confidence</div>
        <div className="text-[10px] text-[var(--text-muted)]">Avg {fmtPct(avg)} | low confidence bars {fmtInt(low)} / {fmtInt(timeline.length)}</div>
      </div>
      <div className="space-y-2 px-3 py-3">
        {bins.map((bin) => (
          <div key={bin.label} className="grid grid-cols-[44px_1fr_54px] items-center gap-2 text-[11px]">
            <div className="font-semibold">{bin.label}</div>
            <div className="h-2 bg-[var(--bg-secondary)]">
              <div className="h-full bg-slate-500" style={{ width: `${Math.max(1, (bin.count / max) * 100)}%` }} />
            </div>
            <div className="text-right tabular-nums">{fmtInt(bin.count)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DurationProfile({ durationStats }) {
  const max = Math.max(...durationStats.map((row) => Number(row.totalHours || 0)), 1);
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2">
        <div className="text-[12px] font-semibold">Dwell-time profile</div>
        <div className="text-[10px] text-[var(--text-muted)]">How long each hidden state tends to persist.</div>
      </div>
      <div className="space-y-3 px-3 py-3">
        {durationStats.map((row) => (
          <div key={row.state} className="space-y-1 text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold" style={{ color: row.color }}>{row.label}</div>
              <div className="text-[var(--text-muted)]">runs {fmtInt(row.runs)} | med {fmtHours(row.medianHours)} | max {fmtHours(row.maxHours)}</div>
            </div>
            <div className="h-2 bg-[var(--bg-secondary)]">
              <div className="h-full" style={{ width: `${Math.max(1, (row.totalHours / max) * 100)}%`, backgroundColor: row.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function meanLocal(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function RadarChart({ cx = 160, cy = 160, r = 100, axes, data, color, filled = true }) {
  const N = axes.length;
  const points = axes.map((axis, i) => {
    const angle = (2 * Math.PI * i) / N - Math.PI / 2;
    const val = data[axis.key] ?? 50;
    const dist = (val / 100) * r;
    const x = cx + dist * Math.cos(angle);
    const y = cy + dist * Math.sin(angle);
    return { x, y };
  });
  
  const pointsStr = points.map(p => `${p.x},${p.y}`).join(" ");
  const gridLevels = [25, 50, 75, 100];
  
  return (
    <svg className="w-full h-full min-h-[160px]" viewBox="0 0 320 320">
      {gridLevels.map((level) => {
        const levelPoints = axes.map((_, i) => {
          const angle = (2 * Math.PI * i) / N - Math.PI / 2;
          const dist = (level / 100) * r;
          const x = cx + dist * Math.cos(angle);
          const y = cy + dist * Math.sin(angle);
          return `${x},${y}`;
        }).join(" ");
        return (
          <polygon
            key={level}
            points={levelPoints}
            fill="none"
            stroke="var(--border-color)"
            strokeWidth="1.5"
            strokeDasharray={level === 100 ? "none" : "3,3"}
          />
        );
      })}
      
      {axes.map((axis, i) => {
        const angle = (2 * Math.PI * i) / N - Math.PI / 2;
        const outerX = cx + r * Math.cos(angle);
        const outerY = cy + r * Math.sin(angle);
        return (
          <line
            key={axis.key}
            x1={cx}
            y1={cy}
            x2={outerX}
            y2={outerY}
            stroke="var(--border-color)"
            strokeWidth="1.5"
          />
        );
      })}
      
      <polygon
        points={pointsStr}
        fill={filled ? `color-mix(in oklab, ${color} 20%, transparent)` : "none"}
        stroke={color}
        strokeWidth="3"
      />
      
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="4.5"
          fill="var(--bg-main)"
          stroke={color}
          strokeWidth="3"
        />
      ))}
      
      {axes.map((axis, i) => {
        const angle = (2 * Math.PI * i) / N - Math.PI / 2;
        const labelDist = r + 24;
        const lx = cx + labelDist * Math.cos(angle);
        const ly = cy + labelDist * Math.sin(angle);
        
        let textAnchor = "middle";
        if (Math.cos(angle) > 0.1) textAnchor = "start";
        else if (Math.cos(angle) < -0.1) textAnchor = "end";
        
        let dy = "0.33em";
        if (Math.sin(angle) < -0.9) dy = "-0.3em";
        else if (Math.sin(angle) > 0.9) dy = "0.9em";
        
        return (
          <text
            key={axis.key}
            x={lx}
            y={ly}
            textAnchor={textAnchor}
            dy={dy}
            className="text-[12px] font-semibold fill-[var(--text-muted)]"
          >
            {axis.label}
          </text>
        );
      })}
    </svg>
  );
}

function OverlaidRadarChart({ cx = 170, cy = 170, r = 110, axes, statesData, activeStates }) {
  const N = axes.length;
  const gridLevels = [25, 50, 75, 100];
  
  return (
    <svg className="w-full h-full min-h-[300px] max-w-[340px]" viewBox="0 0 340 340">
      {gridLevels.map((level) => {
        const levelPoints = axes.map((_, i) => {
          const angle = (2 * Math.PI * i) / N - Math.PI / 2;
          const dist = (level / 100) * r;
          const x = cx + dist * Math.cos(angle);
          const y = cy + dist * Math.sin(angle);
          return `${x},${y}`;
        }).join(" ");
        return (
          <polygon
            key={level}
            points={levelPoints}
            fill="none"
            stroke="var(--border-color)"
            strokeWidth="1.5"
            strokeDasharray={level === 100 ? "none" : "3,3"}
          />
        );
      })}
      
      {axes.map((axis, i) => {
        const angle = (2 * Math.PI * i) / N - Math.PI / 2;
        const outerX = cx + r * Math.cos(angle);
        const outerY = cy + r * Math.sin(angle);
        return (
          <line
            key={axis.key}
            x1={cx}
            y1={cy}
            x2={outerX}
            y2={outerY}
            stroke="var(--border-color)"
            strokeWidth="1.5"
          />
        );
      })}
      
      {statesData.map((s) => {
        if (!activeStates.has(s.state)) return null;
        
        const points = axes.map((axis, i) => {
          const angle = (2 * Math.PI * i) / N - Math.PI / 2;
          const val = s.scaledValues[axis.key] ?? 50;
          const dist = (val / 100) * r;
          const x = cx + dist * Math.cos(angle);
          const y = cy + dist * Math.sin(angle);
          return { x, y };
        });
        
        const pointsStr = points.map(p => `${p.x},${p.y}`).join(" ");
        
        return (
          <g key={s.state}>
            <polygon
              points={pointsStr}
              fill={`color-mix(in oklab, ${s.color} 10%, transparent)`}
              stroke={s.color}
              strokeWidth="3"
            />
            {points.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r="4"
                fill="var(--bg-main)"
                stroke={s.color}
                strokeWidth="2.5"
              />
            ))}
          </g>
        );
      })}
      
      {axes.map((axis, i) => {
        const angle = (2 * Math.PI * i) / N - Math.PI / 2;
        const labelDist = r + 24;
        const lx = cx + labelDist * Math.cos(angle);
        const ly = cy + labelDist * Math.sin(angle);
        
        let textAnchor = "middle";
        if (Math.cos(angle) > 0.1) textAnchor = "start";
        else if (Math.cos(angle) < -0.1) textAnchor = "end";
        
        let dy = "0.33em";
        if (Math.sin(angle) < -0.9) dy = "-0.3em";
        else if (Math.sin(angle) > 0.9) dy = "0.9em";
        
        return (
          <text
            key={axis.key}
            x={lx}
            y={ly}
            textAnchor={textAnchor}
            dy={dy}
            className="text-[12px] font-semibold fill-[var(--text-main)]"
          >
            {axis.label}
          </text>
        );
      })}
    </svg>
  );
}
