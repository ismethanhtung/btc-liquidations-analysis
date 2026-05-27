#!/usr/bin/env bash
set -u

SYMBOL="BTCUSDT"

# Binance USDT-M liquidationSnapshot hiện có dữ liệu lịch sử,
# nhưng có thể thiếu một số ngày. Script sẽ tự bỏ qua ngày 404.
START="2022-04-01"
END="2024-03-31"

BASE="https://data.binance.vision/data/futures/um/daily/liquidationSnapshot/${SYMBOL}"
OUT="binance_liquidation_${SYMBOL}"

mkdir -p "$OUT/zips" "$OUT/csv"

current="$START"

while true; do
  file="${SYMBOL}-liquidationSnapshot-${current}.zip"
  url="${BASE}/${file}"
  zip_path="$OUT/zips/$file"

  echo "Downloading $file"

  if curl -fL --retry 3 --retry-delay 2 -o "$zip_path" "$url"; then
    unzip -o "$zip_path" -d "$OUT/csv" >/dev/null
    echo "OK: $current"
  else
    echo "Missing or failed: $current"
    rm -f "$zip_path"
  fi

  if [[ "$current" == "$END" ]]; then
    break
  fi

  current=$(python3 - "$current" <<'PY'
import sys
from datetime import datetime, timedelta

d = datetime.strptime(sys.argv[1], "%Y-%m-%d")
print((d + timedelta(days=1)).strftime("%Y-%m-%d"))
PY
)
done

echo "Done."
echo "CSV files are in: $OUT/csv"
