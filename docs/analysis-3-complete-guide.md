
- sau khi bắt được event -> lấy snapshot của event đó.
- - `totalUsdLog`
- `longShare`
- `zScore`
- `liqToThreshold`
- `liqImpulse6h`
- `liqVs24hMean`
- `ret1hPast`, `ret4hPast`, `ret24hPast`
đại diện cho - cường độ liquidation
- cấu trúc imbalance long/short
- trạng thái giá ngay trước event
- mức biến động thị trường


- vol24h 
- từ snapshot đóng vector, chuẩn hoá, rồi dùng độ tương đồng cosine lấy K Neighbors
- Sau khi đã tìm được K Neighbors -> sẽ đánh hệ số cho nó - giống thì hệ số cao, càng khác thì hệ số càng thấp 
- người dùng sẽ chọn số Neighbors họ muốn tham khảo, ví dụ có thể chỉ lấy tham khảo 40 Neighbors giống nhất. 
- sau khi chọn k Neighbors -> tiếp tục phân tích event hiện tại 
- dùng softmax để từ event hiện tại và 40 Neighbors -> tính toán xem có bao nhiêu % xu hướng trend_down chop mean_revert
- có % và k Neighbors thì tiếp tục dùng Kernel-weighted kNN, cái này cùng mục đích với Trung bình có trọng số, nhưng lại quy đổi khoảng cách thành trọng số (khoảng cách ở đây sẽ là độ tương đồng cosine của Neighbors), thu thập chênh lệch giá theo từng khung giờ vào, giờ hold để tiếp tục dự đoán 




# Tài liệu đầy đủ: Trang Phân tích 3 (Future Inference theo Event)

## 1) Trang này là gì?

`Phân tích 3` là trang suy luận hành động giao dịch theo từng sự kiện liquidation (event-based inference).

Khác với backtest cố định kiểu “delay 1h, hold 8h”, trang này làm theo hướng:
1. Chọn một event mục tiêu `t0` (event vừa xảy ra hoặc event bạn chọn).
2. So khớp `t0` với các event lịch sử giống nhất.
3. Suy ra xác suất regime (quay đầu / giảm tiếp / đi ngang).
4. Chấm điểm toàn bộ cặp `Delay/Hold`.
5. Chọn action có score cao nhất.

Mục tiêu: giúp người dùng mới có một quy trình có cấu trúc để đi từ dữ liệu liquidation tới quyết định timing vào/ra lệnh.

---

 

## 3) Tổng quan luồng chạy trên trang

1. Người dùng chọn dataset CSV.
2. Trang tải nến BTCUSDT từ Binance để ghép với chuỗi liquidation theo cùng timeline.
3. Từ bộ lọc cascade (`q`, `minLongShare`, `zMin`, `zWindowHours`) hệ thống phát hiện danh sách event đủ điều kiện.
4. Chọn `target event`:
- Nếu user đã bấm event: dùng event đó.
- Nếu chưa chọn: dùng event mới nhất.
5. Trích xuất feature snapshot tại `t0`.
6. Lấy các event lịch sử trước `t0`, tính độ giống và chọn top-K neighbors.
7. Tính độ giống của k neighbor này bằng 
8. 
9. totalUsdLog
longShare
zScore
liqToThreshold
liqImpulse6h
liqVs24hMean
ret1hPast, ret4hPast, ret24hPast
vol6h, vol24h

7. Dùng neighbors để:
- vote regime probabilities (softmax)
- ước lượng expected metrics cho từng cặp `Delay/Hold`
8. Chấm điểm action, chọn action tốt nhất, hiển thị bảng chi tiết + audit baseline.

---

## 4) Điều kiện phát hiện Cascade Event

Một event được coi là cascade khi đồng thời thỏa:

- `totalUsd >= quantile(totalUsd, q)`
- `longShare >= minLongShare`, trong đó `longShare = longUsd / totalUsd`
- `zScore >= zMin`

Trong đó `zScore` được tính trên cửa sổ trượt `zWindowHours`:

`z = (x - mean(window)) / std(window)`

Ý nghĩa:
- `q`: lọc theo độ lớn tuyệt đối (tail event)
- `longShare`: đảm bảo event nghiêng về long liquidation
- `zScore`: đảm bảo event là cú sốc bất thường cục bộ

---

## 5) Feature engineering tại thời điểm t0

Với mỗi event, hệ thống tạo vector feature gồm:

- `totalUsdLog = log10(totalUsd)`
- `longShare`
- `zScore`
- `liqToThreshold = totalUsd / threshold`
- `liqImpulse6h = (totalUsd - mean6h) / std6h`
- `liqVs24hMean = totalUsd / mean24h`
- `ret1hPast`, `ret4hPast`, `ret24hPast` (động lượng giá trước event)
- `vol6h`, `vol24h` (độ biến động trailing của return giá)

Các feature này mô tả đồng thời:
- cường độ liquidation
- cấu trúc imbalance long/short
- trạng thái giá ngay trước event
- mức biến động thị trường

---

## 6) Gán nhãn regime lịch sử (để làm “bộ nhớ”)

Mỗi event lịch sử được gán 1 nhãn:
- `mean_revert`
- `trend_down`
- `chop`

Dựa trên diễn biến giá sau event trong `horizonHours`:
- Nếu return tương lai >= `retThreshold` -> `mean_revert`
- Nếu return <= `-retThreshold` hoặc drawdown <= `-drawdownThreshold` -> `trend_down`
- Còn lại -> `chop`

Đây là nhãn quan sát từ lịch sử để làm supervised memory cho bước suy luận.

---

## 7) Chọn K neighbors giống nhất

Chỉ dùng event lịch sử trước `t0` (tránh look-ahead).

Các bước:
1. Chuẩn hóa feature bằng mean/std của tập lịch sử.
2. Tính cosine similarity giữa target và từng event lịch sử.
3. Đưa similarity về `[0,1]`: `sim01 = (cos + 1)/2`
4. Trọng số neighbor: `weight = sim01^3` (nhấn mạnh event rất giống)
5. Lấy top `K`.

Nếu lịch sử ít hơn `minHistoryEvents` thì API từ chối suy luận để tránh kết quả kém tin cậy.

---

## 8) Suy ra xác suất regime

Từ top-K neighbors:
- Cộng tổng trọng số theo từng class (`mean_revert`, `trend_down`, `chop`) -> raw scores
- Chuẩn hóa thành logits
- Softmax -> probabilities

Kết quả hiển thị trên UI:
- Mean Revert %
- Trend Down %
- Chop %

---

## 9) Chấm điểm toàn bộ action Delay/Hold

Hệ thống quét lưới:
- `Delay` trong `[delayMin..delayMax]` bước `delayStep`
- `Hold` trong `[holdMin..holdMax]` bước `holdStep`

Với mỗi cặp delay/hold:
1. Áp timing đó lên top-K neighbors để lấy trade outcomes.
2. Tính:
- `expectedRet` (weighted average)
- `expectedMae`
- `expectedMfe`
- `winProb`
- `uncertainty` (std của return)
3. Loại action nếu `expectedRet < minExpectedRet` hoặc sample quá ít.

### Công thức raw score

`rawScore = expectedRet
 - riskPenalty * max(0, -expectedMae)
 - holdPenaltyPerHour * holdHours
 - delayPenaltyPerHour * delayHours
 - uncertaintyPenalty * uncertainty
 + regimeBias * (P(mean_revert) - P(trend_down))`

Sau đó chuẩn hóa:

`score = sigmoid(rawScore / 0.01)`

Action có `score` cao nhất là `chosen`.

---

## 10) Ý nghĩa các khối kết quả trên UI

- `Detected events`: số cascade event tìm thấy theo filter hiện tại.
- `History events`: số event trước `target` dùng làm lịch sử.
- `K used`: số neighbors thực sự dùng.
- `Regime probabilities`: xác suất ba trạng thái thị trường.
- `Actions evaluated`: số cặp delay/hold vượt điều kiện sample.
- `Chosen Delay/Hold`: phương án tối ưu theo score.
- `Expected Ret / MAE`: kỳ vọng lợi nhuận và rủi ro.
- `Realized Chosen` vs `Realized Baseline(1h/8h)`: dùng để audit trên dữ liệu lịch sử.

---

## 11) Ví dụ chuẩn (end-to-end)

Giả sử bạn dùng dataset `coinglass_BTC_liquidation_1h_2y.csv` với cấu hình:

- Cascade filter:
  - `q=0.99`
  - `minLongShare=0.8`
  - `zMin=1.5`
  - `zWindowHours=168`
- Memory:
  - `K=40`
  - `minHistoryEvents=80`
- Regime labeling:
  - `horizonHours=6`
  - `retThreshold=0.008`
  - `drawdownThreshold=0.015`
- Action ranges:
  - delay: `0 -> 3h`, step `0.5h`
  - hold: `1 -> 24h`, step `1h`

Quy trình đọc kết quả:
1. Bấm `Suy luận cho event đang chọn`.
2. Kiểm tra `History events >= minHistoryEvents`.
3. Nhìn regime:
- Nếu `Mean Revert` cao hơn rõ `Trend Down`, bias sẽ cộng điểm cho action thiên bắt hồi.
4. Mở bảng action:
- Ưu tiên score cao.
- So đồng thời `ExpectedRet`, `ExpectedMAE`, `Uncertainty`, `Sample`.
5. So với baseline 1h/8h để kiểm tra lợi thế timing động.

Tiêu chuẩn thực hành tốt:
- Không chọn action chỉ vì score cao nếu sample thấp.
- Nếu uncertainty lớn, giảm size hoặc bỏ qua tín hiệu.
- Kiểm tra thêm context thị trường ngoài liquidation (news, vol regime, funding).

---

## 12) Ví dụ payload API (rút gọn)

Endpoint: `POST /api/analysis/cascade-future-infer`

```json
{
  "rows": [{"ts": 1710000000000, "timestamp": "2024-03-09T10:00:00.000Z", "totalUsd": 12000000, "longUsd": 9800000, "shortUsd": 2200000}],
  "candles": [{"time": 1710000000, "open": 68000, "high": 68400, "low": 67500, "close": 67800}],
  "filters": {"q": 0.99, "minLongShare": 0.8, "zMin": 1.5, "zWindowHours": 168},
  "ranges": {"delayMin": 0, "delayMax": 3, "delayStep": 0.5, "holdMin": 1, "holdMax": 24, "holdStep": 1},
  "scoring": {"riskPenalty": 0.5, "holdPenaltyPerHour": 0.0005, "delayPenaltyPerHour": 0.0002, "uncertaintyPenalty": 0.35, "minExpectedRet": -0.03, "regimeBias": 0.01},
  "memory": {"k": 40, "minHistoryEvents": 80},
  "regime": {"horizonHours": 6, "retThreshold": 0.008, "drawdownThreshold": 0.015},
  "targetTs": 0,
  "baseline": {"entryDelayHours": 1, "holdHours": 8}
}
```

Các field chính trong response:
- `meta`: thống kê số lượng event/k/threshold
- `targetEvent`: feature snapshot tại t0
- `regime`: logits/probabilities + top neighbors
- `actions`: bảng action đã chấm điểm + chosen + baseline

---

## 13) Cảnh báo quan trọng khi dùng thực tế

- Đây là mô hình memory-based inference, không phải bảo đảm lợi nhuận.
- Kết quả nhạy với chất lượng dữ liệu (coverage, gap, sai timestamp).
- Nếu thị trường đổi regime mạnh, dữ liệu lịch sử cũ có thể mất tác dụng.
- `Realized` trên trang là kiểm thử lịch sử để audit, không phải bằng chứng live forward.

---

## 14) Preset gợi ý cho người mới

### Preset A: Cân bằng
- `q=0.99`, `minLongShare=0.8`, `zMin=1.5`, `zWindowHours=168`
- `k=40`, `minHistoryEvents=80`
- delay `0..2h`, hold `2..12h`

### Preset B: Nhiều tín hiệu hơn
- `q=0.97`, `minLongShare=0.7`, `zMin=1.2`, `zWindowHours=96`
- `k=50`, `minHistoryEvents=100`

### Preset C: Rất chặt
- `q=0.995`, `minLongShare=0.85`, `zMin=2.0`, `zWindowHours=168`
- giữ `uncertaintyPenalty` cao để giảm overtrade

---

## 15) Checklist thao tác nhanh cho user mới

1. Chọn dataset có coverage tốt.
2. Giữ preset A trước khi tự tinh chỉnh.
3. Chạy inference ở event mới nhất.
4. Đọc regime probabilities.
5. Chọn action có score cao nhưng sample đủ lớn và uncertainty không quá cao.
6. So với baseline.
7. Chỉ dùng như lớp xác nhận timing, không dùng độc lập một mình.

---

## 16) Mapping nhanh tham số -> tác động

- Tăng `q`: ít event hơn, cực đoan hơn.
- Tăng `minLongShare`: tập trung hơn vào long-squeeze.
- Tăng `zMin`: chỉ giữ cú sốc bất thường.
- Tăng `k`: mượt hơn, nhưng dễ “loãng tính giống”.
- Tăng `riskPenalty`: ưu tiên action ít drawdown.
- Tăng `uncertaintyPenalty`: loại các action không ổn định.
- Tăng `holdPenaltyPerHour`: tránh giữ quá lâu.
- Tăng `delayPenaltyPerHour`: ưu tiên vào sớm hơn.

---

## 17) Kết luận

`Phân tích 3` là lớp suy luận “event hiện tại -> lịch sử tương đồng -> đề xuất timing”.

Giá trị lớn nhất của trang không phải dự đoán tuyệt đối, mà là:
- chuẩn hóa cách đọc liquidation event,
- định lượng xác suất regime,
- và biến quyết định Delay/Hold thành bài toán có điểm số, có ràng buộc rủi ro, có kiểm chứng baseline.
