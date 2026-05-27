#!/usr/bin/env bash
set -u

SYMBOL="BTCUSDT"
OUT="binance_liquidation_${SYMBOL}"

LIST_URL="https://data.binance.vision/?prefix=data/futures/um/daily/liquidationSnapshot/${SYMBOL}/"
BASE_URL="https://data.binance.vision/data/futures/um/daily/liquidationSnapshot/${SYMBOL}"

mkdir -p "$OUT/zips" "$OUT/csv"

echo "Fetching file list from Binance..."
curl -fsSL "$LIST_URL" > "$OUT/list.html"

grep -o "${SYMBOL}-liquidationSnapshot-[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\.zip" "$OUT/list.html" \
  | sort -u > "$OUT/files.txt"

COUNT=$(wc -l < "$OUT/files.txt" | tr -d ' ')

echo "Found $COUNT files."

if [[ "$COUNT" == "0" ]]; then
  echo "No files found. Binance page format may have changed, or this folder has no files."
  exit 1
fi

echo "First files:"
head "$OUT/files.txt"

echo "Last files:"
tail "$OUT/files.txt"

while read -r file; do
  zip_path="$OUT/zips/$file"
  url="$BASE_URL/$file"

  if [[ -f "$zip_path" ]]; then
    echo "Already downloaded: $file"
  else
    echo "Downloading: $file"
    curl -fL --retry 3 --retry-delay 2 -o "$zip_path" "$url" || {
      echo "Failed: $file"
      rm -f "$zip_path"
      continue
    }
  fi

  unzip -o "$zip_path" -d "$OUT/csv" >/dev/null
done < "$OUT/files.txt"

echo "Done."
echo "CSV files are in: $OUT/csv"
