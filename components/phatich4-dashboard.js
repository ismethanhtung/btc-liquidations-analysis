"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import {
  AlertTriangle,
  BarChart3,
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

export default function Phatich4Dashboard() {
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
        const res = await fetch("/api/phatich4/regime", { cache: "no-store" });
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

  async function runAnalysis(dataset = selectedDataset) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/phatich4/regime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "local",
          dataset,
          fitK: params.fitK,
          maxK: params.maxK,
          hmmIterations: params.hmmIterations,
          selectedFeatures,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `Request failed: ${res.status}`);
      }
      setResult(json);
      setSelectedTime(null);
    } catch (err) {
      setError(err?.message || "Failed to build regime model.");
    } finally {
      setLoading(false);
    }
  }

  const metricTone = latestState?.tone || "neutral";
  const tabs = [
    { key: "regimes", label: "Regimes" },
    { key: "durations", label: "Duration" },
    { key: "transitions", label: "Transitions" },
    { key: "features", label: "Timeline" },
    { key: "diagnostics", label: "Diagnostics" },
    { key: "k", label: "K check" },
  ];

  return (
    <div className="space-y-3">
      <div className="panel-shell overflow-hidden">
        <div className="panel-header px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold leading-6">Phan tich 4 - Regime Routing</h1>
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
                  const res = await fetch("/api/phatich4/regime", { cache: "no-store" });
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
              helper={result?.meta?.kSelection ? `mode=${result.meta.kSelection.method}, sil=${result.meta.kSelection.chosenBySilhouette}, elbow=${result.meta.kSelection.chosenByElbow}` : "K diagnostics"}
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
              <div className="overflow-auto thin-scrollbar px-4 py-4">
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
                    {result.transitions?.map((row, i) => (
                      <tr key={i} className="border-b border-[var(--border-color)]/70">
                        <td className="py-2 font-semibold">R{i + 1}</td>
                        {row.map((cell, j) => (
                          <td key={j} className="py-2 text-right">{fmtPct(cell.p || 0)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                <KDecisionPanel meta={result.meta} />
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
              <div className="overflow-auto thin-scrollbar px-4 py-4">
                <table className="min-w-[560px] w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                      <th className="py-2">K</th>
                      <th className="py-2">Inertia</th>
                      <th className="py-2">Silhouette</th>
                      <th className="py-2">Elbow drop</th>
                      <th className="py-2">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.meta?.candidateKs?.map((row) => (
                      <tr key={row.k} className="border-b border-[var(--border-color)]/70">
                        <td className="py-2 font-semibold">{row.k}</td>
                        <td className="py-2">{fmtNum(row.inertia, 2)}</td>
                        <td className="py-2">{fmtNum(row.silhouette, 3)}</td>
                        <td className="py-2">{fmtPct(row.elbowDrop || 0)}</td>
                        <td className="py-2">{fmtNum(row.score, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
  const total = segments.reduce((sum, segment) => sum + Number(segment.bars || 0), 0) || 1;
  return (
    <div className="border-t border-[var(--border-color)] px-3 py-2">
      <div className={`flex w-full overflow-hidden border border-[var(--border-color)] bg-[var(--bg-secondary)] ${tall ? "h-14" : "h-5"}`}>
        {segments.map((segment, idx) => (
          <div
            key={`${segment.startTime}-${idx}`}
            title={`${segment.label} | ${segment.startTimestamp} -> ${segment.endTimestamp} | ${fmtHours(segment.hours)} | conf ${fmtPct(segment.avgConfidence || 0)}`}
            className="h-full shrink-0"
            style={{
              width: `${Math.max(0.08, (Number(segment.bars || 0) / total) * 100)}%`,
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
  const points = data?.points || [];
  const explained = data?.explained || [0, 0];
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
        <div className="text-[12px] font-semibold">PCA projection: all regime features</div>
        <div className="text-[10px] text-[var(--text-muted)]">
          PC1 {fmtPct(explained[0] || 0)} variance, PC2 {fmtPct(explained[1] || 0)}. This is a better 2D check than raw Vol/Liq scatter.
        </div>
      </div>
      <div className="relative h-[360px]">
        <div className="absolute inset-4 border-l border-b border-[var(--border-color)]">
          {points.map((point, idx) => (
            <div
              key={`${point.time}-${idx}`}
              title={`${point.timestamp} | State ${point.state + 1} | PC1=${fmtNum(point.x, 2)} | PC2=${fmtNum(point.y, 2)} | conf=${fmtPct(point.confidence)}`}
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
        <div className="absolute bottom-1 left-4 text-[10px] text-[var(--text-muted)]">PC1</div>
        <div className="absolute left-1 top-4 -rotate-90 text-[10px] text-[var(--text-muted)]">PC2</div>
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

function KDecisionPanel({ meta }) {
  const selection = meta?.kSelection || {};
  const rows = meta?.candidateKs || [];
  const chosen = Number(meta?.chosenK || 0);
  const chosenRow = rows.find((row) => row.k === chosen);
  const elbowRow = rows.find((row) => row.k === selection.chosenByElbow);
  const silhouetteRow = rows.find((row) => row.k === selection.chosenBySilhouette);
  const scoreRow = rows.find((row) => row.k === selection.chosenByScore);

  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_1fr_1fr_1fr]">
      <DecisionCard
        title="Fit K"
        value={`K=${chosen || "N/A"}`}
        helper={`${selection.method || "auto"} mode | HMM states actually used`}
        tone="primary"
      />
      <DecisionCard
        title="Best separation"
        value={`K=${silhouetteRow?.k ?? "N/A"}`}
        helper={`Silhouette ${fmtNum(silhouetteRow?.silhouette, 3)}`}
      />
      <DecisionCard
        title="Largest elbow"
        value={`K=${elbowRow?.k ?? "N/A"}`}
        helper={`Drop ${fmtPct(elbowRow?.elbowDrop || 0)}`}
      />
      <DecisionCard
        title="Combined score"
        value={`K=${scoreRow?.k ?? "N/A"}`}
        helper={`Score ${fmtNum(scoreRow?.score, 3)} | chosen row score ${fmtNum(chosenRow?.score, 3)}`}
      />
    </div>
  );
}

function DecisionCard({ title, value, helper, tone }) {
  return (
    <div className={`border px-4 py-3 ${tone === "primary" ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_9%,white)]" : "border-[var(--border-color)] bg-[var(--bg-main)]"}`}>
      <div className="text-[10px] uppercase text-[var(--text-muted)]">{title}</div>
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
