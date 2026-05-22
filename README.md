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
# btc-liquidations-analysis
