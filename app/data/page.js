"use client";

import { useEffect, useState } from "react";
import { Database, FileCode, Clock, RefreshCcw, LoaderCircle, Layers, CheckCircle2, WalletCards } from "lucide-react";

function fmtNum(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "N/A";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function fmtTime(v) {
  if (!v) return "N/A";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "N/A";
  return d.toISOString().replace(".000Z", "Z");
}

export default function DataPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedDataset, setSelectedDataset] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [activeTab, setActiveTab] = useState("files"); // 'files', 'polymarket'

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/data${selectedDataset ? `?dataset=${selectedDataset}` : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Failed to load data assets.");
      setData(json);
      if (json.preview) {
        setPreview(json.preview);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, [selectedDataset]);

  const csvFiles = data?.csvFiles || [];
  const jsonFiles = data?.jsonFiles || [];
  const trades = data?.livePaperHistory?.trades || [];
  const runs = data?.livePaperHistory?.runs || [];

  return (
    <div className="panel-shell px-5 py-4 space-y-6">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3">
        <div>
          <h1 className="text-[18px] font-semibold text-[var(--text-main)]">Quản lý & Giám sát dữ liệu (Data Hub)</h1>
          <p className="text-[12px] text-[var(--text-muted)]">Kiểm tra các file dữ liệu HMM cục bộ và lịch sử vị thế Polymarket Live.</p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="inline-flex h-8 items-center justify-center gap-1.5 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[11px] font-semibold hover:bg-[var(--border-color)] transition-colors rounded"
        >
          {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {error ? (
        <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 p-2.5 rounded">
          {error}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[var(--border-color)] pb-px">
        <button
          onClick={() => setActiveTab("files")}
          className={`border-b-2 px-4 py-2 text-[12px] font-semibold transition-all -mb-px ${
            activeTab === "files"
              ? "border-[var(--color-accent)] text-[var(--text-main)] font-bold"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-main)]"
          }`}
        >
          📁 Dữ liệu HMM (CSV/JSON Datasets)
        </button>
        <button
          onClick={() => setActiveTab("polymarket")}
          className={`border-b-2 px-4 py-2 text-[12px] font-semibold transition-all -mb-px ${
            activeTab === "polymarket"
              ? "border-[var(--color-accent)] text-[var(--text-main)] font-bold"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-main)]"
          }`}
        >
          📊 Dữ liệu Event & Vị thế Polymarket
        </button>
      </div>

      {activeTab === "files" ? (
        <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
          {/* Column 1: Files List */}
          <div className="space-y-4">
            <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-4 rounded space-y-4">
              <h3 className="text-[12px] font-bold text-[var(--text-main)] flex items-center gap-1.5 border-b border-[var(--border-color)] pb-2">
                <Database className="h-4 w-4" /> Các File dữ liệu HMM (CSV)
              </h3>
              <div className="space-y-2 max-h-[35vh] overflow-y-auto thin-scrollbar">
                {csvFiles.map((file) => (
                  <div
                    key={file.name}
                    onClick={() => setSelectedDataset(file.name)}
                    className={`p-2.5 border rounded cursor-pointer transition-colors text-[11px] ${
                      selectedDataset === file.name
                        ? "border-[var(--color-accent)] bg-[var(--bg-secondary)] font-semibold"
                        : "border-[var(--border-color)] hover:bg-[var(--bg-secondary)]"
                    }`}
                  >
                    <div className="truncate font-semibold text-[var(--text-main)]">{file.name}</div>
                    <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1">
                      <span>Dung lượng: {fmtSize(file.size)}</span>
                      <span>Cập nhật: {fmtTime(file.mtime)}</span>
                    </div>
                  </div>
                ))}
                {!csvFiles.length && <p className="text-[11px] text-[var(--text-muted)]">Không tìm thấy file CSV nào.</p>}
              </div>

              <h3 className="text-[12px] font-bold text-[var(--text-main)] flex items-center gap-1.5 border-b border-[var(--border-color)] pb-2 pt-2">
                <FileCode className="h-4 w-4" /> Các File tham số & cấu hình (JSON)
              </h3>
              <div className="space-y-2 max-h-[25vh] overflow-y-auto thin-scrollbar">
                {jsonFiles.map((file) => (
                  <div key={file.name} className="p-2 border border-[var(--border-color)] rounded text-[11px]">
                    <div className="truncate font-semibold text-[var(--text-main)]">{file.name}</div>
                    <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1">
                      <span>Dung lượng: {fmtSize(file.size)}</span>
                      <span>Cập nhật: {fmtTime(file.mtime)}</span>
                    </div>
                  </div>
                ))}
                {!jsonFiles.length && <p className="text-[11px] text-[var(--text-muted)]">Không tìm thấy file JSON cấu hình.</p>}
              </div>
            </div>
          </div>

          {/* Column 2: Data Spreadsheet Preview */}
          <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-4 rounded space-y-4 overflow-hidden flex flex-col">
            <h3 className="text-[12px] font-bold text-[var(--text-main)] flex items-center gap-1.5 border-b border-[var(--border-color)] pb-2">
              <Layers className="h-4 w-4" /> Xem trước nội dung dữ liệu (Tối đa 30 dòng gần nhất)
            </h3>
            {!selectedDataset ? (
              <div className="py-16 text-center text-[var(--text-muted)] text-[12px]">
                Chọn một file CSV bên trái để hiển thị bảng dữ liệu chi tiết.
              </div>
            ) : previewLoading ? (
              <div className="py-16 flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
                <LoaderCircle className="h-5 w-5 animate-spin" /> Đang đọc dữ liệu...
              </div>
            ) : preview && preview.headers.length > 0 ? (
              <div className="overflow-auto thin-scrollbar max-h-[70vh] border border-[var(--border-color)] rounded">
                <table className="w-full text-[10px] text-left border-collapse min-w-[800px]">
                  <thead>
                    <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-color)] text-[var(--text-muted)] font-mono">
                      {preview.headers.map((header) => (
                        <th key={header} className="px-2 py-1.5 border-r border-[var(--border-color)] font-semibold">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, idx) => (
                      <tr key={idx} className="border-b border-[var(--border-color)]/70 hover:bg-[var(--bg-secondary)]/30 font-mono">
                        {preview.headers.map((header) => (
                          <td key={header} className="px-2 py-1 border-r border-[var(--border-color)] truncate max-w-[150px]">
                            {row[header]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-16 text-center text-[var(--text-muted)] text-[12px]">
                Không có dữ liệu hiển thị hoặc lỗi cấu trúc file.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Polymarket paper trades history */}
          <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-4 rounded space-y-4">
            <h3 className="text-[12px] font-bold text-[var(--text-main)] flex items-center gap-1.5 border-b border-[var(--border-color)] pb-2">
              <WalletCards className="h-4 w-4" /> Vị thế Polymarket Live Paper (live-paper-history.json)
            </h3>
            <div className="overflow-auto thin-scrollbar max-h-[45vh]">
              <table className="min-w-[960px] w-full text-[11px] text-left">
                <thead>
                  <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)]">
                    <th className="px-2 py-2">Slug thị trường</th>
                    <th className="px-2 py-2">Thời gian mở</th>
                    <th className="px-2 py-2">Trạng thái</th>
                    <th className="px-2 py-2">Side</th>
                    <th className="px-2 py-2 text-right">P(Up)</th>
                    <th className="px-2 py-2 text-right">Cost</th>
                    <th className="px-2 py-2 text-right">Edge</th>
                    <th className="px-2 py-2 text-right">Stake</th>
                    <th className="px-2 py-2 text-right">Outcome</th>
                    <th className="px-2 py-2 text-right">Net PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice().reverse().map((row) => (
                    <tr key={row.id} className="border-b border-[var(--border-color)]/70 align-top">
                      <td className="px-2 py-2 font-mono">{row.marketSlug}</td>
                      <td className="px-2 py-2 text-[var(--text-muted)]">{fmtTime(row.openedAt)}</td>
                      <td className="px-2 py-2">
                        <span className={`px-1.5 py-0.5 border text-[9px] font-bold ${row.status === "SETTLED" ? "border-sky-300 bg-sky-50 text-sky-700" : "border-emerald-300 bg-emerald-50 text-emerald-700"}`}>
                          {row.status}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <span className={`px-1.5 py-0.5 border text-[9px] font-bold ${row.side === "UP" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-rose-300 bg-rose-50 text-rose-700"}`}>
                          {row.side}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right font-mono">{fmtNum(row.pUp * 100, 2)}%</td>
                      <td className="px-2 py-2 text-right font-mono">{fmtNum(row.cost, 3)}</td>
                      <td className="px-2 py-2 text-right font-mono">{(row.edge * 100).toFixed(2)}%</td>
                      <td className="px-2 py-2 text-right font-mono">${row.stakeUsd}</td>
                      <td className="px-2 py-2 text-right font-semibold">{row.outcome || "N/A"}</td>
                      <td className={`px-2 py-2 text-right font-bold ${Number(row.netPnlUsd) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                        {row.status === "SETTLED" ? fmtNum(row.netPnlUsd, 2) : "N/A"}
                      </td>
                    </tr>
                  ))}
                  {!trades.length && (
                    <tr>
                      <td className="px-2 py-4 text-center text-[var(--text-muted)]" colSpan={10}>Chưa ghi nhận lệnh Polymarket nào.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Runner Logs */}
          <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-4 rounded space-y-4">
            <h3 className="text-[12px] font-bold text-[var(--text-main)] flex items-center gap-1.5 border-b border-[var(--border-color)] pb-2">
              <Clock className="h-4 w-4" /> Nhật ký thực thi ngầm trên EC2 (Runner logs)
            </h3>
            <div className="overflow-auto thin-scrollbar max-h-[35vh]">
              <table className="min-w-[760px] w-full text-[11px] text-left">
                <thead>
                  <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)]">
                    <th className="px-2 py-2">Mã lượt chạy (Run ID)</th>
                    <th className="px-2 py-2">Thời gian chạy</th>
                    <th className="px-2 py-2">Nguồn</th>
                    <th className="px-2 py-2 text-right">K</th>
                    <th className="px-2 py-2 text-right">Đã mở</th>
                    <th className="px-2 py-2 text-right">Tất toán</th>
                    <th className="px-2 py-2">Ghi chú / Cảnh báo</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice().reverse().map((row) => (
                    <tr key={row.id} className="border-b border-[var(--border-color)]/70">
                      <td className="px-2 py-2 font-mono">{row.id}</td>
                      <td className="px-2 py-2 text-[var(--text-muted)]">{fmtTime(row.finishedAt)}</td>
                      <td className="px-2 py-2 font-semibold">{row.source} ({row.interval})</td>
                      <td className="px-2 py-2 text-right font-mono">{row.chosenK ?? "N/A"}</td>
                      <td className="px-2 py-2 text-right font-mono text-emerald-600 font-semibold">{row.opened}</td>
                      <td className="px-2 py-2 text-right font-mono text-sky-600 font-semibold">{row.settled}</td>
                      <td className="px-2 py-2 text-[10px] text-[var(--text-muted)] truncate max-w-[280px]">
                        {(row.warnings || []).join("; ") || (row.skipped || []).slice(0, 1).map((s) => s.reason).join("") || "Không có cảnh báo"}
                      </td>
                    </tr>
                  ))}
                  {!runs.length && (
                    <tr>
                      <td className="px-2 py-4 text-center text-[var(--text-muted)]" colSpan={7}>Chưa ghi nhận lượt chạy nào.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
