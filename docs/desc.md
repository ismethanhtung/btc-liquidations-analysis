nhận ra rằng chỉ số tiền thanh lý long thôi là chưa đủ, cần phải xem cả short nữa, vì chỉ đơn giản như là hôm đó có nhiều giao dịch 

Rất chuẩn. 4 tham số này là “bộ lọc để gọi tên một nến là cascade hay không”.  
Mình giải thích theo kiểu người mới, có ví dụ số cụ thể.

## 1) `Quantile` (ví dụ `0.95`) có thể cho chạy từ 0.9 đến 0.99, đơn vị sẽ có thể là 0.01
Ý nghĩa: lọc theo **độ lớn tuyệt đối** của liquidation.

- Bạn có toàn bộ dãy `totalUsd` (mỗi nến có 1 giá trị).
- `quantile = 0.95` nghĩa là lấy mốc mà **95% nến nằm dưới**, chỉ **5% nến nằm trên**.
- Chỉ các nến có `totalUsd >= ngưỡng này` mới qua cửa.

Hình dung:
- Giống “điểm chuẩn top 5%”.
- `0.90` dễ qua hơn (top 10%).
- `0.99` khó qua hơn (top 1%, cực đoan nhất).

Ví dụ:
- Giả sử ngưỡng P95 = `10 triệu USD`.
- Nến A `totalUsd = 8 triệu` -> rớt.
- Nến B `totalUsd = 12 triệu` -> qua.

Mẹo:
- Muốn nhiều tín hiệu: giảm từ `0.95` xuống `0.90`.
- Muốn chỉ bắt cú cực mạnh: tăng lên `0.97` hoặc `0.99`.

---

## 2) `Long share tối thiểu` (ví dụ `0.65`) do có thể gặp trường hợp giá giờ đó biến động nhiều nên thanh lý long + short nhiều chứ không phải chỉ long -> bắt long mạnh thì nó sẽ chuẩn cascade
Ý nghĩa: lọc xem cú thanh lý đó có **nghiêng về long bị quét** không.

Công thức:
- `longShare = longUsd / totalUsd`

Ví dụ:
- `longUsd = 7M`, `shortUsd = 3M` -> `longShare = 0.70` (70%)
- Nếu minLongShare = `0.65` -> pass.
- Nếu nến có `longShare = 0.52` -> fail.

Tại sao cần tham số này?
- Bạn đang tìm setup “long bị thanh lý mạnh -> có thể có nhịp hồi”.
- Nếu longShare thấp, có thể đó là short bị quét hoặc trung tính, không đúng thesis.

Mẹo:
- `0.55-0.60`: mềm, nhận nhiều nến hơn.
- `0.65`: cân bằng.
- `0.75-0.85`: rất khắt khe, chỉ giữ nến cực lệch về long liquidation.

---

## 3) `Z-Score tối thiểu` (ví dụ `1.5`)
Ý nghĩa: đo nến hiện tại **bất thường bao nhiêu** so với “mức bình thường gần đây”.

Công thức:
- `z = (x - mean) / std`
- `x` = totalUsd nến hiện tại
- `mean`, `std` = trung bình và độ lệch chuẩn trong cửa sổ gần đây (do tham số `Cửa sổ Z` quyết định)

Hiểu nhanh:
- `z = 0`: đúng mức trung bình.
- `z = 1`: cao hơn trung bình 1 độ lệch chuẩn.
- `z = 2`: rất bất thường.
- `z = 3`: cực bất thường.

Ví dụ cụ thể:
- Trong cửa sổ gần đây:
  - mean = `3M`
  - std = `2M`
- Nến hiện tại total = `8M`
- `z = (8-3)/2 = 2.5` -> rất mạnh.
- Nếu đặt `zMin=1.5` -> pass.
- Nếu `zMin=3` -> fail.

Tại sao không dùng mỗi quantile?
- Quantile nhìn “độ lớn toàn cục”.
- Z-score nhìn “độ sốc cục bộ gần đây”.
- Kết hợp cả 2 giúp tránh:
  - Nến lớn nhưng trong giai đoạn vốn đã nhiễu mạnh liên tục.
  - Hoặc nến chỉ hơi lớn nhưng bình thường.

---

## 4) `Cửa sổ Z (giờ)` (ví dụ `168`)
Ý nghĩa: xác định “lịch sử gần đây” để tính mean/std cho z-score.

- `168 giờ = 7 ngày` (nếu data 1h).
- Nếu data 30m thì 168 giờ tương đương 336 nến.

Ảnh hưởng:
- Cửa sổ nhỏ (24h, 48h):
  - phản ứng nhanh
  - nhạy, nhiều tín hiệu hơn
  - nhưng dễ nhiễu.
- Cửa sổ lớn (168h, 336h):
  - ổn định hơn
  - ít nhiễu
  - nhưng chậm thích nghi regime mới.

Ví dụ trực quan:
- Tuần vừa rồi biến động thấp -> mean/std thấp -> nến to sẽ có z rất cao.
- Tuần vừa rồi biến động cao -> mean/std cao -> cùng nến đó z thấp hơn.

---

## Ghép 4 tham số lại (đây là điểm quan trọng)
Một nến chỉ được gắn nhãn cascade khi **đồng thời**:

1. `totalUsd >= quantile threshold`
2. `longShare >= minLongShare`
3. `zScore >= zMin`

Nghĩa là nến phải:
- đủ to (quantile),
- đủ nghiêng về long liquidation (longShare),
- đủ bất thường so với gần đây (z-score).

---

## Bộ tham số mẫu cho người mới

1. **Balanced (khởi đầu tốt)**
- `q=0.95`
- `minLongShare=0.65`
- `zMin=1.5`
- `zWindowHours=168`

2. **Nhiều tín hiệu hơn (khám phá)**
- `q=0.90`
- `minLongShare=0.60`
- `zMin=1.0`
- `zWindowHours=72`

3. **Cực chặt (chỉ bắt cú lớn)**
- `q=0.98`
- `minLongShare=0.75`
- `zMin=2.0`
- `zWindowHours=168`

---

Nếu bạn muốn, mình sẽ thêm luôn vào UI:
- tooltip “cực dễ hiểu” ngay cạnh từng tham số,
- preset 3 nút `Nới lỏng / Cân bằng / Rất chặt`
để bạn bấm 1 cái là đổi cả bộ tham số.




## Top kết quả (sắp xếp theo AvgRet)

| Rank |    Q | Long |  Z | Delay | Hold | Events | Win Rate |    AvgRet |
| ---- | ---: | ---: | -: | ----- | ---- | -----: | -------: | --------: |
| 1    | 0.99 | 0.60 |  3 | 0h    | 7h   |     26 |   76.92% | **0.65%** |
| 2    | 0.99 | 0.65 |  3 | 0h    | 7h   |     26 |   76.92% | **0.65%** |
| 3    | 0.99 | 0.70 |  3 | 0h    | 7h   |     26 |   76.92% | **0.65%** |
| 4    | 0.99 | 0.60 |  3 | 0.5h  | 12h  |     26 |   76.92% |     0.59% |
| 5    | 0.99 | 0.60 |  3 | 1h    | 12h  |     26 |   76.92% |     0.59% |
| 6    | 0.99 | 0.65 |  3 | 0.5h  | 12h  |     26 |   76.92% |     0.59% |
| 7    | 0.99 | 0.65 |  3 | 1h    | 12h  |     26 |   76.92% |     0.59% |
| 8    | 0.99 | 0.70 |  3 | 0.5h  | 12h  |     26 |   76.92% |     0.59% |
| 9    | 0.99 | 0.70 |  3 | 1h    | 12h  |     26 |   76.92% |     0.59% |
| 10   | 0.99 | 0.75 |  3 | 0h    | 7h   |     25 |   76.00% |     0.59% |
| 11   | 0.99 | 0.80 |  3 | 0h    | 7h   |     25 |   76.00% |     0.59% |
| 12   | 0.99 | 0.85 |  3 | 0h    | 7h   |     25 |   76.00% |     0.59% |
| 13   | 0.99 | 0.90 |  3 | 0h    | 7h   |     25 |   76.00% |     0.59% |
| 14   | 0.99 | 0.75 |  3 | 0.5h  | 12h  |     25 |   76.00% |     0.52% |
| 15   | 0.99 | 0.75 |  3 | 1h    | 12h  |     25 |   76.00% |     0.52% |
| 16   | 0.99 | 0.80 |  3 | 0.5h  | 12h  |     25 |   76.00% |     0.52% |
| 17   | 0.99 | 0.80 |  3 | 1h    | 12h  |     25 |   76.00% |     0.52% |
| 18   | 0.99 | 0.85 |  3 | 0.5h  | 12h  |     25 |   76.00% |     0.52% |
| 19   | 0.99 | 0.85 |  3 | 1h    | 12h  |     25 |   76.00% |     0.52% |
| 20   | 0.99 | 0.90 |  3 | 0.5h  | 12h  |     25 |   76.00% |     0.52% |

---

## Nhận xét nhanh

### Cấu hình tốt nhất

* `Q=0.99`
* `Long=0.60 → 0.70`
* `Z=3`
* `Delay=0h`
* `Hold=7h`

Kết quả:

* **26 events**
* **Win rate ~76.92%**
* **AvgRet ~0.65%** (cao nhất)

---

## Pattern dễ thấy

### 1. Delay = 0h outperform

* Khi tăng delay lên `0.5h` hoặc `1h`
* AvgRet giảm:

  * `0.65% → 0.59%`
  * hoặc `0.59% → 0.52%`

=> Tín hiệu mạnh nhất ngay khi xuất hiện.

---

### 2. Hold 7h tốt hơn 12h

* Hold lâu hơn không giúp tăng lợi nhuận.
* Có vẻ alpha decay khá nhanh sau ~7h.

---

### 3. Long threshold quá cao làm giảm số trade

* `Long=0.75 → 0.90`
* Events giảm:

  * `26 → 25`
* AvgRet cũng giảm:

  * `0.65% → 0.59%`

=> Threshold quá chặt bắt đầu loại bỏ cả trade tốt.

---

## Tóm tắt cuối

* Đã test: **58,800 tổ hợp**
* Vùng tham số tốt nhất hiện tại:

| Param | Sweet Spot |
| ----- | ---------- |
| Q     | 0.99       |
| Long  | 0.60–0.70  |
| Z     | 3          |
| Delay | 0h         |
| Hold  | 7h         |

* Strategy có dấu hiệu:

  * edge ổn định
  * decay nhanh
  * entry timing quan trọng hơn hold lâu
