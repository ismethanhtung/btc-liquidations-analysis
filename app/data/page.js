import { readDataset } from "@/lib/data";

export default function DataPage() {
  const rows = readDataset().slice(-120).reverse();

  return (
    <div className="panel-shell">
      <div className="panel-header px-5 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-semibold">Data</h1>
          <p className="text-[12px] text-[var(--text-muted)]">Long liquidation + gia BTC theo moc thoi gian.</p>
        </div>
        <span className="badge" style={{ borderColor: "var(--success-border)", background: "var(--success-bg)", color: "var(--success-text)" }}>
          Latest snapshot
        </span>
      </div>
      <div className="px-5 py-5 overflow-auto thin-scrollbar">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-[var(--border-color)] text-left text-[var(--text-muted)]">
              <th className="py-2">Timestamp</th>
              <th className="py-2">Long Liquidation (USD)</th>
              <th className="py-2">BTC Price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.timestamp} className="border-b border-[var(--border-color)]/70">
                <td className="py-2">{r.timestamp}</td>
                <td className="py-2 font-semibold">${Number(r.longUsd).toLocaleString()}</td>
                <td className="py-2">${Number(r.btcPrice).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
