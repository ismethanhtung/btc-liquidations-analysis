# Liquidation Cascade Research Notes

## User hypotheses (as requested)
- liquidation cascade — thanh ly day chuyen -> cai nay rat co the can duoc nghien cuu, phan tich, khai thac.
- toi muon nhu sau: vi du toi co dataset cua liquidation, toi co the nghien cuu ra mot cai, co the biet duoc khi nao vao la tot, vi du toi thay rat nhieu liquidation cascade, rat nhieu long da bi liquidation, thi toi co the biet duoc den khi nao la sap het thi toi se mua vao de no chuan bi len lai, toi se bat nhip de long.
- nen toi can rat nhieu phan tich, so lieu,... hay dung tap data set cua toi de lam duoc dieu do. voi 2 tap data set quan trong nhat la 2 nam 1h, va 30 phut.

## Datasets used
- 2y-1h: 2025-11-23T05:00:00.000Z -> 2026-05-22T04:00:00.000Z, bars=4316
- max-30m: 2026-02-21T05:30:00.000Z -> 2026-05-22T05:00:00.000Z, bars=4320

## Cascade definition used in this research
- total liquidation >= P95 of dataset
- long liquidation share >= 65%
- z-score of total liquidation >= 1.5 over rolling 7-day window

## Results: 2y-1h
- P95=10,196,213 USD, P99=27,240,265 USD
- Cascade events=86
- Avg return after 1h=-0.01%, 2h=-0.07%, 4h=-0.09%, 8h=-0.13%
- Win rate at 8h=48.84%
- Median best move within 24h=1.38%, median worst drawdown within 24h=-1.59%

## Results: max-30m
- P95=4,936,416 USD, P99=15,546,853 USD
- Cascade events=70
- Avg return after 1 bar=0.00%, 2 bars=0.03%, 4 bars=0.05%, 8 bars=-0.01%
- Win rate at 8 bars=55.71%
- Median best move within 24h=1.04%, median worst drawdown within 24h=-1.57%

## Practical exploitation framework (Long after long-side cascade)
- Step 1: detect cascade bar by thresholds above.
- Step 2: do not enter immediately. wait 1-2 bars for liquidation intensity to drop below P90 and price to stop making new low.
- Step 3: entry trigger = close breaks previous bar high while liquidation drops (exhaustion signal).
- Step 4: stop = cascade low - 0.5 ATR(14), take-profit partial at +1R and +2R.
- Step 5: avoid entries if funding/OI continue moving against rebound (need extra dataset in next phase).

## Next analysis expansions
- Add open interest + funding + CVD to discriminate true exhaustion vs continuation crash.
- Backtest with transaction cost and slippage by session (Asia/EU/US).
- Build regime segmentation: trend day vs mean-revert day.

## Top cascade events (2y-1h)
- 2026-02-05T20:00:00.000Z | total=142,378,251 | longShare=94.4% | z=6.74 | best24h=12.11% | worst24h=-5.92%
- 2026-02-06T00:00:00.000Z | total=130,424,219 | longShare=72.2% | z=5.51 | best24h=12.98% | worst24h=0.00%
- 2026-01-31T18:00:00.000Z | total=115,742,433 | longShare=96.4% | z=7.09 | best24h=1.78% | worst24h=-1.64%
- 2026-01-30T01:00:00.000Z | total=111,592,448 | longShare=98.6% | z=10.07 | best24h=2.61% | worst24h=-1.59%
- 2026-02-05T15:00:00.000Z | total=89,883,352 | longShare=93.8% | z=4.87 | best24h=2.52% | worst24h=-11.10%
- 2026-01-31T17:00:00.000Z | total=88,630,988 | longShare=95.1% | z=6.46 | best24h=0.67% | worst24h=-4.02%
- 2026-05-17T23:00:00.000Z | total=87,224,418 | longShare=98.3% | z=10.12 | best24h=0.44% | worst24h=-1.82%
- 2026-01-29T15:00:00.000Z | total=72,104,169 | longShare=97.0% | z=11.49 | best24h=0.83% | worst24h=-4.49%
- 2026-02-03T18:00:00.000Z | total=58,170,512 | longShare=98.9% | z=3.23 | best24h=5.24% | worst24h=-1.33%
- 2026-01-19T00:00:00.000Z | total=56,230,679 | longShare=95.4% | z=5.10 | best24h=0.76% | worst24h=-0.60%

## Top cascade events (max-30m)
- 2026-05-17T23:30:00.000Z | total=82,747,709 | longShare=98.3% | z=14.96 | best24h=0.44% | worst24h=-1.82%
- 2026-03-29T22:30:00.000Z | total=39,718,729 | longShare=94.2% | z=9.80 | best24h=3.51% | worst24h=-0.09%
- 2026-03-21T23:30:00.000Z | total=38,980,792 | longShare=99.8% | z=11.71 | best24h=0.97% | worst24h=-2.26%
- 2026-04-27T15:00:00.000Z | total=38,570,997 | longShare=99.8% | z=11.87 | best24h=0.81% | worst24h=-1.55%
- 2026-05-15T13:30:00.000Z | total=34,950,808 | longShare=99.7% | z=12.68 | best24h=1.02% | worst24h=-1.42%
- 2026-04-16T13:30:00.000Z | total=33,431,714 | longShare=99.1% | z=9.66 | best24h=4.92% | worst24h=-0.49%
- 2026-05-16T07:00:00.000Z | total=32,118,582 | longShare=98.4% | z=9.60 | best24h=0.12% | worst24h=-1.05%
- 2026-04-29T18:00:00.000Z | total=31,781,311 | longShare=99.1% | z=10.11 | best24h=2.02% | worst24h=-0.26%
- 2026-03-08T22:00:00.000Z | total=26,589,232 | longShare=98.7% | z=8.79 | best24h=5.46% | worst24h=-0.28%
- 2026-03-27T10:30:00.000Z | total=25,981,507 | longShare=98.8% | z=5.95 | best24h=0.52% | worst24h=-1.43%
