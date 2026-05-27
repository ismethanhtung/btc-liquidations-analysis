import os
import time
import csv
import requests
from datetime import datetime, timezone, timedelta

API_KEY = os.environ.get("COINALYZE_API_KEY")
if not API_KEY:
    raise SystemExit("Missing COINALYZE_API_KEY. Run: export COINALYZE_API_KEY='your_key_here'")

# Thường Coinalyze dùng symbol dạng BTCUSDT_PERP.A cho Binance BTCUSDT perpetual.
# Nếu symbol này không đúng, script sẽ in lỗi để mình đổi lại.
SYMBOL = "BTCUSDT_PERP.A"
INTERVAL = "daily"

END = datetime.now(timezone.utc)
START = END - timedelta(days=365 * 2)

url = "https://api.coinalyze.net/v1/liquidation-history"

params = {
    "symbols": SYMBOL,
    "interval": INTERVAL,
    "from": int(START.timestamp()),
    "to": int(END.timestamp()),
}

headers = {
    "api_key": API_KEY
}

print("Requesting:", params)

r = requests.get(url, params=params, headers=headers, timeout=30)
print("HTTP:", r.status_code)

if r.status_code != 200:
    print(r.text)
    raise SystemExit("Request failed")

data = r.json()

if not data:
    raise SystemExit("No data returned")

item = data[0]
history = item.get("history", [])

if not history:
    print(data)
    raise SystemExit("No history returned. Symbol may be wrong.")

out = "btc_liquidation_coinalyze_2y_daily.csv"

with open(out, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["datetime_utc", "timestamp", "long_liquidations", "short_liquidations", "total_liquidations"])

    for row in history:
        ts = row["t"]
        long_liq = row.get("l", 0)
        short_liq = row.get("s", 0)
        dt = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()

        writer.writerow([
            dt,
            ts,
            long_liq,
            short_liq,
            long_liq + short_liq
        ])

print(f"Saved: {out}")
print(f"Rows: {len(history)}")
