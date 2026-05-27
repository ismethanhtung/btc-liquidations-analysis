import { readDataset, summarize } from "@/lib/data";

export default function HomePage() {
  const data = readDataset();
  const stats = summarize(data);

  return (
    <div className="space-y-4">
      <div className="panel-shell">
        <div className="panel-header px-5 py-4">
          <h1 className="text-[20px] font-semibold">Tong quan</h1>
          <p className="text-[12px] text-[var(--text-muted)]">Dashboard nghien cuu tin hieu thanh ly long BTC.</p>
        </div>
        <div className="px-5 py-5 grid gap-3 lg:grid-cols-3">
          <Metric label="So dong du lieu" value={stats.rows.toLocaleString()} />
          <Metric label="Tong long liquidation" value={`$${Math.round(stats.longUsd).toLocaleString()}`} />
          <Metric label="Dinh long liquidation" value={`$${Math.round(stats.maxLongUsd).toLocaleString()}`} />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
      <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
      <p className="text-[18px] font-semibold mt-1">{value}</p>
    </div>
  );
}
