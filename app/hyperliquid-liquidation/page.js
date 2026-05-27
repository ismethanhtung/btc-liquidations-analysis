"use client";

import { useMemo, useRef, useState } from "react";

const WS_ENDPOINT = "wss://api.hyperliquid.xyz/ws";
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_COINS = "BTC,ETH,SOL,XRP,DOGE,HYPE";

export default function HyperliquidLiquidationPage() {
  const [mode, setMode] = useState("official");
  const [coinsInput, setCoinsInput] = useState(DEFAULT_COINS);
  const [hours, setHours] = useState(DEFAULT_WINDOW_HOURS);
  const [historyRows, setHistoryRows] = useState([]);
  const [realtimeRows, setRealtimeRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [coverageNote, setCoverageNote] = useState("");
  const [wsStatus, setWsStatus] = useState("idle");
  const [wsError, setWsError] = useState("");
  const wsRef = useRef(null);

  const combined = useMemo(() => {
    return [...realtimeRows, ...historyRows].sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
  }, [historyRows, realtimeRows]);

  function parseCoins() {
    return coinsInput
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 30);
  }

  async function loadHistory() {
    setHistoryError("");
    setHistoryLoading(true);
    try {
      const now = Date.now();
      const start = now - Number(hours || DEFAULT_WINDOW_HOURS) * 60 * 60 * 1000;
      const endpoint = mode === "official"
        ? "/api/hyperliquid/official-market"
        : "/api/hyperliquid/indexer-liquidations";
      const payload = mode === "official"
        ? { coins: parseCoins(), perCoinLimit: 500, startTime: start }
        : { startTime: start, endTime: now, hours: Number(hours || DEFAULT_WINDOW_HOURS), limit: 1000 };
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
      setHistoryRows(mode === "official" ? (Array.isArray(json?.trades) ? json.trades : []) : (Array.isArray(json?.rows) ? json.rows : []));
      if (mode === "official") {
        if (json?.minTime && json?.maxTime) {
          setCoverageNote(`Official coverage: ${fmtTs(json.minTime)} -> ${fmtTs(json.maxTime)} (khong phai full 30 ngay).`);
        } else {
          setCoverageNote("Official khong tra ve du trade trong khoang thoi gian yeu cau.");
        }
      } else {
        setCoverageNote("");
      }
    } catch (err) {
      setHistoryError(err?.message || "Failed to load history.");
      setHistoryRows([]);
      setCoverageNote("");
    } finally {
      setHistoryLoading(false);
    }
  }

  function startRealtime() {
    stopRealtime();
    setWsError("");
    setWsStatus("connecting");
    const ws = new WebSocket(WS_ENDPOINT);
    wsRef.current = ws;

    ws.onopen = () => {
      parseCoins().forEach((coin) => {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
      });
      setWsStatus("live");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const trades = Array.isArray(msg?.data) ? msg.data : [];
        if (msg?.channel !== "trades" || trades.length === 0) return;
        setRealtimeRows((prev) => [...trades, ...prev].slice(0, 500));
      } catch {
        // Ignore malformed payloads
      }
    };

    ws.onerror = () => {
      setWsStatus("error");
      setWsError("WebSocket error.");
    };

    ws.onclose = () => {
      setWsStatus((s) => (s === "error" ? "error" : "closed"));
    };
  }

  function stopRealtime() {
    const ws = wsRef.current;
    if (ws) {
      ws.close();
      wsRef.current = null;
    }
    setWsStatus("closed");
  }

  return (
    <div className="panel-shell">
      <div className="panel-header px-5 py-4">
        <h1 className="text-[18px] font-semibold">Hyperliquid Liquidation</h1>
        <p className="text-[12px] text-[var(--text-muted)]">
          Official mode: all-market trades (khong co liquidation flag). Indexer mode: all-market liquidation neu ban da cau hinh endpoint.
        </p>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex gap-2">
          <button onClick={() => setMode("official")} className="border border-[var(--border-color)] px-3 py-2">Official Hyperliquid</button>
          <button onClick={() => setMode("indexer")} className="border border-[var(--border-color)] px-3 py-2">Third-party Indexer</button>
          <span className="badge">{mode}</span>
        </div>

        <div className="grid gap-3 lg:grid-cols-4">
          <input
            value={coinsInput}
            onChange={(e) => setCoinsInput(e.target.value)}
            className="input-ui px-3 py-2 text-[12px] lg:col-span-2"
            placeholder="BTC,ETH,SOL..."
          />
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="input-ui px-3 py-2 text-[12px]"
            placeholder="So gio history"
            type="number"
            min={1}
          />
          <button onClick={loadHistory} disabled={historyLoading} className="border border-[var(--border-color)] px-3 py-2">
            {historyLoading ? "Loading..." : "Load History"}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={startRealtime} disabled={mode !== "official"} className="border border-[var(--border-color)] px-3 py-2">Start Realtime (Official)</button>
          <button onClick={stopRealtime} className="border border-[var(--border-color)] px-3 py-2">Stop Realtime</button>
          <span className="badge">{wsStatus}</span>
        </div>

        {historyError ? <p className="text-[11px]" style={{ color: "var(--danger-text)" }}>{historyError}</p> : null}
        {wsError ? <p className="text-[11px]" style={{ color: "var(--danger-text)" }}>{wsError}</p> : null}

        <div className="overflow-auto thin-scrollbar">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
                <th className="py-2">Time</th>
                <th className="py-2">Coin</th>
                <th className="py-2">Side</th>
                <th className="py-2">Price</th>
                <th className="py-2">Size</th>
                <th className="py-2">Type</th>
              </tr>
            </thead>
            <tbody>
              {combined.map((row, idx) => (
                <tr key={`${row.hash || "row"}-${row.time || row.timestamp || idx}`} className="border-b border-[var(--border-color)]/70">
                  <td className="py-2">{fmtTs(row.time || row.timestamp)}</td>
                  <td className="py-2">{row.coin || row.symbol || "N/A"}</td>
                  <td className="py-2">{row.side || row.direction || "N/A"}</td>
                  <td className="py-2">{row.px || row.price || "N/A"}</td>
                  <td className="py-2">{row.sz || row.size || row.qty || "N/A"}</td>
                  <td className="py-2">{row.type || (mode === "official" ? "trade" : "liquidation")}</td>
                </tr>
              ))}
              {combined.length === 0 ? (
                <tr>
                  <td className="py-3 text-[var(--text-muted)]" colSpan={6}>Chua co du lieu.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {coverageNote ? <p className="text-[11px] text-[var(--text-muted)]">{coverageNote}</p> : null}

        {mode === "indexer" ? (
          <p className="text-[11px] text-[var(--text-muted)]">
            Can cau hinh .env: HYPERLIQUID_INDEXER_HTTP_URL (+ HYPERLIQUID_INDEXER_API_KEY neu can).
          </p>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)]">
            Official Hyperliquid khong co endpoint liquidation all-market cong khai, nen mode nay la trade tape cua toan market.
          </p>
        )}
      </div>
    </div>
  );
}

function fmtTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "N/A";
  return new Date(n).toLocaleString();
}
