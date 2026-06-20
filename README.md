# BTC Liquidation Lab

UI + data pipeline de nghien cuu tin hieu "long liquidation lon -> kha nang hoi".

## 1) Cai dat

```bash
npm install
```

## 2) Chay UI

```bash
npm run dev
```

## 3) Lay data that (2 nam)

1. Tao key Coinalyze va them vao `.env`:

```bash
cp .env.example .env
# sua COINALYZE_API_KEY
```

2. Chay fetch:

```bash
export $(cat .env | xargs) && npm run fetch:data
```

Script se tao:
- `data/btc_liquidation_2y.json`
- `data/btc_liquidation_2y.csv`

## 4) Ghi chu

- Liquidation lich su sau qua khu sau thuong can API data provider (Coinalyze).
- BTC price duoc lay tu Binance spot kline 1h.

## 5) Phatich5 live paper test tren Vercel

Cron route: `/api/phatich5/live-paper/run`

History route/UI: tab `Paper Live` trong `/phatich5`, hoac JSON tai `/api/phatich5/live-paper`.

Set env tren Vercel:

```bash
COINGLASS_API_KEY=...
BLOB_READ_WRITE_TOKEN=...
LIVE_PAPER_SOURCE=api
LIVE_PAPER_INTERVAL=5m
LIVE_PAPER_YEARS=0.05
LIVE_PAPER_BLOB_PATH=phatich5/live-paper-history.json
```

Neu chua set `BLOB_READ_WRITE_TOKEN`, local se ghi `data/live-paper-history.json`, nhung Vercel chi co the ghi `/tmp` nen lich su khong ben.
# btc-liquidations-analysis
