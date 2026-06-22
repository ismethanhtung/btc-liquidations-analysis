# Papertrade

Standalone paper-trading infrastructure for Polymarket crypto up/down markets, forked from `pricefetch/livetrading`.

## Layout

```
papertrade/
├── papertrade/
│   ├── config/                    # Coin symbols (BTC, ETH, SOL, XRP)
│   ├── crypto_updown_markets.py   # Gamma API market finder (5m/15m/1h/4h/daily)
│   ├── poly_market_feed.py        # Polymarket WS + REST book feed
│   ├── polymarket_taker_fee.py    # Fee curve helpers
│   ├── probability_model.py       # Daily P(Up) from spot/strike/time/vol (importable)
│   ├── base_trader.py             # TEMPLATE engine — subclass + override decide()
│   ├── strategies/
│   │   ├── __init__.py
│   │   └── simple_probability.py  # Example strategy: P(Up) vs market, edge > 5%
│   ├── daily_paper_trader.py      # Thin runner: wires a strategy onto the engine
│   ├── daily_paper_trader_tui.py  # Daily Paper Trader TUI
│   ├── microprice_paper_trader.py # 5m paper trader (separate, legacy signal model)
│   └── microprice_paper_tui.py    # 5m TUI
├── requirements.txt
└── run_daily_paper_trader.py
```

## Writing your own strategy

> 📖 Full team guide: [`docs/README.md`](docs/README.md) — interface reference,
> hooks, examples, CLI flags, and a checklist for building your own version.


`base_trader.py` is the **template**: it builds the whole paper-trading engine
(market finding, feeds, simulated execution, fills, fees, cooldown, stats, TUI
output). You only implement the trading decision.

```python
from papertrade.base_trader import BaseDailyPaperTrader, MarketContext, TradeDecision

class MyStrategy(BaseDailyPaperTrader):
    def decide(self, ctx: MarketContext):
        # ctx gives you: spot, yes/no bid/ask/mid, strike, time_left_hours,
        # inventory (inv_yes/inv_no/inv_net), and ctx.market_prob_up (YES mid).
        if ctx.market_prob_up is not None and ctx.market_prob_up < 0.30:
            return TradeDecision(side="YES", reason="cheap-yes")
        return None   # do nothing this tick
```

Register it in `daily_paper_trader.py`'s `STRATEGIES` dict and select with
`--strategy <name>`. The engine enforces the per-side cooldown
(`--fill-cooldown`) after each fill.

### Built-in: `simple_prob`

Computes model **P(Up)** (GBM) and compares it to the market-implied P(Up)
(YES mid). If they differ by more than `--edge-threshold` (default 5%), it
takes the favored side, then cools down 30s:

```bash
python papertrade/daily_paper_trader.py --coin btc --strategy simple_prob --edge-threshold 0.05
```

## Setup

```bash
cd papertrade
pip install -r requirements.txt
```

## Run — Daily Paper Trader

```bash
python run_daily_paper_trader.py --coin btc
python papertrade/daily_paper_trader.py --coin eth --loose
```

## Probability model (BTC daily)

Estimates **P(Up)** using GBM: current price, strike (price-to-beat), time to noon ET, and hourly vol from Binance 1h returns (EWMA).

```bash
# Strike = previous noon close; spot and vol fetched live
python -m papertrade.probability_model --strike 62500

# Manual inputs
python -m papertrade.probability_model --strike 62500 --spot 63100 --hours-left 6.5
```

```python
from papertrade.probability_model import DailyBtcProbabilityModel

model = DailyBtcProbabilityModel()
model.refresh_volatility()
result = model.prob_up_now(strike=62_500.0, spot=63_100.0)
print(result.prob_up, result.summary())
```

## Run — 5 minute

```bash
python run_paper_tui.py --coin btc
```

## CLI flags (Daily Paper Trader TUI)

| Flag | Description |
|------|-------------|
| `--coin` | `btc`, `eth`, `sol`, `xrp` |
| `--size` / `--max-inv` | Order size and inventory cap |
| `--bump` | Taker bump ticks above best ask (default 5) |
| `--strategy` | Strategy name (default `simple_prob`) |
| `--edge-threshold` | `simple_prob`: take when \|P_model − P_market\| exceeds this (default 0.05) |
| `--fill-cooldown` | Per-side cooldown after a fill (default 30s for `simple_prob`) |
| `--decide-interval` | Seconds between strategy decisions (default 1.0) |
| `--persist-stats` | Save stats under `papertrade/paper_state/daily/` |
