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
  const timelineTail = useMemo(() => {
    const rows = result?.timeline || [];
    return rows.slice(Math.max(0, rows.length - 240));
  }, [result]);

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
    { key: "transitions", label: "Transitions" },
    { key: "features", label: "Timeline" },
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
                <h2 className="text-[14px] font-semibold">BTC price + state switches</h2>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {result.meta?.startTime?.slice(0, 10)} - {result.meta?.endTime?.slice(0, 10)}
                </span>
              </div>
              <div className="h-[420px] px-2 py-2">
                <div ref={chartRef} className="h-full w-full" />
              </div>
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
                <div className="overflow-auto thin-scrollbar">
                  <div className="flex min-w-max gap-1">
                    {timelineTail.map((row) => (
                      <div
                        key={`${row.time}-${row.state}`}
                        title={`${new Date(row.time * 1000).toLocaleString()} | R${row.state + 1} | conf ${fmtPct(row.confidence || 0)}`}
                        className="h-10 w-2 shrink-0"
                        style={{ backgroundColor: row.color }}
                      />
                    ))}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-[var(--text-muted)]">Last {timelineTail.length} bars, colored by inferred HMM state.</div>
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
