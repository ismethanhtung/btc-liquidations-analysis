"use client";

import { useState } from "react";
import {
  BookOpen,
  Calculator,
  HelpCircle,
  TrendingUp,
  Percent,
  ShieldCheck,
  Scale,
  ArrowRight,
  Info,
  Settings,
  Cpu,
  Database,
  Network,
  Play
} from "lucide-react";

// Formatter utilities
const fmtPct = (v) => `${(v * 100).toFixed(2)}%`;
const fmtNum = (v, dec = 3) => Number(v).toFixed(dec);

export default function PolyTutorPage() {
  const [activeTab, setActiveTab] = useState("calculator");
  const [activeStep, setActiveStep] = useState(1);

  // State variables for the Interactive Playground
  const [startPrice, setStartPrice] = useState(65000);
  const [entryPrice, setEntryPrice] = useState(65500);
  const [pUp, setPUp] = useState(0.62); // Model prediction probability
  const [impliedUp, setImpliedUp] = useState(0.55); // Market mid probability
  const [feeRate, setFeeRate] = useState(0.07); // 7%
  const [minEdge, setMinEdge] = useState(0.035); // 3.5%
  const [minStateSamples, setMinStateSamples] = useState(12);
  const [stateSamples, setStateSamples] = useState(25);
  const [slippageCents, setSlippageCents] = useState(0.005); // 0.5 cents

  // Calculations
  const distanceToStrike = (entryPrice - startPrice) / Math.max(1e-9, startPrice);
  const pDown = 1 - pUp;

  // Ask Prices (market odds + slippage)
  const upAsk = Math.min(0.99, impliedUp + slippageCents);
  const downAsk = Math.min(0.99, (1 - impliedUp) + slippageCents);

  // Taker Fee Per Share = feeRate * price * (1 - price)
  const getTakerFee = (price) => Math.max(0, feeRate * price * (1 - price));
  const upFee = getTakerFee(upAsk);
  const downFee = getTakerFee(downAsk);

  // Executable Cost = Raw Ask + Fee
  const upCost = Math.min(0.999, Math.max(0.001, upAsk + upFee));
  const downCost = Math.min(0.999, Math.max(0.001, downAsk + downFee));

  // Edge = p - Cost
  const edgeUp = pUp - upCost;
  const edgeDown = pDown - downCost;

  // Decision Logic
  let action = "SKIP";
  let side = "NONE";
  let edge = 0;
  let cost = 0;
  let reason = "";

  if (stateSamples < minStateSamples) {
    action = "SKIP";
    side = "NONE";
    reason = `Số mẫu cùng trạng thái (${stateSamples}) nhỏ hơn mức tối thiểu yêu cầu (${minStateSamples}). Không đủ tin cậy để giao dịch.`;
  } else if (edgeUp >= edgeDown && edgeUp >= minEdge) {
    action = "BUY_UP";
    side = "UP";
    edge = edgeUp;
    cost = upCost;
    reason = `Lợi thế chiều UP (${fmtPct(edgeUp)}) lớn hơn chiều DOWN và vượt qua mức tối thiểu (${fmtPct(minEdge)}). Đề xuất mua UP.`;
  } else if (edgeDown > edgeUp && edgeDown >= minEdge) {
    action = "BUY_DOWN";
    side = "DOWN";
    edge = edgeDown;
    cost = downCost;
    reason = `Lợi thế chiều DOWN (${fmtPct(edgeDown)}) lớn hơn chiều UP và vượt qua mức tối thiểu (${fmtPct(minEdge)}). Đề xuất mua DOWN.`;
  } else {
    action = "SKIP";
    side = "NONE";
    reason = `Lợi thế cao nhất (UP: ${fmtPct(edgeUp)}, DOWN: ${fmtPct(edgeDown)}) đều nhỏ hơn mức tối thiểu yêu cầu (${fmtPct(minEdge)}). Không giao dịch.`;
  }

  // Kelly Sizing
  const winP = side === "UP" ? pUp : side === "DOWN" ? pDown : 0;
  const netOdds = cost > 0 && cost < 1 ? (1 - cost) / cost : 0;
  const kelly = netOdds > 0 ? (netOdds * winP - (1 - winP)) / netOdds : 0;
  const clampedKelly = Math.max(0, Math.min(1, kelly));
  const positionFraction = clampedKelly * 0.25; // 1/4 Kelly
  const positionCap = Math.min(0.05, positionFraction); // Cap 5%

  // Max Bid (executable cost must equal pWin - minEdge)
  const maxUpBid = Math.min(0.999, Math.max(0.001, pUp - minEdge - getTakerFee(Math.max(0.01, pUp))));
  const maxDownBid = Math.min(0.999, Math.max(0.001, pDown - minEdge - getTakerFee(Math.max(0.01, pDown))));
  const maxBid = side === "UP" ? maxUpBid : side === "DOWN" ? maxDownBid : null;

  // Pipeline step descriptions
  const pipelineSteps = [
    {
      id: 1,
      title: "Bước 1: Khởi tạo Trạng thái HMM (Regime Timeline)",
      icon: Cpu,
      goal: "Phân cụm chuỗi thời gian nến lịch sử BTC để nhận diện các trạng thái thị trường (Regime) riêng biệt.",
      inputs: [
        "Dữ liệu nến lịch sử BTCUSDT từ Binance (Giá đóng cửa, khối lượng, Open Interest, Funding rate, CVD).",
        "Số trạng thái mong muốn (K) và số lần lặp tối đa của mô hình HMM."
      ],
      processing: [
        "Tính toán các đặc trưng tỷ suất sinh lời và biến động thực tế qua các cửa sổ 24 bars và 72 bars.",
        "Huấn luyện mô hình Hidden Markov Model (HMM) để phân loại từng nến dữ liệu thành một trong các trạng thái từ 0 đến K-1.",
        "Mỗi nến sau xử lý được gán một nhãn trạng thái cụ thể (ví dụ: State 1) kèm theo độ tin cậy (Confidence).",
        "Tính toán thời lượng kéo dài liên tục của trạng thái hiện tại (stateDurationHours) để đo lường độ bền vững."
      ],
      basis: "Thị trường tài chính chuyển động qua các chu kỳ (Regime) lặp lại có hành vi giá tương tự nhau (ví dụ: xu hướng tăng biến động thấp, xu hướng giảm hoảng loạn). Việc phân nhóm theo Regime giúp mô hình so sánh và dự báo xác suất thắng chuẩn xác hơn trong từng điều kiện thị trường cụ thể.",
      example: "Nến lúc 08:00 AM ngày 22/06/2026 có giá đóng cửa BTC là $65,000, được mô hình HMM nhận diện thuộc 'State 2' (Đại diện cho trạng thái: Downtrend biến động mạnh) với độ tin cậy 94%."
    },
    {
      id: 2,
      title: "Bước 2: Quét & Thu thập Sự kiện Polymarket (Gamma API)",
      icon: Database,
      goal: "Quét và phát hiện các hợp đồng dự đoán BTC Up/Down lịch sử và hiện tại từ cơ sở dữ liệu Polymarket.",
      inputs: [
        "API Tìm kiếm Công khai của Polymarket Gamma (Gamma API).",
        "Từ khóa tìm kiếm (Ví dụ: 'Bitcoin Up or Down daily' hoặc 'Bitcoin Up or Down 4 hour')."
      ],
      processing: [
        "Gửi yêu cầu HTTP GET tới Gamma API `/public-search` để quét tất cả các sự kiện khớp từ khóa.",
        "Lọc các sự kiện có cấu trúc hợp lệ (chứa đầy đủ mã token UP, DOWN, thời gian bắt đầu StartDate và kết thúc EndDate).",
        "Quy đổi thời gian của sự kiện sang Milliseconds để xác định chính xác cửa sổ giao dịch (Market Window) dài 24 giờ (Daily) hoặc 4 giờ (4H)."
      ],
      basis: "Gamma API là cổng thông tin cấu trúc của Polymarket. Nó cung cấp mã nhận diện duy nhất (Token ID) cho các chiều UP/DOWN của hợp đồng, là cơ sở để liên kết với dữ liệu sổ lệnh và lịch sử giá sau này.",
      example: "Quét được sự kiện 'Bitcoin Up or Down on June 22, 2026' có StartMs tương đương 07:00 AM ngày 22/06, EndMs tương đương 07:00 AM ngày 23/06. Token UP ID là '12345', Token DOWN ID là '67890'."
    },
    {
      id: 3,
      title: "Bước 3: Tải Dữ liệu Giá & Sổ lệnh Thực tế (CLOB API)",
      icon: Network,
      goal: "Xác định giá giao dịch thực tế hoặc giá sổ lệnh của các token quyền chọn nhị phân tại thời điểm vào lệnh.",
      inputs: [
        "API Sổ lệnh tập trung của Polymarket (CLOB API).",
        "Token ID của chiều UP và DOWN thu thập từ Bước 2.",
        "Thời điểm vào lệnh dự kiến (Entry Time)."
      ],
      processing: [
        "Nếu là Backtest lịch sử: Hệ thống tải lịch sử giá giao dịch khớp lệnh (`prices-history`) của token UP xung quanh thời điểm EntryMs. Lấy giá giao dịch gần nhất làm xác suất ngầm định của thị trường (Implied Odds).",
        "Nếu là Giao dịch Live: Hệ thống truy vấn trực tiếp sổ lệnh hiện tại (`book`) của cả hai token UP/DOWN để lấy giá bán tốt nhất (Best Ask) và giá mua tốt nhất (Best Bid) đang treo trên sàn."
      ],
      basis: "Giá của một token dao động từ $0.00 đến $1.00 đại diện trực tiếp cho xác suất ngầm định của đám đông (Implied Probability). Việc tải giá từ CLOB giúp ta biết chính xác chi phí vốn tối thiểu phải bỏ ra để mua 1 share quyền chọn.",
      example: "Tại thời điểm vào lệnh lúc 08:00 AM (1 giờ sau khi thị trường mở cửa), giá khớp gần nhất của token UP trên CLOB lịch sử là $0.55. Nghĩa là đám đông đang kỳ vọng cơ hội BTC tăng giá là 55%."
    },
    {
      id: 4,
      title: "Bước 4: Chạy Backtest Cuốn Chiếu (Walk-Forward Backtest)",
      icon: Scale,
      goal: "Mô phỏng quy trình giao dịch lịch sử theo thời gian thực để đo lường hiệu suất của hệ thống mà không bị rò rỉ dữ liệu.",
      inputs: [
        "Danh sách sự kiện lịch sử sắp xếp theo trình tự thời gian.",
        "Thông số cấu hình (Min Edge, Min State Samples, Slippage, Fee Rate)."
      ],
      processing: [
        "Hệ thống duyệt qua từng sự kiện i trong lịch sử theo thứ tự thời gian.",
        "Đối với sự kiện i, tập dữ liệu huấn luyện (Training Set) chỉ bao gồm các sự kiện từ 0 đến i-1 đã resolved xong trước thời điểm vào lệnh của sự kiện i.",
        "Bước 4.1 (Mô hình trộn): Huấn luyện mô hình và tính xác suất pUp cho sự kiện i từ tập huấn luyện (phối hợp Baseline, HMM State, Trend Key và KNN láng giềng). Xem chi tiết mô tả thuật toán toán học phía dưới.",
        "Bước 4.2 (Tính chi phí): Lấy giá thô CLOB tại thời điểm vào lệnh của sự kiện i, cộng thêm phí taker sàn và trượt giá để tính Cost UP và Cost DOWN thực tế.",
        "Bước 4.3 (Quyết định): So sánh Edge = pUp - Cost. Nếu Edge >= minEdge và số lượng mẫu huấn luyện cùng trạng thái >= minStateSamples, ghi nhận giao dịch mua tương ứng.",
        "Bước 4.4 (Giải quyết): Khi sự kiện kết thúc, đối chiếu giá đóng cửa thực tế trên Binance để tính PnL thực tế. Ghi nhận hiệu suất vào lệnh rồi thêm sự kiện i vào tập dữ liệu huấn luyện cho sự kiện i+1."
      ],
      basis: "Giao dịch thực tế là một chiều tuyến tính từ quá khứ đến tương lai. Quy trình Backtest cuốn chiếu (Walk-forward / Expanding window) đảm bảo mô hình không bao giờ sử dụng dữ liệu tương lai để dự đoán quá khứ, loại bỏ hoàn toàn hiện tượng quá khớp (Overfitting) và rò rỉ dữ liệu (Data Leakage).",
      example: "Khi backtest sự kiện ngày 22/06/2026, mô hình chỉ được phép học từ các sự kiện đã kết thúc từ ngày 21/06 trở về trước. Mô hình dự báo pUp = 62%, giá mua thực tế sau phí là 54%, Edge đạt 8% >= 3.5%. Đề xuất mua UP. Thực tế BTC tăng, giao dịch thắng nhận về $1.00 cho mỗi share, mang lại PnL ròng +0.46 $."
    },
    {
      id: 5,
      title: "Bước 5: Đưa Ra Khuyến Nghị Trực Tiếp (Live Recommendation)",
      icon: Play,
      goal: "Đưa ra hành động mua bán, giá thầu tối đa và kích thước đi tiền tối ưu theo thời gian thực cho các hợp đồng đang mở trên sàn.",
      inputs: [
        "Toàn bộ tập dữ liệu sự kiện lịch sử đã resolved (làm tập huấn luyện).",
        "Trạng thái HMM hiện tại từ nến Binance mới nhất vừa đóng.",
        "Sổ lệnh trực tiếp (LOB) của sự kiện đang mở trên Polymarket."
      ],
      processing: [
        "Hệ thống lấy trạng thái HMM hiện tại của BTC (ví dụ: State 0).",
        "Chạy mô hình trộn (Blended Model) trên toàn bộ dữ liệu lịch sử để dự đoán xác suất UP (pUp) cho nến sự kiện hiện tại.",
        "Truy vấn API CLOB `/book` để lấy giá Best Ask thực tế của cả token UP và DOWN hiện tại. Cộng thêm phí taker sàn để tính Cost UP và Cost DOWN thực tế.",
        "Tính toán Lợi thế (Edge) của hai chiều. Nếu Edge chiều nào đạt tối ưu và vượt qua `minEdge`, hệ thống sẽ đưa ra khuyến nghị BUY tương ứng.",
        "Tính toán giá thầu tối đa chấp nhận đặt mua trên sàn (Max Bid) và quy mô vốn đề xuất theo tiêu chuẩn Kelly (Fractional Kelly cap 5%)."
      ],
      basis: "Kết hợp mô hình tĩnh đã được tối ưu hóa từ dữ liệu lịch sử với dữ liệu sổ lệnh động thời gian thực của sàn Polymarket, giúp người dùng đưa ra quyết định giao dịch chính xác nhất tại thời điểm hiện tại.",
      example: "Hợp đồng Daily hôm nay đang chạy. Giá Best Ask của token UP hiện tại là $0.52. Mô hình dự đoán pUp là 62%. Chi phí sau phí taker là $0.537. Edge đạt 8.3% >= 3.5%. Đề xuất hành động: BUY_UP với giá thầu đặt mua tối đa không quá $0.568. Đi tiền 1.5% tài khoản."
    }
  ];

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-10">
      {/* Header */}
      <div className="panel-shell">
        <div className="panel-header px-5 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-semibold text-[var(--text-main)] flex items-center gap-2">
              <BookOpen className="h-6 w-6 text-[var(--color-accent)]" /> Poly Tutor
            </h1>
            <p className="text-[12px] text-[var(--text-muted)] mt-1">
              Trang hướng dẫn trực quan hóa cách tính toán và logic giao dịch của tab Polymarket trong Regime Routing (Short-term).
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab("calculator")}
              className={`px-3 py-1.5 text-[12px] font-semibold border flex items-center gap-1.5 transition-all ${
                activeTab === "calculator"
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--bg-main)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-main)]"
              }`}
            >
              <Calculator className="h-4 w-4" /> Trình Tính Toán Tương Tác
            </button>
            <button
              onClick={() => setActiveTab("pipeline")}
              className={`px-3 py-1.5 text-[12px] font-semibold border flex items-center gap-1.5 transition-all ${
                activeTab === "pipeline"
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--bg-main)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-main)]"
              }`}
            >
              <TrendingUp className="h-4 w-4" /> Luồng Quy Trình A-Z
            </button>
            <button
              onClick={() => setActiveTab("theory")}
              className={`px-3 py-1.5 text-[12px] font-semibold border flex items-center gap-1.5 transition-all ${
                activeTab === "theory"
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-[var(--bg-main)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-main)]"
              }`}
            >
              <HelpCircle className="h-4 w-4" /> Tài Liệu Lý Thuyết
            </button>
          </div>
        </div>
      </div>

      {activeTab === "calculator" && (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Column 1: Inputs */}
          <div className="lg:col-span-5 space-y-4">
            <div className="panel-shell">
              <div className="panel-header px-4 py-3 font-semibold text-[13px] flex items-center gap-1.5">
                <Settings className="h-4 w-4 text-[var(--color-accent)]" />
                Tham Số Đầu Vào (Input Parameters)
              </div>
              <div className="p-4 space-y-4">
                {/* Bitcoin Prices */}
                <div>
                  <h3 className="text-[11px] font-bold uppercase text-[var(--text-muted)] mb-2">Giá BTC (Binance)</h3>
                  <div className="grid gap-2 grid-cols-2">
                    <label>
                      <span className="text-[10px] text-[var(--text-muted)]">Giá lúc mở cửa (Start Price)</span>
                      <input
                        type="number"
                        className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                        value={startPrice}
                        onChange={(e) => setStartPrice(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      <span className="text-[10px] text-[var(--text-muted)]">Giá lúc vào lệnh (Entry Price)</span>
                      <input
                        type="number"
                        className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                        value={entryPrice}
                        onChange={(e) => setEntryPrice(Number(e.target.value))}
                      />
                    </label>
                  </div>
                </div>

                <hr className="border-[var(--border-color)]" />

                {/* Probabilities */}
                <div>
                  <h3 className="text-[11px] font-bold uppercase text-[var(--text-muted)] mb-2">Xác suất & Odds</h3>
                  <div className="grid gap-2 grid-cols-2">
                    <label>
                      <span className="text-[10px] text-[var(--text-muted)]">Xác suất UP mô hình (pUp)</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="1"
                        className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                        value={pUp}
                        onChange={(e) => setPUp(Math.min(1, Math.max(0, Number(e.target.value))))}
                      />
                      <span className="text-[9px] text-[var(--text-muted)] block mt-0.5">pDown sẽ là: {fmtPct(1 - pUp)}</span>
                    </label>
                    <label>
                      <span className="text-[10px] text-[var(--text-muted)]">Xác suất thị trường (Implied Up)</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="1"
                        className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                        value={impliedUp}
                        onChange={(e) => setImpliedUp(Math.min(1, Math.max(0, Number(e.target.value))))}
                      />
                      <span className="text-[9px] text-[var(--text-muted)] block mt-0.5">Giá thô UP: {fmtNum(impliedUp, 3)} $</span>
                    </label>
                  </div>
                </div>

                <hr className="border-[var(--border-color)]" />

                {/* Trading Settings */}
                <div>
                  <h3 className="text-[11px] font-bold uppercase text-[var(--text-muted)] mb-2">Cấu Hình Giao Dịch</h3>
                  <div className="space-y-3">
                    <div className="grid gap-2 grid-cols-2">
                      <label>
                        <span className="text-[10px] text-[var(--text-muted)]">Lợi thế tối thiểu (Min Edge %)</span>
                        <input
                          type="number"
                          step="0.1"
                          className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                          value={minEdge * 100}
                          onChange={(e) => setMinEdge(Number(e.target.value) / 100)}
                        />
                      </label>
                      <label>
                        <span className="text-[10px] text-[var(--text-muted)]">Tỷ lệ phí sàn (Fee Rate %)</span>
                        <input
                          type="number"
                          step="0.5"
                          className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                          value={feeRate * 100}
                          onChange={(e) => setFeeRate(Number(e.target.value) / 100)}
                        />
                      </label>
                    </div>

                    <div className="grid gap-2 grid-cols-2">
                      <label>
                        <span className="text-[10px] text-[var(--text-muted)]">Mẫu của Regime (State Sample)</span>
                        <input
                          type="number"
                          className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                          value={stateSamples}
                          onChange={(e) => setStateSamples(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        <span className="text-[10px] text-[var(--text-muted)]">Mẫu tối thiểu (Min State Sample)</span>
                        <input
                          type="number"
                          className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                          value={minStateSamples}
                          onChange={(e) => setMinStateSamples(Number(e.target.value))}
                        />
                      </label>
                    </div>

                    <label className="block">
                      <span className="text-[10px] text-[var(--text-muted)]">Trượt giá ước tính (Slippage Cents)</span>
                      <input
                        type="number"
                        step="0.001"
                        className="input-ui h-9 w-full px-2 text-[12px] mt-1"
                        value={slippageCents}
                        onChange={(e) => setSlippageCents(Number(e.target.value))}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Column 2: Outputs & Steps */}
          <div className="lg:col-span-7 space-y-4">
            {/* Quick Result Panel */}
            <div className="panel-shell border-l-4 border-l-[var(--color-accent)]">
              <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase font-bold text-[var(--text-muted)]">Kết Quả Đề Xuất (Decision)</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className={`px-3 py-1.5 text-[14px] font-bold border rounded ${
                        action === "BUY_UP"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                          : action === "BUY_DOWN"
                          ? "bg-rose-50 text-rose-700 border-rose-300"
                          : "bg-gray-50 text-gray-700 border-gray-300"
                      }`}
                    >
                      {action}
                    </span>
                    {action !== "SKIP" && (
                      <span className="text-[12px] font-semibold text-[var(--text-main)]">
                        Quy mô vị thế đề xuất: <span className="text-[14px] font-bold text-[var(--color-accent)]">{fmtPct(positionCap)}</span>
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] mt-2 italic">{reason}</p>
                </div>
                {action !== "SKIP" && (
                  <div className="bg-[var(--bg-secondary)] p-3 border border-[var(--border-color)] text-right">
                    <div className="text-[9px] uppercase text-[var(--text-muted)] font-semibold">Giá đặt tối đa (Max Bid)</div>
                    <div className="text-[20px] font-bold text-[var(--text-main)] mt-0.5">{maxBid !== null ? fmtNum(maxBid, 3) : "N/A"} $</div>
                    <div className="text-[9px] text-[var(--text-muted)] mt-0.5">Đặt mua thô trên sàn &lt;= mốc này</div>
                  </div>
                )}
              </div>
            </div>

            {/* Calculations Breakdown (Step by Step) */}
            <div className="panel-shell">
              <div className="panel-header px-4 py-3 font-semibold text-[13px] flex items-center gap-1.5">
                <Scale className="h-4 w-4 text-[var(--color-accent)]" /> Chi Tiết Các Bước Tính Toán
              </div>
              <div className="p-4 space-y-4 text-[11px]">
                {/* Step 1: Distance to strike */}
                <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-1">
                  <div className="font-semibold text-[var(--text-main)] flex items-center gap-1">
                    <span className="bg-[var(--color-accent)] text-white h-4 w-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold">1</span>
                    Bước 1: Tính khoảng cách tới mức thực hiện (Distance to Strike)
                  </div>
                  <div className="text-[var(--text-muted)]">Công thức:</div>
                  <div className="flex items-center gap-2 font-mono text-[11px] my-1 bg-[var(--bg-main)] p-2 border">
                    <span>distanceToStrike = </span>
                    <div className="flex flex-col items-center">
                      <span className="border-b px-2 pb-0.5">Price<sub>Entry</sub> - Price<sub>Start</sub></span>
                      <span className="pt-0.5">Price<sub>Start</sub></span>
                    </div>
                  </div>
                  <p className="mt-1 font-sans text-[var(--text-main)]">
                    Thay số thực tế: <span className="font-mono font-semibold">({entryPrice} - {startPrice}) / {startPrice} = {fmtPct(distanceToStrike)}</span>
                  </p>
                </div>

                {/* Step 2: Executable Cost calculation */}
                <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-2">
                  <div className="font-semibold text-[var(--text-main)] flex items-center gap-1">
                    <span className="bg-[var(--color-accent)] text-white h-4 w-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold">2</span>
                    Bước 2: Tính toán Chi Phí Thực Tế (Executable Cost) sau trượt giá và phí sàn
                  </div>
                  <div className="text-[var(--text-muted)]">Công thức phí Polymarket:</div>
                  <div className="font-mono text-[11px] my-1 bg-[var(--bg-main)] p-2.5 border">
                    Fee = feeRate × Price × (1 - Price)
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 mt-2">
                    <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)]">
                      <div className="font-bold text-emerald-700">Token UP:</div>
                      <div className="mt-1 space-y-0.5">
                        <div>Giá thô (+Trượt giá): <span className="font-mono">{fmtNum(upAsk, 3)} $</span></div>
                        <div>Phí taker ước tính: <span className="font-mono">{fmtNum(upFee, 4)} $</span></div>
                        <div className="font-semibold border-t pt-1 mt-1 text-[var(--text-main)]">
                          Chi phí thực tế (Cost UP): <span className="font-mono text-[12px]">{fmtNum(upCost, 3)} $</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)]">
                      <div className="font-bold text-rose-700">Token DOWN:</div>
                      <div className="mt-1 space-y-0.5">
                        <div>Giá thô (+Trượt giá): <span className="font-mono">{fmtNum(downAsk, 3)} $</span></div>
                        <div>Phí taker ước tính: <span className="font-mono">{fmtNum(downFee, 4)} $</span></div>
                        <div className="font-semibold border-t pt-1 mt-1 text-[var(--text-main)]">
                          Chi phí thực tế (Cost DOWN): <span className="font-mono text-[12px]">{fmtNum(downCost, 3)} $</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Step 3: Edge calculation */}
                <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-2">
                  <div className="font-semibold text-[var(--text-main)] flex items-center gap-1">
                    <span className="bg-[var(--color-accent)] text-white h-4 w-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold">3</span>
                    Bước 3: So sánh xác suất mô hình và chi phí thực tế để tìm lợi thế (Edge)
                  </div>
                  <div className="text-[var(--text-muted)]">Công thức:</div>
                  <div className="font-mono text-[11px] my-1 bg-[var(--bg-main)] p-2 border">
                    Edge = Xác suất dự báo - Chi phí thực tế
                  </div>
                  <div className="grid gap-2 grid-cols-2 mt-2">
                    <div className="bg-[var(--bg-main)] p-2 border border-[var(--border-color)]">
                      <div className="text-[10px] text-[var(--text-muted)]">Edge UP</div>
                      <div className="text-[14px] font-bold font-mono text-[var(--text-main)] mt-0.5">
                        {pUp.toFixed(2)} - {upCost.toFixed(3)} = <span className={edgeUp >= minEdge ? "text-emerald-600 font-semibold" : "text-[var(--text-muted)]"}>{fmtPct(edgeUp)}</span>
                      </div>
                      <div className="text-[9px] text-[var(--text-muted)] mt-1">Yêu cầu tối thiểu: &gt;= {fmtPct(minEdge)}</div>
                    </div>
                    <div className="bg-[var(--bg-main)] p-2 border border-[var(--border-color)]">
                      <div className="text-[10px] text-[var(--text-muted)]">Edge DOWN</div>
                      <div className="text-[14px] font-bold font-mono text-[var(--text-main)] mt-0.5">
                        {pDown.toFixed(2)} - {downCost.toFixed(3)} = <span className={edgeDown >= minEdge ? "text-rose-600 font-semibold" : "text-[var(--text-muted)]"}>{fmtPct(edgeDown)}</span>
                      </div>
                      <div className="text-[9px] text-[var(--text-muted)] mt-1">Yêu cầu tối thiểu: &gt;= {fmtPct(minEdge)}</div>
                    </div>
                  </div>
                </div>

                {/* Step 4: Kelly Fraction Sizing */}
                <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-2">
                  <div className="font-semibold text-[var(--text-main)] flex items-center gap-1">
                    <span className="bg-[var(--color-accent)] text-white h-4 w-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold">4</span>
                    Bước 4: Định cỡ vị thế quản lý vốn (Kelly Position Sizing)
                  </div>
                  <div className="text-[var(--text-muted)] leading-relaxed">
                    Công thức Kelly giúp tìm tỷ lệ phân bổ vốn tối ưu cho mỗi lệnh giao dịch nhằm tối đa hóa tốc độ tăng trưởng tài sản dài hạn (lãi kép) và tránh nguy cơ phá sản. Đối với hợp đồng quyền chọn nhị phân trên Polymarket (thắng nhận 1.00$, thua mất toàn bộ chi phí mua Cost), công thức được tính toán chi tiết như sau:
                  </div>

                  <div className="grid gap-4 md:grid-cols-2 bg-[var(--bg-main)] p-3 border border-[var(--border-color)]">
                    <div className="space-y-1">
                      <span className="font-bold text-[var(--text-main)] block text-[11px]">1. Công thức chuẩn Kelly:</span>
                      <div className="flex items-center gap-2 font-mono text-[11px] my-1 py-1">
                        <span>f<sup>*</sup> = </span>
                        <div className="flex flex-col items-center">
                          <span className="border-b px-2 pb-0.5">b × P<sub>win</sub> - (1 - P<sub>win</sub>)</span>
                          <span className="pt-0.5">b</span>
                        </div>
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                        Trong đó:<br />
                        • P<sub>win</sub>: Xác suất thắng của mô hình ({fmtPct(winP)})<br />
                        • b: Tỷ lệ cược ròng (net odds) = (1 - Cost) / Cost
                      </div>
                    </div>

                    <div className="space-y-1 border-t md:border-t-0 md:border-l md:pl-4 pt-2 md:pt-0">
                      <span className="font-bold text-[var(--text-main)] block text-[11px]">2. Công thức rút gọn nhị phân:</span>
                      <div className="flex items-center gap-2 font-mono text-[11px] my-1 py-1">
                        <span>f<sup>*</sup> = </span>
                        <div className="flex flex-col items-center">
                          <span className="border-b px-2 pb-0.5">Lợi thế (Edge)</span>
                          <span className="pt-0.5">1 - Cost</span>
                        </div>
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                        Cả 2 công thức đều cho ra kết quả trùng khớp 100%! Công thức rút gọn cho thấy rõ Kelly tối ưu chỉ đơn giản là tỷ lệ giữa Lợi thế (Edge = P<sub>win</sub> - Cost) chia cho phần thưởng nhận thêm nếu thắng (1 - Cost).
                      </div>
                    </div>
                  </div>

                  {action !== "SKIP" ? (
                    <div className="bg-[var(--bg-main)] p-3 border border-[var(--border-color)] space-y-3 mt-2">
                      <strong className="text-[var(--text-main)] block text-[11px] border-b pb-1">Bảng tính toán số liệu thực tế dựa trên tham số của bạn:</strong>
                      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 text-[11px] text-[var(--text-muted)]">
                        <div>Xác suất thắng P<sub>win</sub>: <span className="font-semibold text-[var(--text-main)]">{fmtPct(winP)}</span></div>
                        <div>Chi phí mua Cost: <span className="font-semibold text-[var(--text-main)]">{fmtNum(cost, 3)} $</span></div>
                        <div>Lợi thế Edge: <span className="font-semibold text-[var(--text-main)]">{fmtPct(edge)}</span></div>
                        <div>Tỷ lệ cược ròng b: <span className="font-semibold text-[var(--text-main)]">{fmtNum(netOdds, 3)} lần</span></div>
                        <div>Kelly tối ưu f<sup>*</sup>: <span className="font-semibold text-[var(--text-main)]">{fmtPct(clampedKelly)}</span></div>
                        <div>1/4 Kelly (Hạ rủi ro): <span className="font-semibold text-[var(--text-main)]">{fmtPct(positionFraction)}</span></div>
                      </div>

                      <div className="border-t pt-2 space-y-1.5">
                        <div className="text-[11px] font-bold text-[var(--color-accent)] flex items-center justify-between">
                          <span>Quy mô vị thế đề xuất (sau khi hạ tỷ lệ và CAP):</span>
                          <span className="text-[13px] font-mono bg-[var(--bg-secondary)] px-2 py-0.5 border">{fmtPct(positionCap)}</span>
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] space-y-1 leading-relaxed">
                          <div>• <strong>Tại sao lại dùng 1/4 Kelly (Fractional Kelly)?</strong> Kelly tiêu chuẩn giả định rằng mô hình dự đoán xác suất chính xác tuyệt đối. Trên thực tế, mô hình luôn có sai số (estimation error, noise). Nếu sử dụng 100% Kelly (Full Kelly) khi ước lượng xác suất bị sai lệch, tài khoản sẽ chịu mức sụt giảm (drawdown) cực kỳ lớn hoặc bị phá sản. Sử dụng hệ số 0.25 (1/4 Kelly) giúp giảm biến động tài sản xuống 50% nhưng vẫn giữ lại tới 75% tốc độ tăng trưởng vốn lý thuyết.</div>
                          <div>• <strong>Tại sao giới hạn vị thế (Position Cap) tối đa là 5%?</strong> Để bảo vệ tài sản trước các sự kiện bất khả kháng (Thiên nga đen) không thể dự báo trước như lỗi Oracle của Polymarket, sự cố mạng lưới, hoặc Binance bị ngắt kết nối API. Mức 5% đảm bảo kể cả khi có biến cố xấu nhất, tài khoản của bạn vẫn an toàn và có thể dễ dàng phục hồi.</div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[var(--text-muted)] mt-1 italic">Hệ thống bỏ qua giao dịch (SKIP), do đó không thực hiện tính toán định cỡ Kelly.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "pipeline" && (
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left Navigation Steps (Timeline) */}
          <div className="lg:col-span-4 space-y-2">
            <div className="panel-shell">
              <div className="panel-header px-4 py-3 font-semibold text-[13px]">
                Quy Trình Xử Lý Hệ Thống (A-Z)
              </div>
              <div className="p-2 space-y-1">
                {pipelineSteps.map((step) => {
                  const StepIcon = step.icon;
                  const isActive = activeStep === step.id;
                  return (
                    <button
                      key={step.id}
                      onClick={() => setActiveStep(step.id)}
                      className={`w-full text-left p-3 border flex items-start gap-3 transition-all ${
                        isActive
                          ? "bg-[var(--bg-secondary)] border-[var(--color-accent)] border-l-4"
                          : "bg-[var(--bg-main)] border-[var(--border-color)] hover:bg-[var(--bg-secondary)]/50"
                      }`}
                    >
                      <div
                        className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold border ${
                          isActive
                            ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                            : "bg-[var(--bg-secondary)] text-[var(--text-muted)] border-[var(--border-color)]"
                        }`}
                      >
                        {step.id}
                      </div>
                      <div>
                        <div className={`text-[12px] font-bold ${isActive ? "text-[var(--text-main)]" : "text-[var(--text-muted)]"}`}>
                          {step.title.split(": ")[1]}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] mt-0.5 line-clamp-1">
                          {step.goal}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Detailed Step Content */}
          <div className="lg:col-span-8">
            {pipelineSteps.map((step) => {
              if (step.id !== activeStep) return null;
              const StepIcon = step.icon;
              return (
                <div key={step.id} className="panel-shell space-y-4">
                  <div className="panel-header px-4 py-3 flex items-center justify-between border-b">
                    <div className="font-bold text-[14px] text-[var(--text-main)] flex items-center gap-2">
                      <StepIcon className="h-5 w-5 text-[var(--color-accent)]" />
                      {step.title}
                    </div>
                    <div className="text-[10px] uppercase font-bold text-[var(--text-muted)] bg-[var(--bg-secondary)] px-2 py-0.5 border">
                      Mục {step.id} / 5
                    </div>
                  </div>
                  <div className="p-5 space-y-5 text-[12px]">
                    {/* Goal */}
                    <div>
                      <h4 className="text-[11px] uppercase font-bold text-[var(--text-muted)] mb-1">Mục Tiêu (Goal)</h4>
                      <p className="text-[var(--text-main)] bg-[var(--bg-secondary)] p-3 border-l-2 border-l-[var(--color-accent)]">
                        {step.goal}
                      </p>
                    </div>

                    {/* Inputs */}
                    <div>
                      <h4 className="text-[11px] uppercase font-bold text-[var(--text-muted)] mb-1.5">Dữ Liệu Đầu Vào Cần Thiết (Required Inputs)</h4>
                      <ul className="list-disc pl-5 space-y-1 text-[var(--text-muted)]">
                        {step.inputs.map((input, index) => (
                          <li key={index}><span className="text-[var(--text-main)] font-semibold">{input.split(" (")[0]}</span>{input.includes(" (") ? " (" + input.split(" (")[1] : ""}</li>
                        ))}
                      </ul>
                    </div>

                    {/* Detailed Steps */}
                    <div>
                      <h4 className="text-[11px] uppercase font-bold text-[var(--text-muted)] mb-1.5">Các Bước Xử Lý Chi Tiết (Detailed Processing)</h4>
                      <ol className="list-decimal pl-5 space-y-1.5 text-[var(--text-muted)]">
                        {step.processing.map((proc, index) => (
                          <li key={index}>
                            <span className="text-[var(--text-main)]">{proc}</span>
                          </li>
                        ))}
                      </ol>
                    </div>

                    {/* Theoretical Basis */}
                    <div>
                      <h4 className="text-[11px] uppercase font-bold text-[var(--text-muted)] mb-1">Cơ Sở Logic / Khoa Học (Basis of Logic)</h4>
                      <p className="text-[var(--text-muted)] italic leading-relaxed">
                        {step.basis}
                      </p>
                    </div>

                    {/* Step 4 Specific Detailed Algorithm Breakdown */}
                    {step.id === 4 && (
                      <div className="border border-[var(--border-color)] bg-[var(--bg-main)] p-4 rounded space-y-4">
                        <h4 className="text-[12px] uppercase font-bold text-[var(--color-accent)] flex items-center gap-1.5 border-b pb-2">
                          <Cpu className="h-4 w-4" /> Chi Tiết Toán Học: Thuật Toán Dự Báo Xác Suất Trộn (Bước 4.1)
                        </h4>
                        
                        <p className="text-[11px] text-[var(--text-muted)]">
                          Để đưa ra xác suất dự đoán sau cùng P<sub>Up</sub>, mô hình phối hợp 4 thành phần xác suất khác nhau nhằm giảm thiểu sai số khi tập mẫu nhỏ thông qua cơ chế co hẹp (Beta-Mean Shrinkage):
                        </p>

                        <div className="space-y-4">
                          {/* Sub-component 1 */}
                          <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                            <span className="font-semibold text-[var(--text-main)] block">1. Xác suất Cơ sở (Baseline Probability - P<sub>baseline</sub>):</span>
                            <span className="text-[var(--text-muted)] block mt-0.5">Ước lượng tỷ lệ thắng UP trung bình của toàn bộ các sự kiện lịch sử đã resolved.</span>
                            
                            <div className="flex items-center gap-2 font-mono text-[12px] my-1 bg-[var(--bg-main)] p-2.5 border w-fit">
                              <span>P<sub>baseline</sub> = </span>
                              <div className="flex flex-col items-center">
                                <span className="border-b px-2 pb-0.5">U<sub>total</sub> + (0.5 × 16)</span>
                                <span className="pt-0.5">N<sub>total</sub> + 16</span>
                              </div>
                            </div>
                            
                            <div className="text-[10px] text-[var(--text-muted)] space-y-2 mt-2 leading-relaxed">
                              <div>• <strong>Ý nghĩa đại lượng:</strong> <code>U<sub>total</sub></code> là tổng số sự kiện có kết quả thực tế đóng cửa tăng (UP) trong toàn bộ lịch sử huấn luyện; <code>N<sub>total</sub></code> là tổng số sự kiện lịch sử đã được giải quyết.</div>
                              <div>• <strong>Cơ chế co hẹp (Beta-Mean Shrinkage):</strong> Cộng thêm <code>+(0.5 × 16)</code> tức 8 mẫu UP giả định (prior) và <code>+16</code> mẫu vào tổng mẫu. Đây là phương pháp Bayes giúp kéo xác suất về mốc trung lập 50% khi cỡ mẫu lịch sử quá nhỏ, hạn chế tình trạng tỷ lệ thắng thô bị quá khớp (overfitting). Khi N<sub>total</sub> rất lớn, tác động của hằng số 16 này tiêu biến.</div>
                              <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)] text-[var(--text-main)] font-sans">
                                <strong>💡 Ví dụ thực tế:</strong> Giả sử hệ thống mới chạy và chỉ có <strong>4 sự kiện lịch sử</strong>, trong đó có 3 lần UP và 1 lần DOWN.
                                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                                  <li>Tỷ lệ thắng thô: 3 / 4 = 75% (rất kém tin cậy do quá ít mẫu).</li>
                                  <li>Xác suất nền sau co hẹp: P<sub>baseline</sub> = (3 + 8) / (4 + 16) = 11 / 20 = 55%.</li>
                                </ul>
                                Xác suất nền 55% thực tế và an toàn hơn nhiều so với con số 75% bị nhiễu mẫu nhỏ.
                              </div>
                            </div>
                          </div>

                          {/* Sub-component 2 */}
                          <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                            <span className="font-semibold text-[var(--text-main)] block">2. Xác suất theo Trạng thái HMM (State Probability - P<sub>state</sub>):</span>
                            <span className="text-[var(--text-muted)] block mt-0.5">Ước lượng xác suất thắng UP có điều kiện dựa trên trạng thái HMM hiện tại (ví dụ: đang ở State 2).</span>
                            
                            <div className="flex items-center gap-2 font-mono text-[12px] my-1 bg-[var(--bg-main)] p-2.5 border w-fit">
                              <span>P<sub>state</sub> = </span>
                              <div className="flex flex-col items-center">
                                <span className="border-b px-2 pb-0.5">U<sub>state</sub> + (P<sub>baseline</sub> × 16)</span>
                                <span className="pt-0.5">N<sub>state</sub> + 16</span>
                              </div>
                            </div>

                            <div className="text-[10px] text-[var(--text-muted)] space-y-2 mt-2 leading-relaxed">
                              <div>• <strong>Ý nghĩa đại lượng:</strong> <code>U<sub>state</sub></code> là số lần đóng cửa UP của các sự kiện trong quá khứ thuộc cùng trạng thái HMM hiện tại; <code>N<sub>state</sub></code> là tổng số sự kiện lịch sử thuộc trạng thái HMM đó.</div>
                              <div>• <strong>Cơ chế co hẹp (Beta-Mean Shrinkage):</strong> Ở đây, thay vì co kéo về mốc trung lập 50%, ta sử dụng xác suất nền tảng <code>P<sub>baseline</sub></code> làm mốc tiên nghiệm (Prior), với trọng số niềm tin là 16. Nghĩa là nếu số lượng mẫu của trạng thái này quá ít, ta tạm tin rằng xác suất của nó tương đương với xác suất nền tảng của toàn bộ thị trường.</div>
                              <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)] text-[var(--text-main)] font-sans">
                                <strong>💡 Ví dụ thực tế:</strong> Giả sử thị trường đang ở <strong>State 2 (Downtrend)</strong>. Ta đã tính được P<sub>baseline</sub> = 54%.
                                Trong lịch sử có <strong>10 sự kiện thuộc State 2</strong>, với 2 lần đóng cửa UP và 8 lần đóng cửa DOWN.
                                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                                  <li>Tỷ lệ thắng thô của riêng State 2: 2 / 10 = 20%.</li>
                                  <li>Xác suất HMM sau co hẹp: P<sub>state</sub> = (2 + 0.54 × 16) / (10 + 16) = (2 + 8.64) / 26 = 10.64 / 26 = 40.9%.</li>
                                </ul>
                                Co hẹp giúp nâng ước tính từ 20% lên 40.9% để tránh bi quan quá mức khi tập mẫu 10 nến là quá nhỏ.
                              </div>
                            </div>
                          </div>

                          {/* Sub-component 3 */}
                          <div className="bg-[var(--bg-secondary)] p-3 border space-y-2">
                            <span className="font-semibold text-[var(--text-main)] block">3. Xác suất theo Khóa Xu Hướng (Trend Probability - P<sub>trend</sub>):</span>
                            <span className="text-[var(--text-muted)] block mt-0.5">Kết hợp trạng thái HMM với xu hướng dịch chuyển giá ngắn hạn (trendKey) của BTC.</span>
                            
                            <div className="flex items-center gap-2 font-mono text-[12px] my-1 bg-[var(--bg-main)] p-2.5 border w-fit">
                              <span>P<sub>trend</sub> = </span>
                              <div className="flex flex-col items-center">
                                <span className="border-b px-2 pb-0.5">U<sub>trend</sub> + (P<sub>state</sub> × 16)</span>
                                <span className="pt-0.5">N<sub>trend</sub> + 16</span>
                              </div>
                            </div>

                            <div className="text-[11px] text-[var(--text-muted)] space-y-3 border-t pt-2 mt-2 leading-relaxed">
                              <div>
                                <strong className="text-[var(--text-main)] block">Khóa xu hướng (trendKey) là gì?</strong>
                                <span>trendKey là một chuỗi khóa nhận diện dùng để gom nhóm các nến lịch sử có cùng trạng thái thị trường và cùng biến động giá ngắn hạn.</span>
                              </div>

                              <div>
                                <strong className="text-[var(--text-main)] block">Công thức cấu trúc khóa:</strong>
                                <div className="font-mono text-[11px] my-1 bg-[var(--bg-main)] p-2 border w-fit">
                                  trendKey = [Trạng thái HMM] | [Nhóm khoảng cách giá distanceToStrike] | [Nhóm tỷ suất sinh lời priceRet24]
                                </div>
                              </div>

                              <div>
                                <strong className="text-[var(--text-main)] block">Quy tắc phân nhóm giá trị (quy đổi thành 3 chữ viết tắt dựa trên các ngưỡng so sánh):</strong>
                                <ul className="list-disc pl-5 space-y-1 mt-1">
                                  <li><code className="bg-[var(--bg-main)] px-1 py-0.5 border">pos</code> (Positive): Lớn hơn ngưỡng dương (giá tăng mạnh).</li>
                                  <li><code className="bg-[var(--bg-main)] px-1 py-0.5 border">neg</code> (Negative): Nhỏ hơn ngưỡng âm (giá giảm mạnh).</li>
                                  <li><code className="bg-[var(--bg-main)] px-1 py-0.5 border">flat</code>: Nằm trong ngưỡng (giá đi ngang biến động thấp).</li>
                                </ul>
                              </div>

                              <div className="bg-[var(--bg-main)] p-3 border space-y-2 text-[var(--text-main)]">
                                <strong className="text-[var(--color-accent)] flex items-center gap-1"><Info className="h-3.5 w-3.5" /> Ví dụ cụ thể từng bước tạo khóa:</strong>
                                <div>Giả sử hôm nay bạn chuẩn bị vào lệnh lúc 08:00 AM:</div>
                                <ul className="list-decimal pl-5 space-y-2">
                                  <li>
                                    <strong>HMM State:</strong> Mô hình nhận diện nến BTC hiện tại đang thuộc <strong>State 1</strong> (Uptrend).
                                  </li>
                                  <li>
                                    <strong>Nhóm distanceToStrike (Khoảng cách giá từ lúc mở cửa đến lúc vào lệnh):</strong>
                                    <div className="mt-1 pl-3 border-l-2 space-y-0.5">
                                      <div>Giá mở cửa lúc 07:00 AM: <span className="font-semibold">$65,000</span></div>
                                      <div>Giá vào lệnh lúc 08:00 AM: <span className="font-semibold">$65,150</span></div>
                                      <div className="flex items-center gap-1 font-mono text-[10px] my-1 bg-[var(--bg-secondary)] p-1.5 border w-fit">
                                        <span>distanceToStrike = </span>
                                        <div className="flex flex-col items-center">
                                          <span className="border-b px-1">65,150 - 65,000</span>
                                          <span>65,000</span>
                                        </div>
                                        <span> = +0.0023 (tức +0.23%)</span>
                                      </div>
                                      <div>So sánh với ngưỡng trong code (0.001 hay 0.1%): Vì +0.23% &gt; +0.1%, nhóm này được gán là <code className="bg-[var(--bg-secondary)] px-1 border">"pos"</code>.</div>
                                    </div>
                                  </li>
                                  <li>
                                    <strong>Nhóm priceRet24 (Biến động giá BTC trong 24 giờ qua):</strong>
                                    <div className="mt-1 pl-3 border-l-2 space-y-0.5">
                                      <div>BTC giảm nhẹ trong 24 giờ qua: <span className="font-semibold">-0.12%</span></div>
                                      <div>{"So sánh với ngưỡng trong code (0.002 hay 0.2%): Vì -0.12% nằm trong khoảng biến động hẹp [-0.2%, 0.2%], nhóm này được gán là "}<code className="bg-[var(--bg-secondary)] px-1 border">"flat"</code>.</div>
                                    </div>
                                  </li>
                                </ul>
                                <div className="border-t pt-2 mt-2">
                                  <strong>Kết quả ghép khóa:</strong> Hệ thống sẽ tạo ra khóa trendKey là: <code className="bg-[var(--bg-secondary)] px-1.5 py-0.5 border font-mono">"1|pos|flat"</code>.
                                </div>
                                <div className="mt-1.5 text-[11px] text-[var(--text-muted)] leading-relaxed">
                                  <strong>Mô hình sẽ làm gì tiếp theo với khóa này?</strong> Mô hình sẽ lọc trong 100 sự kiện lịch sử ở Bước 1 xem có bao nhiêu sự kiện có chung khóa <code className="font-mono">"1|pos|flat"</code> (tức là những ngày trong quá khứ BTC cũng ở State 1, giá lúc vào lệnh cũng tăng nhẹ so với mở cửa, và 24h trước đó đi ngang). Giả sử tìm được 10 sự kiện lịch sử như vậy, mô hình sẽ đếm xem trong 10 sự kiện đó có bao nhiêu lần kết quả cuối cùng là UP để tính ra xác suất P<sub>trend</sub>.
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Sub-component 4 */}
                          <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                            <span className="font-semibold text-[var(--text-main)] block">4. Xác suất Láng giềng Gần Nhất (KNN Probability - P<sub>neighbor</sub>):</span>
                            <span className="text-[var(--text-muted)] block mt-0.5">Tìm những nến lịch sử có đặc trưng giống nến hiện tại nhất trong không gian đặc trưng đa chiều (volatility, returns, liqShock, fundingShock, v.v.).</span>
                            
                            <div className="bg-[var(--bg-main)] p-3 border border-[var(--border-color)] my-2 space-y-3 font-mono text-[11px] w-fit">
                              {/* Distance Formula */}
                              <div className="flex items-center gap-1">
                                <span>Khoảng cách d<sub>i</sub> = </span>
                                <span className="text-[15px] font-sans">√</span>
                                <span className="border-t pt-0.5 flex items-center">
                                  StatePenalty + 0.16 × Σ [ 
                                  <div className="inline-flex flex-col items-center mx-1">
                                    <span className="border-b px-1 text-[9px]">x<sub>k, current</sub> - x<sub>k, hist</sub></span>
                                    <span className="text-[9px]">σ<sub>k</sub></span>
                                  </div>
                                  ]<sup>2</sup>
                                </span>
                              </div>

                              {/* Weight Formula */}
                              <div className="border-t pt-1.5 flex items-center gap-1">
                                <span>Trọng số láng giềng i: w<sub>i</sub> = </span>
                                <div className="flex flex-col items-center">
                                  <span className="border-b px-2">1</span>
                                  <span>0.3 + d<sub>i</sub></span>
                                </div>
                              </div>

                              {/* KNN Prob Formula */}
                              <div className="border-t pt-1.5 flex items-center gap-1">
                                <span>P<sub>neighbor</sub> = </span>
                                <div className="flex flex-col items-center">
                                  <span className="border-b px-2">Σ (Y<sub>i</sub> × w<sub>i</sub>) + (P<sub>baseline</sub> × 3)</span>
                                  <span>Σ w<sub>i</sub> + 3</span>
                                </div>
                              </div>
                            </div>

                            <div className="text-[10px] text-[var(--text-muted)] space-y-2 mt-2 leading-relaxed">
                              <div>• <strong>Giải thích các đại lượng:</strong><br />
                                &nbsp;&nbsp;- <code>x<sub>k, current</sub></code> và <code>x<sub>k, hist</sub></code>: Giá trị đặc trưng thứ k (ví dụ: biến động 24h) của nến hiện tại và nến lịch sử thứ i.<br />
                                &nbsp;&nbsp;- <code>σ<sub>k</sub></code>: Độ lệch chuẩn của đặc trưng thứ k nhằm đưa các đặc trưng khác đơn vị về cùng một quy mô.<br />
                                &nbsp;&nbsp;- <code>StatePenalty</code>: Bằng 0 nếu nến lịch sử có cùng trạng thái HMM, bằng 1.2 nếu khác trạng thái. Việc này ngăn mô hình chọn láng giềng khác trạng thái thị trường trừ khi các đặc trưng khác cực kỳ giống nhau.<br />
                                &nbsp;&nbsp;- Số lượng láng giềng K được chọn động: <code>K = clamp(3√N<sub>total</sub>, 12, 40)</code>.
                              </div>
                              <div>• <strong>Tại sao công thức trọng số w<sub>i</sub> có số 0.3?</strong> Để tránh chia cho 0 khi khoảng cách d<sub>i</sub> cực kì nhỏ (nếu hai nến giống hệt nhau d=0, trọng số sẽ đạt cực đại là 1/0.3 = 3.33 thay vì vô cực).</div>
                              <div>• <strong>Ý nghĩa của P<sub>neighbor</sub>:</strong> Kết quả dự báo là trung bình có trọng số của các kết quả thực tế Y<sub>i</sub> (thắng UP=1, thua DOWN=0) của K láng giềng gần nhất, được co hẹp nhẹ về mốc <code>P<sub>baseline</sub></code> với trọng số niềm tin là 3.</div>
                              <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)] text-[var(--text-main)] font-sans">
                                <strong>💡 Ví dụ thực tế:</strong> Giả sử hệ thống tìm thấy 12 láng giềng gần nhất (K=12).
                                Tổng trọng số của 12 láng giềng này là Σ w<sub>i</sub> = 15.0.
                                Trong 12 láng giềng, có 8 nến thắng UP (Y = 1) với tổng trọng số tương ứng là 10.5, và 4 nến thua DOWN (Y = 0) với tổng trọng số là 4.5.
                                Xác suất nền P<sub>baseline</sub> = 54%.
                                <br />
                                Tính toán: P<sub>neighbor</sub> = (10.5 × 1 + (0.54 × 3)) / (15.0 + 3) = (10.5 + 1.62) / 18.0 = 12.12 / 18.0 = 67.3%.
                              </div>
                            </div>
                          </div>

                          {/* Blending Weights */}
                          <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                            <span className="font-semibold text-[var(--text-main)] block">5. Trộn các mô hình thành Xác suất chung (P<sub>Up</sub>):</span>
                            <span className="text-[var(--text-muted)] block">Tính toán độ tin cậy của từng mô hình thành phần dựa trên số lượng mẫu huấn luyện thực tế đang có để trộn lại với nhau theo tỷ lệ tối ưu.</span>
                            
                            <div className="bg-[var(--bg-main)] p-3 border border-[var(--border-color)] my-2 space-y-3 font-mono text-[11px] w-fit">
                              {/* Reliabilities */}
                              <div className="flex items-center gap-4">
                                <div className="flex items-center gap-1.5">
                                  <span>R<sub>state</sub> = </span>
                                  <div className="flex flex-col items-center text-[10px]">
                                    <span className="border-b px-2">N<sub>state</sub></span>
                                    <span>N<sub>state</sub> + 12</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 border-l pl-3">
                                  <span>R<sub>trend</sub> = </span>
                                  <div className="flex flex-col items-center text-[10px]">
                                    <span className="border-b px-2">N<sub>trend</sub></span>
                                    <span>N<sub>trend</sub> + 24</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 border-l pl-3">
                                  <span>R<sub>neighbor</sub> = </span>
                                  <div className="flex flex-col items-center text-[10px]">
                                    <span className="border-b px-2">K</span>
                                    <span>K + 24</span>
                                  </div>
                                </div>
                              </div>

                              {/* Weights Formula */}
                              <div className="border-t pt-2 space-y-1">
                                <div>Trọng số gán: W<sub>state</sub> = 0.5 × R<sub>state</sub> | W<sub>neighbor</sub> = 0.3 × R<sub>neighbor</sub> | W<sub>trend</sub> = 0.2 × R<sub>trend</sub></div>
                                <div>Trọng số cơ sở: W<sub>baseline</sub> = max(0.15, 1 - W<sub>state</sub> - W<sub>neighbor</sub> - W<sub>trend</sub>)</div>
                              </div>

                              {/* Final Formula */}
                              <div className="border-t pt-2 flex items-center gap-1 text-[var(--color-accent)] font-bold">
                                <span>P<sub>Up</sub> = clamp( </span>
                                <div className="flex flex-col items-center mx-1">
                                  <span className="border-b px-2 pb-0.5">
                                    (W<sub>state</sub> × P<sub>state</sub>) + (W<sub>neighbor</sub> × P<sub>neighbor</sub>) + (W<sub>trend</sub> × P<sub>trend</sub>) + (W<sub>baseline</sub> × P<sub>baseline</sub>)
                                  </span>
                                  <span className="pt-0.5">
                                    W<sub>state</sub> + W<sub>neighbor</sub> + W<sub>trend</sub> + W<sub>baseline</sub>
                                  </span>
                                </div>
                                <span>, 0.03, 0.97 )</span>
                              </div>
                            </div>

                            <div className="text-[10px] text-[var(--text-muted)] space-y-2 mt-2 leading-relaxed">
                              <div>• <strong>Hàm tin cậy N / (N + C):</strong> Hệ số tin cậy R dao động từ 0 đến 1. Khi kích thước tập mẫu N tăng lên, R tiến sát về 1.0 (mô hình tin cậy tối đa). Khi N nhỏ, R tiến về 0. Hằng số C thể hiện yêu cầu khắt khe về cỡ mẫu (mô hình xu hướng Trend cần 24 mẫu mới đạt 50% tin cậy, trong khi mô hình HMM State chỉ cần 12 mẫu).</div>
                              <div>• <strong>Trọng số cơ sở W<sub>baseline</sub>:</strong> Đóng vai trò là chốt chặn an toàn. Nếu các phân nhóm quá nhỏ (làm W<sub>state</sub>, W<sub>trend</sub> thấp), W<sub>baseline</sub> sẽ tự động nâng lên để đảm bảo hệ thống dựa vào xác suất cơ sở của toàn thị trường thay vì các phân nhóm bị nhiễu mẫu nhỏ (giá trị tối thiểu luôn là 15%).</div>
                              <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)] text-[var(--text-main)] font-sans">
                                <strong>💡 Ví dụ tính toán trộn thực tế:</strong> Giả sử ta có các thông số mẫu:<br />
                                - N<sub>state</sub> = 25 mẫu &rarr; R<sub>state</sub> = 25 / (25 + 12) = 0.676 &rarr; W<sub>state</sub> = 0.5 × 0.676 = 0.338<br />
                                - N<sub>trend</sub> = 10 mẫu &rarr; R<sub>trend</sub> = 10 / (10 + 24) = 0.294 &rarr; W<sub>trend</sub> = 0.2 × 0.294 = 0.059<br />
                                - K = 12 láng giềng &rarr; R<sub>neighbor</sub> = 12 / (12 + 24) = 0.333 &rarr; W<sub>neighbor</sub> = 0.3 × 0.333 = 0.100<br />
                                - Trọng số cơ sở: W<sub>baseline</sub> = max(0.15, 1 - 0.338 - 0.100 - 0.059) = max(0.15, 0.503) = 0.503.<br />
                                - Tổng trọng số: W<sub>sum</sub> = 0.338 + 0.100 + 0.059 + 0.503 = 1.000.<br />
                                - Giả sử các xác suất thành phần là: P<sub>state</sub> = 40.9%, P<sub>trend</sub> = 67.7%, P<sub>neighbor</sub> = 67.3%, P<sub>baseline</sub> = 54.0%.
                                <br />
                                Tính toán P<sub>Up</sub> trước khi giới hạn (clamp):<br />
                                P = (0.338 × 0.409) + (0.100 × 0.673) + (0.059 × 0.677) + (0.503 × 0.540) = 0.1382 + 0.0673 + 0.0399 + 0.2716 = 0.5170 (tức 51.7%).
                                <br />
                                Hệ thống giới hạn (clamp) trong khoảng [0.03, 0.97]. Do đó: <strong>Xác suất dự đoán cuối cùng P<sub>Up</sub> = 51.7%</strong>.
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Example */}
                    <div className="border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                      <h4 className="text-[10px] uppercase font-bold text-[var(--color-accent)] mb-1 flex items-center gap-1">
                        <Info className="h-3.5 w-3.5" /> Ví Dụ Minh Họa Thực Tế (Concrete Example)
                      </h4>
                      <p className="text-[var(--text-main)] font-medium font-sans">
                        {step.example}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === "theory" && (
        <div className="panel-shell">
          <div className="panel-header px-4 py-3 font-semibold text-[13px] flex items-center gap-1.5">
            <BookOpen className="h-4 w-4 text-[var(--color-accent)]" /> Tài Liệu Giảng Dạy & Lý Thuyết Chi Tiết Từ A-Z
          </div>
          <div className="p-6 space-y-6 text-[12px] text-[var(--text-main)] leading-relaxed">
            
            {/* Section 1 */}
            <section className="space-y-3">
              <h2 className="text-[14px] font-bold border-b pb-1 flex items-center gap-1.5 text-[var(--text-main)]">
                <TrendingUp className="h-4 w-4 text-[var(--color-accent)]" /> 1. Cơ Chế Hoạt Động & Nguồn Dữ Liệu
              </h2>
              <p>
                Hệ thống thực hiện so khớp trạng thái thị trường có điều kiện (được tính toán từ mô hình HMM) với các hợp đồng dự đoán trên Polymarket. Ý tưởng cốt lõi là hành vi giá của BTC tại một thời điểm vào lệnh cụ thể sẽ chịu sự chi phối mạnh mẽ của trạng thái vĩ mô hiện tại (Regime).
              </p>
              <div className="bg-[var(--bg-secondary)] p-4 border border-[var(--border-color)] space-y-2">
                <strong className="text-[11px] block text-[var(--text-main)]">Quy trình khớp múi giờ giao dịch:</strong>
                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                  • <strong>Hợp đồng daily (24 giờ):</strong> Bắt đầu lúc 07:00 AM hôm nay và kết thúc lúc 07:00 AM hôm sau. Giá BTC tại Binance lúc 07:00 AM là giá mở cửa (Start Price / Strike Price).<br />
                  • <strong>Thời điểm vào lệnh (Entry Time):</strong> Ví dụ 08:00 AM. Lúc này ta đã trôi qua 1 giờ (elapsedPct = 1/24 = 4.17%). Giá BTC lúc này là Entry Price. Ta cần dự đoán xem đến 07:00 AM ngày mai, giá BTC sẽ cao hơn (UP) hay thấp hơn (DOWN) so với Strike Price.<br />
                  • <strong>Kết quả thanh toán:</strong> Token UP sẽ thanh toán trị giá 1.00$ nếu giá đóng cửa lớn hơn hoặc bằng Strike Price. Ngược lại, token DOWN thanh toán 1.00$. Nếu dự đoán sai, token đó trở về 0.00$.
                </p>
              </div>
            </section>

            {/* Section 2 */}
            <section className="space-y-3">
              <h2 className="text-[14px] font-bold border-b pb-1 flex items-center gap-1.5 text-[var(--text-main)]">
                <ShieldCheck className="h-4 w-4 text-[var(--color-accent)]" /> 2. Mô Hình Ước Lượng Xác Suất Trộn (Blended Prediction)
              </h2>
              <p>
                Để đưa ra dự báo xác suất UP (pUp) đáng tin cậy nhất, mô hình blending phối hợp kết quả của 4 mô hình thành phần khác nhau, tối đa hóa ưu điểm của từng mô hình dựa trên số lượng mẫu dữ liệu hiện có trong lịch sử.
              </p>

              <div className="space-y-4">
                <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                  <strong className="text-[var(--text-main)] block text-[11px]">A. Cơ chế co hẹp Beta-Mean (Beta-Mean Shrinkage):</strong>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    Khi kích thước mẫu huấn luyện rất nhỏ, tỷ lệ thắng thô cực kỳ không ổn định (ví dụ: chỉ có 2 sự kiện lịch sử và cả 2 đều thắng &rarr; tỷ lệ thắng 100% là không thực tế). Cơ chế co hẹp Bayes sử dụng một tiên nghiệm (Prior) làm mốc kéo xác suất thô về phía an toàn hơn.
                  </p>
                  <div className="flex items-center gap-2 font-mono text-[11px] my-1 bg-[var(--bg-main)] p-2.5 border w-fit">
                    <span>Xác suất co hẹp = </span>
                    <div className="flex flex-col items-center">
                      <span className="border-b px-2 pb-0.5">U + (P<sub>prior</sub> × 16)</span>
                      <span className="pt-0.5">N + 16</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Trong đó 16 là trọng số của niềm tin tiên nghiệm. Nếu cỡ mẫu N của phân nhóm lớn, ảnh hưởng của P<sub>prior</sub> biến mất. Nếu N nhỏ, kết quả gần như bằng P<sub>prior</sub>.
                  </p>
                </div>

                <div className="bg-[var(--bg-secondary)] p-3 border space-y-2">
                  <strong className="text-[var(--text-main)] block text-[11px]">B. Chi tiết 4 thành phần xác suất:</strong>
                  <div className="text-[11px] text-[var(--text-muted)] space-y-2">
                    <div>1. <strong>Baseline Probability (P<sub>baseline</sub>):</strong> Tỷ lệ thắng UP trung bình của toàn bộ lịch sử. Co hẹp về mốc 50% (P<sub>prior</sub> = 0.5, N<sub>prior</sub> = 16).</div>
                    <div>2. <strong>State Probability (P<sub>state</sub>):</strong> Tỷ lệ thắng UP có điều kiện dựa trên trạng thái HMM hiện tại (ví dụ: Uptrend, Downtrend). Co hẹp về mốc <code>P<sub>baseline</sub></code>.</div>
                    <div>3. <strong>Trend Probability (P<sub>trend</sub>):</strong> Tỷ lệ thắng dựa trên khóa xu hướng <code>trendKey</code> (ghép từ trạng thái HMM, khoảng cách giá lúc vào lệnh, và tỷ suất sinh lời 24h trước). Co hẹp về mốc <code>P<sub>state</sub></code>.</div>
                    <div>4. <strong>Nearest Neighbor Probability (P<sub>neighbor</sub>):</strong> Tìm K nến lịch sử có đặc tính đa chiều giống nến hiện tại nhất bằng khoảng cách Euclidean chuẩn hóa:
                      <div className="bg-[var(--bg-main)] p-2.5 border border-[var(--border-color)] my-2 font-mono text-[11px] w-fit flex items-center gap-1">
                        <span>Khoảng cách d = </span>
                        <span className="text-[14px] font-sans">√</span>
                        <span className="border-t pt-0.5 flex items-center">
                          StatePenalty + 0.16 × Σ [ 
                          <div className="inline-flex flex-col items-center mx-1 text-[9px]">
                            <span className="border-b px-1">x<sub>k, current</sub> - x<sub>k, hist</sub></span>
                            <span>σ<sub>k</sub></span>
                          </div>
                          ]<sup>2</sup>
                        </span>
                      </div>
                      Trong đó, <code>StatePenalty</code> phạt 1.2 điểm nếu khác trạng thái HMM. Trọng số của mỗi nến láng giềng i là <code>w<sub>i</sub> = 1 / (0.3 + d<sub>i</sub>)</code>. KNN dự báo bằng trung bình có trọng số kết quả thắng thua của các láng giềng, co hẹp nhẹ về <code>P<sub>baseline</sub></code>.
                    </div>
                  </div>
                </div>

                <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                  <strong className="text-[var(--text-main)] block text-[11px]">C. Cơ chế trộn động (Dynamic Blending):</strong>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    Hệ thống tính toán độ tin cậy của mỗi thành phần dựa trên số lượng mẫu thực tế theo hàm <code>R = N / (N + C)</code>. 
                    Mô hình Trend khó có mẫu trùng khớp tuyệt đối nên hằng số C = 24 khắt khe hơn mô hình State HMM (C = 12). 
                    Sau đó, hệ thống nhân với các hệ số phân bổ mặc định (State: 0.5, KNN: 0.3, Trend: 0.2) để ra trọng số thực tế W. 
                    Trọng số cơ sở W<sub>baseline</sub> đóng vai trò bù đắp phần còn thiếu để tổng các trọng số bằng 1.0.
                  </p>
                </div>
              </div>
            </section>

            {/* Section 3 */}
            <section className="space-y-3">
              <h2 className="text-[14px] font-bold border-b pb-1 flex items-center gap-1.5 text-[var(--text-main)]">
                <Percent className="h-4 w-4 text-[var(--color-accent)]" /> 3. Tính Phí Giao Dịch & Xác Định Lợi Thế (Edge)
              </h2>
              <p>
                Để đảm bảo chiến thắng dài hạn, chúng ta không thể chỉ nhìn vào xác suất thô của mô hình mà phải trừ đi mọi chi phí giao dịch thực tế trên sàn Polymarket.
              </p>
              <div className="space-y-3 text-[11px] text-[var(--text-muted)]">
                <div className="bg-[var(--bg-secondary)] p-3 border leading-relaxed">
                  <strong className="text-[var(--text-main)] block">Công thức phí giao dịch (Taker Fee):</strong>
                  Polymarket áp dụng cấu trúc phí Maker-Taker động. Đối với người vào lệnh khớp ngay (Taker), phí được tính trên mỗi share như sau:
                  <div className="bg-[var(--bg-main)] p-2 border my-1 font-mono w-fit text-[var(--text-main)]">
                    Phí Taker = 0.07 × Price × (1 - Price)
                  </div>
                  • Phí đạt mức cao nhất khi giá bằng 0.50$ (phí là 1.75 cents/share). Lúc này thị trường có mức độ bất định cao nhất.<br />
                  • Phí giảm dần và tiệm cận về 0 khi giá tiến gần về 0.00$ hoặc 1.00$ (khi kết quả thị trường đã quá rõ ràng).
                </div>
                <div>
                  <strong className="text-[var(--text-main)] block">Lợi thế thực tế (Edge):</strong>
                  Lợi thế của bạn được tính bằng công thức: <code>Edge = Xác suất dự báo - Chi phí thực tế (gồm Giá thô + Trượt giá + Phí sàn)</code>.<br />
                  Hệ thống chỉ đưa ra tín hiệu giao dịch nếu lợi thế đạt tối thiểu mức cài đặt (minEdge, ví dụ 3.5%) và số lượng mẫu của trạng thái vĩ mô HMM đủ tin cậy.
                </div>
              </div>
            </section>

            {/* Section 4 */}
            <section className="space-y-3">
              <h2 className="text-[14px] font-bold border-b pb-1 flex items-center gap-1.5 text-[var(--text-main)]">
                <Info className="h-4 w-4 text-[var(--color-accent)]" /> 4. Định Cỡ Vốn (Kelly Criterion Sizing) & Brier Score
              </h2>
              
              <div className="space-y-4">
                <div className="bg-[var(--bg-secondary)] p-3 border space-y-2">
                  <strong className="text-[var(--text-main)] block text-[11px]">A. Công thức Kelly cho Quyền chọn nhị phân:</strong>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Kelly Criterion là công thức tối ưu hóa lượng tiền đi trên mỗi lệnh để tối đa hóa tốc độ tăng trưởng vốn. Trong cá cược nhị phân, nó có thể được biểu diễn bằng hai công thức tương đương:
                  </p>
                  <div className="grid gap-4 md:grid-cols-2 bg-[var(--bg-main)] p-3 border border-[var(--border-color)]">
                    <div>
                      <span className="font-semibold block text-[10px] text-[var(--text-main)]">1. Công thức chuẩn Kelly:</span>
                      <div className="flex items-center gap-2 font-mono text-[11px] my-1 py-1">
                        <span>f<sup>*</sup> = </span>
                        <div className="flex flex-col items-center">
                          <span className="border-b px-2 pb-0.5">b × P<sub>win</sub> - (1 - P<sub>win</sub>)</span>
                          <span className="pt-0.5">b</span>
                        </div>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        Trong đó b = (1 - Cost) / Cost là tỷ lệ thanh toán ròng (net odds).
                      </span>
                    </div>
                    <div>
                      <span className="font-semibold block text-[10px] text-[var(--text-main)]">2. Công thức rút gọn nhị phân:</span>
                      <div className="flex items-center gap-2 font-mono text-[11px] my-1 py-1">
                        <span>f<sup>*</sup> = </span>
                        <div className="flex flex-col items-center">
                          <span className="border-b px-2 pb-0.5">Lợi thế (Edge)</span>
                          <span className="pt-0.5">1 - Cost</span>
                        </div>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        Cho ra kết quả chính xác tương đương và cực kỳ dễ tính toán.
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-[var(--bg-secondary)] p-3 border space-y-2">
                  <strong className="text-[var(--text-main)] block text-[11px]">B. Ví dụ tính toán số liệu cụ thể:</strong>
                  <div className="text-[11px] text-[var(--text-muted)] space-y-2">
                    <p>
                      Giả sử tài khoản của bạn có <strong>10,000 USD</strong>.
                    </p>
                    <ul className="list-disc pl-5 space-y-1">
                      <li>Mô hình dự báo xác suất thắng P<sub>win</sub> = 62%.</li>
                      <li>Giá mua thực tế (gồm giá thô trên sàn + trượt giá + phí sàn) là Cost = 0.534$.</li>
                      <li>Lợi thế của lệnh là: Edge = 0.62 - 0.534 = 0.086 (8.6%).</li>
                      <li>Lợi nhuận nhận thêm nếu thắng là: 1 - Cost = 1 - 0.534 = 0.466$.</li>
                      <li>Kelly tối ưu: f<sup>*</sup> = Edge / (1 - Cost) = 0.086 / 0.466 = 18.45%.</li>
                      <li>Áp dụng 1/4 Kelly để phòng ngừa sai số mô hình: 18.45% × 0.25 = 4.61%.</li>
                      <li>So sánh với giới hạn vị thế (Position Cap) là 5%: Vì 4.61% &le; 5%, ta giữ nguyên quy mô đi tiền là <strong>4.61% tài khoản</strong> (tương đương 461 USD).</li>
                    </ul>
                  </div>
                </div>

                <div className="bg-[var(--bg-secondary)] p-3 border space-y-1">
                  <strong className="text-[var(--text-main)] block text-[11px]">C. Chỉ số Brier Score (Brier):</strong>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    Đây là thước đo chất lượng dự báo của mô hình xác suất. Brier Score tính giá trị bình phương sai lệch giữa xác suất dự đoán P và kết quả thực tế Y (Y = 1 nếu thắng, Y = 0 nếu thua). Công thức: <code>Brier = (P - Y)<sup>2</sup></code>. Giá trị Brier Score càng nhỏ (gần 0) thể hiện mô hình dự đoán xác suất càng chính xác. Điểm 0.25 tương đương dự đoán ngẫu nhiên 50/50.
                  </p>
                </div>
              </div>
            </section>

          </div>
        </div>
      )}
    </div>
  );
}
