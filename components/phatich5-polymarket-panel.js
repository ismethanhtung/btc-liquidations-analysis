"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CircleDollarSign,
  LoaderCircle,
  Play,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";

const pctFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtPct(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

function fmtProb(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return `${pctFmt.format(n * 100)}%`;
}

function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return `$${fmtNum(n, Math.abs(n) >= 100 ? 0 : 2)}`;
}

function fmtTime(v) {
  if (!v) return "N/A";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "N/A";
  return d.toISOString().replace(".000Z", "Z");
}

function actionClass(action) {
  if (action === "BUY_UP") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  if (action === "BUY_DOWN") return "border-rose-300 bg-rose-50 text-rose-700";
  return "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)]";
}

function Metric({ label, value, helper, icon: Icon }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase text-[var(--text-muted)]">
        {Icon ? <Icon className="h-3 w-3" /> : null}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-[16px] font-semibold leading-5">{value}</div>
      {helper ? <div className="mt-1 text-[10px] text-[var(--text-muted)]">{helper}</div> : null}
    </div>
  );
}

function SmallMetric({ label, value }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5">
      <div className="text-[9px] uppercase text-[var(--text-muted)]">{label}</div>
      <div className="mt-0.5 text-[12px] font-semibold">{value}</div>
    </div>
  );
}

function RecommendationCard({ title, row, synthetic = false }) {
  const decision = row?.decision;
  const prediction = row?.prediction;
  const unavailable = row?.unavailableReason;
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--border-color)] px-3 py-2">
        <div>
          <div className="text-[12px] font-semibold">{title}</div>
          <div className="mt-0.5 max-w-[680px] text-[10px] text-[var(--text-muted)]">
            {row?.title || row?.question || unavailable || "No event available"}
          </div>
        </div>
        <div className={`border px-2 py-1 text-[11px] font-semibold ${actionClass(decision?.action)}`}>
          {decision?.action || "N/A"}
        </div>
      </div>

      {unavailable ? (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">{unavailable}</div>
      ) : row ? (
        <div className="space-y-3 px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <SmallMetric label="P(Up)" value={fmtProb(prediction?.pUp)} />
            <SmallMetric label={synthetic ? "Model odds" : "Implied Up"} value={synthetic ? "50.00%" : fmtProb(row.impliedUp)} />
            <SmallMetric label="Edge Up / Down" value={`${fmtPct(decision?.edgeUp)} / ${fmtPct(decision?.edgeDown)}`} />
            <SmallMetric label="Max bid" value={decision?.maxBid != null ? fmtNum(decision.maxBid, 3) : "N/A"} />
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <SmallMetric label="Regime" value={`${row.stateLabel || "State"} (${fmtProb(row.confidence)})`} />
            <SmallMetric label="State sample" value={fmtNum(prediction?.stateCount, 0)} />
            <SmallMetric label="Distance to strike" value={fmtPct(row.features?.distanceToStrike)} />
            <SmallMetric label="Position cap" value={fmtPct(decision?.positionFraction)} />
          </div>

          <div className="grid gap-2 text-[11px] text-[var(--text-muted)] xl:grid-cols-[1fr_1fr]">
            <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
              <div className="font-semibold text-[var(--text-main)]">Bid rule</div>
              <div className="mt-1">
                {decision?.side === "UP"
                  ? `Buy UP only at <= ${fmtNum(decision.maxBid, 3)}. Current estimated cost: ${fmtNum(decision.upCost, 3)}.`
                  : decision?.side === "DOWN"
                    ? `Buy DOWN only at <= ${fmtNum(decision.maxBid, 3)}. Current estimated cost: ${fmtNum(decision.downCost, 3)}.`
                    : decision?.reason || "Skip."}
              </div>
            </div>
            <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
              <div className="font-semibold text-[var(--text-main)]">Context</div>
              <div className="mt-1">
                Entry {fmtTime(row.entryTimestamp)} | start {fmtNum(row.startPrice, 1)} | entry {fmtNum(row.entryPrice, 1)}
              </div>
              {synthetic && row.availabilityNote ? <div className="mt-1">{row.availabilityNote}</div> : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">No usable sample.</div>
      )}
    </div>
  );
}

function SummaryPanel({ title, summary, missingOdds }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-semibold">{title}</div>
      <div className="grid gap-2 px-3 py-3 sm:grid-cols-2 xl:grid-cols-4">
        <SmallMetric label="Samples / odds" value={`${fmtNum(summary?.samples, 0)} / ${fmtNum(summary?.oddsSamples, 0)}`} />
        <SmallMetric label="Trades" value={fmtNum(summary?.trades, 0)} />
        <SmallMetric label="Hit rate" value={fmtProb(summary?.hitRate)} />
        <SmallMetric label="Total PnL/share" value={fmtNum(summary?.totalPnl, 3)} />
        <SmallMetric label="Avg PnL/trade" value={fmtNum(summary?.avgPnl, 3)} />
        <SmallMetric label="ROI on cost" value={fmtPct(summary?.roiOnCost)} />
        <SmallMetric label="Avg edge" value={fmtPct(summary?.avgEdge)} />
        <SmallMetric label="Brier" value={summary?.brier == null ? "N/A" : fmtNum(summary.brier, 4)} />
      </div>
      <div className="border-t border-[var(--border-color)] px-3 py-3">
        <div className="mb-2 text-[10px] font-semibold uppercase text-[var(--text-muted)]">$1 per accepted trade</div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <SmallMetric label="Invested" value={fmtUsd(summary?.stakeInvested)} />
          <SmallMetric label="Final payout" value={fmtUsd(summary?.stakePayout)} />
          <SmallMetric label="Net PnL" value={fmtUsd(summary?.stakeNetPnl)} />
          <SmallMetric label="Stake ROI" value={fmtPct(summary?.stakeRoi)} />
        </div>
      </div>
      {missingOdds ? (
        <div className="border-t border-[var(--border-color)] px-3 py-2 text-[10px] text-[var(--text-muted)]">
          Missing historical odds rows: {fmtNum(missingOdds, 0)}. These rows train calibration but do not count in PnL.
        </div>
      ) : null}
    </div>
  );
}

function StateEdgeTable({ rows }) {
  return (
    <div className="overflow-auto thin-scrollbar border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-semibold">Edge by regime</div>
      <table className="min-w-[720px] w-full text-[11px]">
        <thead>
          <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2 text-right">Samples</th>
            <th className="px-3 py-2 text-right">Actual Up</th>
            <th className="px-3 py-2 text-right">Pred Up</th>
            <th className="px-3 py-2 text-right">Trades</th>
            <th className="px-3 py-2 text-right">PnL</th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((row) => (
            <tr key={row.state} className="border-b border-[var(--border-color)]/70">
              <td className="px-3 py-2 font-semibold">
                <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                {row.label}
              </td>
              <td className="px-3 py-2 text-right">{fmtNum(row.samples, 0)}</td>
              <td className="px-3 py-2 text-right">{fmtProb(row.upRate)}</td>
              <td className="px-3 py-2 text-right">{fmtProb(row.avgPredictedUp)}</td>
              <td className="px-3 py-2 text-right">{fmtNum(row.trades, 0)}</td>
              <td className={`px-3 py-2 text-right font-semibold ${Number(row.pnl) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {fmtNum(row.pnl, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradesTable({ rows }) {
  return (
    <div className="overflow-auto thin-scrollbar border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-semibold">Backtest trades</div>
      <table className="min-w-[1120px] w-full text-[11px]">
        <thead>
          <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2">Event</th>
            <th className="px-3 py-2">Entry</th>
            <th className="px-3 py-2">Regime</th>
            <th className="px-3 py-2 text-right">P(Up)</th>
            <th className="px-3 py-2 text-right">Odds</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2 text-right">Outcome</th>
            <th className="px-3 py-2 text-right">PnL</th>
            <th className="px-3 py-2 text-right">$1 payout</th>
            <th className="px-3 py-2 text-right">$1 net</th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).length ? (rows || []).map((row) => (
            <tr key={`${row.slug}-${row.entryTimestamp}`} className="border-b border-[var(--border-color)]/70 align-top">
              <td className="max-w-[260px] px-3 py-2">
                <div className="truncate font-semibold">{row.title}</div>
                <div className="truncate text-[10px] text-[var(--text-muted)]">{row.slug}</div>
              </td>
              <td className="px-3 py-2">{fmtTime(row.entryTimestamp)}</td>
              <td className="px-3 py-2">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: row.stateColor }} />
                {row.stateLabel}
              </td>
              <td className="px-3 py-2 text-right">{fmtProb(row.prediction?.pUp)}</td>
              <td className="px-3 py-2 text-right">{row.impliedUp == null ? "N/A" : fmtProb(row.impliedUp)}</td>
              <td className="px-3 py-2">
                <span className={`border px-2 py-0.5 text-[10px] font-semibold ${actionClass(row.decision?.action)}`}>
                  {row.decision?.action}
                </span>
              </td>
              <td className="px-3 py-2 text-right">{row.outcome || "N/A"}</td>
              <td className={`px-3 py-2 text-right font-semibold ${Number(row.pnl) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {row.pnl == null ? "N/A" : fmtNum(row.pnl, 3)}
              </td>
              <td className="px-3 py-2 text-right">{row.stakeResult ? fmtUsd(row.stakeResult.payout) : "N/A"}</td>
              <td className={`px-3 py-2 text-right font-semibold ${Number(row.stakeResult?.netPnl) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {row.stakeResult ? fmtUsd(row.stakeResult.netPnl) : "N/A"}
              </td>
            </tr>
          )) : (
            <tr>
              <td className="px-3 py-4 text-[var(--text-muted)]" colSpan={10}>No trades passed the edge and sample filters.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Phatich5PolymarketPanel({
  datasets = [],
  selectedDataset = "",
  selectedFeatures = [],
  params = {},
}) {
  const preferredDataset = useMemo(() => {
    return datasets.find((dataset) => dataset.includes("1h_1y"))
      || datasets.find((dataset) => dataset.includes("binance_5m"))
      || selectedDataset
      || datasets[0]
      || "";
  }, [datasets, selectedDataset]);
  const [dataset, setDataset] = useState(preferredDataset);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [settings, setSettings] = useState({
    entryDelayHours: 1,
    minEdge: 3.5,
    minStateSamples: 12,
    maxDailyMarkets: 180,
    marketPages: 8,
    includeOdds: true,
  });

  useEffect(() => {
    if (!dataset && preferredDataset) setDataset(preferredDataset);
  }, [dataset, preferredDataset]);

  async function run() {
    const activeDataset = dataset || preferredDataset;
    if (!activeDataset) {
      setError("No dataset selected.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/phatich5/polymarket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset: activeDataset,
          fitK: params.fitK === "auto" ? null : params.fitK,
          maxK: params.maxK || 8,
          hmmIterations: params.hmmIterations || 10,
          selectedFeatures,
          entryDelayHours: Number(settings.entryDelayHours || 1),
          minEdge: Number(settings.minEdge || 3.5) / 100,
          minStateSamples: Number(settings.minStateSamples || 12),
          maxDailyMarkets: Number(settings.maxDailyMarkets || 180),
          marketPages: Number(settings.marketPages || 8),
          includeOdds: settings.includeOdds,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
      setResult(json);
    } catch (err) {
      setError(err?.message || "Failed to run Polymarket research.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
        <div className="border border-[var(--border-color)] bg-[var(--bg-main)]">
          <div className="border-b border-[var(--border-color)] px-3 py-2">
            <div className="text-[12px] font-semibold">Polymarket BTC Up/Down research</div>
            <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
              Regime is used as a conditional probability layer, then compared with market-implied odds after spread, slippage, and taker fee.
            </div>
          </div>
          <div className="grid gap-3 px-3 py-3 md:grid-cols-2 xl:grid-cols-6">
            <label className="xl:col-span-2">
              <div className="mb-1 text-[10px] uppercase text-[var(--text-muted)]">Dataset</div>
              <select
                className="input-ui h-9 w-full px-2 text-[12px]"
                value={dataset}
                onChange={(event) => setDataset(event.target.value)}
              >
                {datasets.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              <div className="mb-1 text-[10px] uppercase text-[var(--text-muted)]">Entry delay h</div>
              <input
                className="input-ui h-9 w-full px-2 text-[12px]"
                type="number"
                min="0"
                max="12"
                step="0.25"
                value={settings.entryDelayHours}
                onChange={(event) => setSettings((curr) => ({ ...curr, entryDelayHours: Number(event.target.value || 1) }))}
              />
            </label>
            <label>
              <div className="mb-1 text-[10px] uppercase text-[var(--text-muted)]">Min edge %</div>
              <input
                className="input-ui h-9 w-full px-2 text-[12px]"
                type="number"
                min="0"
                max="20"
                step="0.25"
                value={settings.minEdge}
                onChange={(event) => setSettings((curr) => ({ ...curr, minEdge: Number(event.target.value || 3.5) }))}
              />
            </label>
            <label>
              <div className="mb-1 text-[10px] uppercase text-[var(--text-muted)]">Min state samples</div>
              <input
                className="input-ui h-9 w-full px-2 text-[12px]"
                type="number"
                min="3"
                max="80"
                step="1"
                value={settings.minStateSamples}
                onChange={(event) => setSettings((curr) => ({ ...curr, minStateSamples: Number(event.target.value || 12) }))}
              />
            </label>
            <label>
              <div className="mb-1 text-[10px] uppercase text-[var(--text-muted)]">Markets</div>
              <input
                className="input-ui h-9 w-full px-2 text-[12px]"
                type="number"
                min="20"
                max="350"
                step="10"
                value={settings.maxDailyMarkets}
                onChange={(event) => setSettings((curr) => ({ ...curr, maxDailyMarkets: Number(event.target.value || 180) }))}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-color)] px-3 py-2">
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={settings.includeOdds}
                onChange={(event) => setSettings((curr) => ({ ...curr, includeOdds: event.target.checked }))}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              Include CLOB odds history
            </label>
            <button
              onClick={run}
              disabled={loading || !dataset}
              className="inline-flex h-8 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[11px] font-semibold"
            >
              {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : result ? <RefreshCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {loading ? "Running" : result ? "Run again" : "Run research"}
            </button>
          </div>
        </div>

        <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-3">
          <div className="text-[12px] font-semibold">What this answers</div>
          <div className="mt-2 space-y-2 text-[11px] text-[var(--text-muted)]">
            <div className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>For a live 1D event: estimate fair P(Up), compare with executable odds, then output buy/skip and max bid.</span>
            </div>
            <div className="flex gap-2">
              <BarChart3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>For 4H: fetch listed `btc-updown-4h-*` markets when available; use synthetic 4H only as a fallback research view.</span>
            </div>
            <div className="flex gap-2">
              <CircleDollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Costs include conservative slippage and Polymarket taker fee formula for crypto markets.</span>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] text-[var(--danger-text)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            <Metric label="Dataset" value={result.meta?.dataset || "N/A"} helper={`${fmtTime(result.meta?.regimeStartTime)} -> ${fmtTime(result.meta?.regimeEndTime)}`} icon={BarChart3} />
            <Metric label="Regime K" value={fmtNum(result.meta?.chosenK, 0)} helper={`min state samples ${fmtNum(result.meta?.minStateSamples, 0)}`} icon={ShieldCheck} />
            <Metric label="Daily samples" value={fmtNum(result.meta?.dailySamples, 0)} helper={`${fmtNum(result.meta?.marketEventsFetched, 0)} Gamma events fetched`} icon={ShieldCheck} />
            <Metric label="Daily PnL" value={fmtNum(result.dailyBacktest?.summary?.totalPnl, 3)} helper={`trades ${fmtNum(result.dailyBacktest?.summary?.trades, 0)}, hit ${fmtProb(result.dailyBacktest?.summary?.hitRate)}`} icon={ArrowUp} />
            <Metric label="4H PnL" value={fmtNum(result.fourHourBacktest?.summary?.totalPnl, 3)} helper={`trades ${fmtNum(result.fourHourBacktest?.summary?.trades, 0)}, hit ${fmtProb(result.fourHourBacktest?.summary?.hitRate)}`} icon={ArrowDown} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <RecommendationCard title="Live 1D Polymarket event" row={result.liveDaily} />
            <RecommendationCard title="Live 4H Polymarket event" row={result.live4h} synthetic={!result.live4h?.isListedMarket} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <SummaryPanel title="Daily Polymarket backtest" summary={result.dailyBacktest?.summary} missingOdds={result.dailyBacktest?.skippedMissingOdds} />
            <SummaryPanel title="4H Polymarket backtest" summary={result.fourHourBacktest?.summary} missingOdds={result.fourHourBacktest?.skippedMissingOdds} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <StateEdgeTable rows={result.dailyBacktest?.stateEdges || []} />
            <StateEdgeTable rows={result.fourHourBacktest?.stateEdges || []} />
          </div>

          <TradesTable rows={result.dailyBacktest?.trades || []} />
          <TradesTable rows={result.fourHourBacktest?.trades || []} />

          <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[10px] text-[var(--text-muted)]">
            {(result.meta?.notes || []).join(" ")}
          </div>
        </>
      ) : (
        <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-4 text-[12px] text-[var(--text-muted)]">
          Run research to fetch Polymarket Gamma/CLOB data and join it with the selected regime timeline.
        </div>
      )}
    </div>
  );
}
