"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  LoaderCircle,
  Play,
  RefreshCcw,
  WalletCards,
} from "lucide-react";

function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(2)}%`;
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

function sideClass(side) {
  if (side === "UP") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  if (side === "DOWN") return "border-rose-300 bg-rose-50 text-rose-700";
  return "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)]";
}

function statusClass(status) {
  if (status === "SETTLED") return "border-sky-300 bg-sky-50 text-sky-700";
  if (status === "OPEN") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  if (status === "PENDING_SETTLEMENT") return "border-amber-300 bg-amber-50 text-amber-700";
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

function TradesTable({ rows }) {
  return (
    <div className="overflow-auto thin-scrollbar border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-semibold">Paper trade history</div>
      <table className="min-w-[1120px] w-full text-[11px]">
        <thead>
          <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2">Market</th>
            <th className="px-3 py-2">Opened</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Side</th>
            <th className="px-3 py-2 text-right">P(Up)</th>
            <th className="px-3 py-2 text-right">Cost</th>
            <th className="px-3 py-2 text-right">Edge</th>
            <th className="px-3 py-2 text-right">Stake</th>
            <th className="px-3 py-2 text-right">Outcome</th>
            <th className="px-3 py-2 text-right">Net PnL</th>
          </tr>
        </thead>
        <tbody>
          {rows?.length ? rows.map((row) => (
            <tr key={row.id} className="border-b border-[var(--border-color)]/70 align-top">
              <td className="max-w-[300px] px-3 py-2">
                <div className="truncate font-semibold">{row.title || row.marketSlug}</div>
                <div className="truncate text-[10px] text-[var(--text-muted)]">{row.horizon} | {row.marketSlug}</div>
              </td>
              <td className="px-3 py-2">{fmtTime(row.openedAt)}</td>
              <td className="px-3 py-2">
                <span className={`border px-2 py-0.5 text-[10px] font-semibold ${statusClass(row.status)}`}>
                  {row.status}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className={`border px-2 py-0.5 text-[10px] font-semibold ${sideClass(row.side)}`}>
                  {row.side}
                </span>
              </td>
              <td className="px-3 py-2 text-right">{fmtPct(row.pUp)}</td>
              <td className="px-3 py-2 text-right">{fmtNum(row.cost, 3)}</td>
              <td className="px-3 py-2 text-right">{fmtPct(row.edge)}</td>
              <td className="px-3 py-2 text-right">{fmtUsd(row.stakeUsd)}</td>
              <td className="px-3 py-2 text-right">{row.outcome || "N/A"}</td>
              <td className={`px-3 py-2 text-right font-semibold ${Number(row.netPnlUsd) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {row.status === "SETTLED" ? fmtUsd(row.netPnlUsd) : "N/A"}
              </td>
            </tr>
          )) : (
            <tr>
              <td className="px-3 py-4 text-[var(--text-muted)]" colSpan={10}>No paper trades recorded yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RunsTable({ rows }) {
  return (
    <div className="overflow-auto thin-scrollbar border border-[var(--border-color)] bg-[var(--bg-main)]">
      <div className="border-b border-[var(--border-color)] px-3 py-2 text-[12px] font-semibold">Runner log</div>
      <table className="min-w-[760px] w-full text-[11px]">
        <thead>
          <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
            <th className="px-3 py-2">Finished</th>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2 text-right">K</th>
            <th className="px-3 py-2 text-right">Opened</th>
            <th className="px-3 py-2 text-right">Settled</th>
            <th className="px-3 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows?.length ? rows.slice(0, 20).map((row) => (
            <tr key={row.id} className="border-b border-[var(--border-color)]/70">
              <td className="px-3 py-2">{fmtTime(row.finishedAt)}</td>
              <td className="px-3 py-2">{row.source || "N/A"}</td>
              <td className="px-3 py-2 text-right">{row.chosenK ?? "N/A"}</td>
              <td className="px-3 py-2 text-right">{row.opened ?? 0}</td>
              <td className="px-3 py-2 text-right">{row.settled ?? 0}</td>
              <td className="max-w-[360px] px-3 py-2 text-[var(--text-muted)]">
                {(row.warnings || []).join(" ") || (row.skipped || []).slice(0, 2).map((item) => item.reason).join("; ") || "ok"}
              </td>
            </tr>
          )) : (
            <tr>
              <td className="px-3 py-4 text-[var(--text-muted)]" colSpan={6}>No runner log yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Phatich5LivePaperPanel() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/phatich5/live-paper", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
      setSnapshot(json);
    } catch (err) {
      setError(err?.message || "Failed to load paper history.");
    } finally {
      setLoading(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setError("");
    try {
      const res = await fetch("/api/phatich5/live-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Run failed: ${res.status}`);
      await load();
    } catch (err) {
      setError(err?.message || "Failed to run paper tick.");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const summary = snapshot?.summary || {};
  const store = snapshot?.store || {};

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Total" value={summary.totalTrades ?? 0} helper={`${summary.openTrades ?? 0} open, ${summary.pendingTrades ?? 0} pending`} icon={WalletCards} />
          <Metric label="Settled" value={summary.settledTrades ?? 0} helper={`${summary.wins ?? 0} wins / ${summary.losses ?? 0} losses`} icon={CheckCircle2} />
          <Metric label="Hit rate" value={fmtPct(summary.hitRate)} helper="Settled trades only" icon={Clock3} />
          <Metric label="Net PnL" value={fmtUsd(summary.netPnl)} helper={`Invested ${fmtUsd(summary.stakeInvested)}`} icon={WalletCards} />
          <Metric label="ROI" value={fmtPct(summary.roi)} helper="Based on settled stake" icon={CheckCircle2} />
        </div>

        <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold">
            <Database className="h-3.5 w-3.5" />
            <span>Storage: {store.kind || "N/A"}</span>
          </div>
          <div className="mt-1 break-all text-[10px] text-[var(--text-muted)]">{store.pathname || "N/A"}</div>
          {store.warning ? (
            <div className="mt-2 flex items-start gap-2 border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{store.warning}</span>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              onClick={load}
              disabled={loading || running}
              className="inline-flex h-8 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[11px] font-semibold"
            >
              {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Refresh
            </button>
            <button
              onClick={runNow}
              disabled={running || loading}
              className="inline-flex h-8 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[11px] font-semibold"
            >
              {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run now
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] text-[var(--danger-text)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <TradesTable rows={snapshot?.trades || []} />
      <RunsTable rows={snapshot?.runs || []} />
    </div>
  );
}
