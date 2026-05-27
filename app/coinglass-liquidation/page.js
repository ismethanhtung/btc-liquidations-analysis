"use client";

import { useState } from "react";

export default function CoinglassLiquidationPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [interval, setInterval] = useState("1h");

  async function runFetch() {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/coinglass/btc-liquidation-2y", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "BTC", years: 2, interval, exchangeList: "Binance,Bybit,OKX" })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
      setResult(json);
    } catch (e) {
      setError(e?.message || "Failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel-shell">
      <div className="panel-header px-5 py-4">
        <h1 className="text-[18px] font-semibold">Coinglass BTC Liquidation 2Y</h1>
        <p className="text-[12px] text-[var(--text-muted)]">Lay va luu du lieu liquidation BTC 2 nam vao CSV, sau do hien thi preview.</p>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          <select value={interval} onChange={(e) => setInterval(e.target.value)} className="input-ui px-3 py-2 text-[12px]">
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
          </select>
          <button onClick={runFetch} disabled={loading} className="border border-[var(--border-color)] px-3 py-2">
            {loading ? "Fetching..." : "Fetch 2Y BTC Liquidation"}
          </button>
        </div>

        {error ? <p className="text-[11px]" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
        {result ? (
          <div className="space-y-3">
            <div className="text-[12px]">
              <p>Rows: <b>{result.rows}</b></p>
              <p>CSV: <code>{result.csvPath}</code></p>
              <p>JSON: <code>{result.jsonPath}</code></p>
            </div>
            <div className="overflow-auto thin-scrollbar">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                    <th className="py-2">Time</th>
                    <th className="py-2">Long USD</th>
                    <th className="py-2">Short USD</th>
                    <th className="py-2">Total USD</th>
                  </tr>
                </thead>
                <tbody>
                  {result.preview?.map((r) => (
                    <tr key={r.timestamp} className="border-b border-[var(--border-color)]/70">
                      <td className="py-2">{new Date(r.timestamp).toLocaleString()}</td>
                      <td className="py-2">{fmtUsd(r.longUsd)}</td>
                      <td className="py-2">{fmtUsd(r.shortUsd)}</td>
                      <td className="py-2">{fmtUsd(r.totalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function fmtUsd(v) {
  const n = Number(v || 0);
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
