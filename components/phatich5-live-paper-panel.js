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
  X,
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

function TradesTable({ rows, onSelectDetails }) {
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
            <th className="px-3 py-2 text-center">Detail</th>
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
              <td className="px-3 py-2 text-center">
                <button
                  onClick={() => onSelectDetails(row)}
                  className="px-2 py-0.5 border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[10px] hover:bg-[var(--border-color)] transition-colors rounded"
                >
                  Detail
                </button>
              </td>
            </tr>
          )) : (
            <tr>
              <td className="px-3 py-4 text-[var(--text-muted)]" colSpan={11}>No paper trades recorded yet.</td>
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

function MathDetailModal({ trade, onClose }) {
  if (!trade) return null;
  const d = trade.predictionDetails;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[var(--bg-main)] border border-[var(--border-color)] shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto flex flex-col p-6 space-y-6 animate-in fade-in zoom-in-95 duration-150 rounded">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-3">
          <div>
            <h3 className="text-[14px] font-bold text-[var(--text-main)]">Chi tiết tính toán tỷ lệ đặt cược & xác suất</h3>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{trade.title || trade.marketSlug}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[var(--bg-secondary)] rounded transition-colors text-[var(--text-muted)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        {!d ? (
          <div className="py-8 text-center space-y-3">
            <div className="flex justify-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
            </div>
            <p className="text-[12px] font-semibold text-[var(--text-main)]">Không tìm thấy tham số chi tiết tại thời điểm mở vị thế</p>
            <p className="text-[11px] text-[var(--text-muted)] max-w-md mx-auto">
              Lịch sử chi tiết (bao gồm các trọng số HMM, k-NN và Kelly) chỉ khả dụng với các lệnh paper trade mới được mở sau ngày 22/06/2026.
            </p>
          </div>
        ) : (
          <div className="space-y-6 text-[11px] text-[var(--text-main)] leading-relaxed">
            {/* Section 1: Trade Context */}
            <div className="bg-[var(--bg-secondary)] p-3 border border-[var(--border-color)] space-y-1 rounded">
              <h4 className="font-bold uppercase text-[10px] text-[var(--text-muted)]">1. Thông tin vị thế</h4>
              <div className="grid grid-cols-2 gap-y-1 gap-x-4">
                <div><span className="text-[var(--text-muted)]">Mã thị trường:</span> <span className="font-mono font-semibold">{trade.marketSlug}</span></div>
                <div><span className="text-[var(--text-muted)]">Khung thời gian:</span> {trade.horizon} ({trade.frame})</div>
                <div><span className="text-[var(--text-muted)]">Vị thế dự báo:</span> <span className="font-semibold text-emerald-600">{trade.side}</span></div>
                <div><span className="text-[var(--text-muted)]">Thời gian mở:</span> {fmtTime(trade.openedAt)}</div>
              </div>
            </div>

            {/* Section 2: Blending Probabilities */}
            <div className="space-y-3">
              <h4 className="font-bold uppercase text-[10px] text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1">2. Xác suất UP cuối cùng (P_Up)</h4>
              <p className="text-[10px] text-[var(--text-muted)] mb-2">
                Để đưa ra xác suất dự đoán sau cùng P_Up, mô hình phối hợp 4 thành phần xác suất khác nhau nhằm giảm thiểu sai số khi tập mẫu nhỏ thông qua cơ chế co hẹp (Beta-Mean Shrinkage):
              </p>

              <div className="overflow-x-auto">
                <table className="w-full text-[10px] border border-[var(--border-color)]">
                  <thead>
                    <tr className="bg-[var(--bg-secondary)] border-b border-[var(--border-color)] text-left">
                      <th className="px-2 py-1.5">Thành phần</th>
                      <th className="px-2 py-1.5 text-right">Xác suất (P)</th>
                      <th className="px-2 py-1.5 text-right">Số mẫu (N)</th>
                      <th className="px-2 py-1.5 text-right">Độ tin cậy (R)</th>
                      <th className="px-2 py-1.5 text-right">Trọng số (W)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-[var(--border-color)]/70">
                      <td className="px-2 py-1.5 font-semibold">1. Cơ sở (Baseline)</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.baselineP, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{d.sampleSize ?? "N/A"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">1.0000</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.baseWeight, 4)}</td>
                    </tr>
                    <tr className="border-b border-[var(--border-color)]/70">
                      <td className="px-2 py-1.5 font-semibold">2. Trạng thái HMM (State)</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.stateP, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{d.stateCount ?? "N/A"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.stateReliability, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.weights?.state, 4)}</td>
                    </tr>
                    <tr className="border-b border-[var(--border-color)]/70">
                      <td className="px-2 py-1.5 font-semibold">3. Khóa Xu hướng (Trend)</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.trendP, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{d.trendCount ?? "N/A"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.trendReliability, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.weights?.trend, 4)}</td>
                    </tr>
                    <tr className="border-b border-[var(--border-color)]/70">
                      <td className="px-2 py-1.5 font-semibold">4. Láng giềng (k-NN)</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.neighborP, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">k-NN</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.neighborReliability, 4)}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{fmtNum(d.weights?.neighbor, 4)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="space-y-1.5 text-[10px] text-[var(--text-muted)] bg-[var(--bg-secondary)]/50 p-2.5 border border-[var(--border-color)]/70 rounded">
                <div>• Khóa xu hướng HMM hiện tại: <span className="font-mono bg-[var(--bg-secondary)] px-1 py-0.5 border border-[var(--border-color)] rounded">{d.trendKey || "N/A"}</span></div>
                {d.features ? (
                  <div>• Các chỉ số đặc trưng ngắn hạn: Khoảng cách strike = {fmtNum(d.features.distanceToStrike * 100, 4)}% | Price Return 24h = {fmtNum(d.features.priceRet24 * 100, 4)}%</div>
                ) : null}
                <div>• Công thức tin cậy HMM State: R_state = N_state / (N_state + 12) = {fmtNum(d.stateReliability, 4)}</div>
                <div>• Công thức tin cậy Xu hướng: R_trend = N_trend / (N_trend + 24) = {fmtNum(d.trendReliability, 4)}</div>
                <div>• Công thức tin cậy Láng giềng: R_neighbor = K_neighbor / (K_neighbor + 24) = {fmtNum(d.neighborReliability, 4)}</div>
                <div>• Trọng số gán cố định: W_state = 0.5 * R_state | W_neighbor = 0.3 * R_neighbor | W_trend = 0.2 * R_trend</div>
                <div>• Trọng số cơ sở: W_baseline = max(0.15, 1 - W_state - W_neighbor - W_trend)</div>
              </div>

              <div className="p-3 border border-dashed border-[var(--border-color)] bg-[var(--bg-main)] rounded">
                <div className="font-semibold text-[12px]">Toán học tổng hợp:</div>
                <div className="mt-1 font-mono text-[10px] break-all bg-[var(--bg-secondary)] p-2 rounded">
                  P_Up_raw = (W_state * P_state + W_neighbor * P_neighbor + W_trend * P_trend + W_baseline * P_baseline) / W_sum
                  <br />
                  P_Up_raw = ({fmtNum(d.weights?.state, 4)} * {fmtNum(d.stateP, 4)} + {fmtNum(d.weights?.neighbor, 4)} * {fmtNum(d.neighborP, 4)} + {fmtNum(d.weights?.trend, 4)} * {fmtNum(d.trendP, 4)} + {fmtNum(d.baseWeight, 4)} * {fmtNum(d.baselineP, 4)}) / {fmtNum(d.weightSum, 4)}
                  <br />
                  P_Up_raw = {fmtNum((d.weights?.state * d.stateP + d.weights?.neighbor * d.neighborP + d.weights?.trend * d.trendP + d.baseWeight * d.baselineP) / (d.weightSum || 1), 4)}
                </div>
                <div className="mt-2 flex justify-between text-[11px]">
                  <span>Xác suất UP cuối cùng (được clamp [0.03, 0.97]):</span>
                  <span className="font-bold text-emerald-600">{fmtPct(d.pUp)}</span>
                </div>
                <div className="flex justify-between text-[11px] mt-0.5">
                  <span>Xác suất DOWN cuối cùng:</span>
                  <span className="font-bold text-rose-600">{fmtPct(d.pDown)}</span>
                </div>
              </div>
            </div>

            {/* Section 3: Cost Calculations */}
            <div className="space-y-2">
              <h4 className="font-bold uppercase text-[10px] text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1">3. Chi phí thực hiện (Cost)</h4>
              <p className="text-[10px] text-[var(--text-muted)]">
                Chi phí mua cổ phiếu bao gồm giá khớp thị trường (implied price) cộng với phí giao dịch taker.
              </p>
              <div className="p-3 border border-[var(--border-color)] bg-[var(--bg-secondary)]/30 space-y-1 rounded">
                <div className="flex justify-between">
                  <span>Xác suất ngầm định (Implied Probability / Giá thị trường):</span>
                  <span className="font-mono font-semibold">{fmtNum(d.impliedUp, 4)} ({fmtPct(d.impliedUp)})</span>
                </div>
                <div className="flex justify-between">
                  <span>Phí Taker (Taker Fee Rate):</span>
                  <span className="font-mono">{fmtPct(d.feeRate)}</span>
                </div>
                <div className="flex justify-between text-[10px] text-[var(--text-muted)] italic pl-3">
                  <span>Taker Fee Per Share = FeeRate * Price * (1 - Price):</span>
                  <span>{fmtNum(d.feeRate * d.impliedUp * (1 - d.impliedUp), 4)} USD</span>
                </div>
                <div className="border-t border-[var(--border-color)]/50 my-1"></div>
                <div className="flex justify-between font-semibold">
                  <span>Chi phí mở vị thế sau cùng (Cost):</span>
                  <span className="font-mono text-[12px]">{fmtNum(d.cost, 4)} USD</span>
                </div>
              </div>
            </div>

            {/* Section 4: Edge Calculations */}
            <div className="space-y-2">
              <h4 className="font-bold uppercase text-[10px] text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1">4. Lợi thế biên (Edge)</h4>
              <p className="text-[10px] text-[var(--text-muted)]">
                Lợi thế biên là khoảng cách chênh lệch giữa xác suất dự báo của mô hình (P_fair) và chi phí thực tế phải chi trả.
              </p>
              <div className="p-3 border border-[var(--border-color)] bg-[var(--bg-secondary)]/30 space-y-1 rounded">
                <div className="flex justify-between">
                  <span>Xác suất dự báo mô hình cho vị thế {d.side} (P_fair):</span>
                  <span className="font-mono font-semibold">{fmtPct(d.side === "UP" ? d.pUp : d.pDown)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Chi phí phải trả cho vị thế {d.side} (Cost):</span>
                  <span className="font-mono">{fmtNum(d.cost, 4)}</span>
                </div>
                <div className="border-t border-[var(--border-color)]/50 my-1"></div>
                <div className="flex justify-between font-semibold text-[12px]">
                  <span>Lợi thế biên (Edge = P_fair - Cost):</span>
                  <span className={`font-mono ${d.edge >= 0.035 ? "text-emerald-600" : "text-rose-600"}`}>
                    {fmtPct(d.edge)}
                  </span>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-1">
                  {d.edge >= 0.035 ? (
                    <span className="text-emerald-700">✓ Lợi thế biên đạt ngưỡng tối thiểu (minEdge = 3.50%). Đủ điều kiện giao dịch.</span>
                  ) : (
                    <span className="text-rose-700">✗ Lợi thế biên nhỏ hơn ngưỡng tối thiểu (minEdge = 3.50%). Lệnh sẽ bị bỏ qua.</span>
                  )}
                </div>
              </div>
            </div>

            {/* Section 5: Kelly Sizing */}
            <div className="space-y-2">
              <h4 className="font-bold uppercase text-[10px] text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1">5. Tỷ lệ đặt cược Kelly (Kelly Sizing)</h4>
              <p className="text-[10px] text-[var(--text-muted)]">
                Công thức quản lý vốn Kelly xác định tỷ lệ phân bổ tài khoản tối ưu dựa trên lợi thế biên và tỷ suất thanh toán (payout odds):
              </p>
              <div className="p-3 border border-[var(--border-color)] bg-[var(--bg-secondary)]/30 space-y-1 rounded">
                <div className="flex justify-between">
                  <span>Xác suất thắng (p):</span>
                  <span className="font-mono">{fmtPct(d.side === "UP" ? d.pUp : d.pDown)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tỷ suất thắng ròng (b = (1 - Cost) / Cost):</span>
                  <span className="font-mono font-semibold">{fmtNum((1 - d.cost) / d.cost, 4)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tỷ lệ Kelly chuẩn (Kelly = (b * p - (1-p)) / b):</span>
                  <span className="font-mono">{fmtPct(d.kelly)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Kelly giảm thiểu rủi ro (Kelly * 0.25):</span>
                  <span className="font-mono">{fmtPct(d.kelly * 0.25)}</span>
                </div>
                <div className="border-t border-[var(--border-color)]/50 my-1"></div>
                <div className="flex justify-between font-semibold text-[12px]">
                  <span>Tỷ lệ đặt cược cuối cùng (Sizing):</span>
                  <span className="font-mono text-emerald-600">{fmtPct(d.positionFraction)}</span>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-1">
                  • Quy mô đặt cược tối đa được giới hạn ở mức 5.00% (maxPositionFraction = 5%) để tránh rủi ro phá sản.
                  <br />
                  • Quy mô phân bổ thực tế cho lệnh này: <span className="font-bold">{fmtPct(d.positionFraction)}</span> trên tổng số vốn.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end border-t border-[var(--border-color)] pt-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[11px] font-semibold hover:bg-[var(--border-color)] transition-colors rounded"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Phatich5LivePaperPanel() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [selectedTrade, setSelectedTrade] = useState(null);

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

        <div className="border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-3 rounded">
          <div className="flex items-center gap-2 text-[12px] font-semibold">
            <Database className="h-3.5 w-3.5" />
            <span>Storage: {store.kind || "N/A"}</span>
          </div>
          <div className="mt-1 break-all text-[10px] text-[var(--text-muted)]">{store.pathname || "N/A"}</div>
          {store.warning ? (
            <div className="mt-2 flex items-start gap-2 border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 rounded">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{store.warning}</span>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              onClick={load}
              disabled={loading || running}
              className="inline-flex h-8 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[11px] font-semibold rounded hover:bg-[var(--border-color)] transition-colors"
            >
              {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              Refresh
            </button>
            <button
              onClick={runNow}
              disabled={running || loading}
              className="inline-flex h-8 items-center justify-center gap-2 border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 text-[11px] font-semibold rounded hover:bg-[var(--border-color)] transition-colors"
            >
              {running ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run now
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[12px] text-[var(--danger-text)] rounded">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <TradesTable rows={snapshot?.trades || []} onSelectDetails={setSelectedTrade} />
      <RunsTable rows={snapshot?.runs || []} />

      {selectedTrade && (
        <MathDetailModal trade={selectedTrade} onClose={() => setSelectedTrade(null)} />
      )}
    </div>
  );
}
