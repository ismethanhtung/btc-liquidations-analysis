# Paper Trading — Strategy Author Guide

This guide is for teammates who want to build their **own** paper-trading
strategy for Polymarket **daily** crypto up/down markets (resolve at noon ET).

You only write the trading *decision*. The engine handles everything else:
finding the market, live data feeds, simulated execution, fills, fees,
cooldowns, inventory, session resolution, stats, and the live dashboard.

---

## TL;DR

1. Create `papertrade/strategies/<your_name>.py`.
2. Subclass `BaseDailyPaperTrader` and implement `decide()`.
3. Register it in `papertrade/daily_paper_trader.py` (`STRATEGIES` dict).
4. Run: `python papertrade/daily_paper_trader.py --coin btc --strategy <your_name>`.

That's it. Copy `papertrade/strategies/simple_probability.py` as a template.

---

## How the system fits together

```
run_daily_paper_trader.py          # launches the TUI dashboard
  └─ daily_paper_trader_tui.py     # spawns the trader as a subprocess, parses its output
       └─ daily_paper_trader.py    # thin runner: picks a strategy from STRATEGIES, runs it
            └─ strategies/*.py      # YOUR strategy: subclass of BaseDailyPaperTrader
                 └─ base_trader.py  # the engine (template) — feeds, execution sim, stats
                      ├─ probability_model.py     # importable P(Up) model (GBM + vol)
                      ├─ crypto_updown_markets.py  # Gamma API market finder
                      ├─ poly_market_feed.py       # Polymarket order book feed
                      └─ polymarket_taker_fee.py   # fee curve
```

- **`base_trader.py`** is the template. Don't edit it to make a new strategy —
  subclass it. It exposes a small, stable interface (below).
- **`probability_model.py`** is importable on its own if you just want P(Up).

---

## The strategy interface

### What you receive: `MarketContext`

`decide()` is called on a timer (default every 1.0s). It gets a fresh snapshot:

| Field | Type | Meaning |
|-------|------|---------|
| `coin` | `str` | `"btc"`, `"eth"`, ... |
| `now` | `float` | Unix timestamp |
| `spot` | `float \| None` | Binance spot mid for the coin |
| `yes_bid` / `yes_ask` / `yes_mid` | `float \| None` | Polymarket YES book (prob 0–1) |
| `no_bid` / `no_ask` | `float \| None` | Polymarket NO book (prob 0–1) |
| `session_id` | `str \| None` | Resolution date ISO, e.g. `2026-06-22` |
| `strike` | `float \| None` | Price-to-beat = Binance price at noon ET open |
| `time_left_hours` | `float` | Hours until noon ET resolution |
| `inv_yes` / `inv_no` / `inv_net` | `float` | Current session inventory (shares) |
| `market_prob_up` | `float \| None` | Convenience: market-implied P(Up) = `yes_mid` |

> ⚠️ Fields can be `None` before feeds warm up. Always guard (e.g.
> `if ctx.spot is None: return None`).

### What you return: `TradeDecision` (or `None`)

```python
TradeDecision(
    side="YES",          # "YES" = bet Up, "NO" = bet Down
    reason="my-signal",  # short tag shown in [PT-FIRE] logs + TUI
    size=None,           # optional shares override; default = engine sizing
)
```

Return `None` to do nothing this tick. The engine then enforces:
- per-side single in-flight order,
- per-side cooldown after a fill (`--fill-cooldown`),
- inventory cap (`--max-inv`), sizing, taker bump, latency, fills, fees.

So you never manage orders directly — just say *if* and *which side*.

---

## Minimal strategy

```python
# papertrade/strategies/my_strategy.py
from __future__ import annotations

import argparse
import logging
from typing import Optional

from papertrade.base_trader import BaseDailyPaperTrader, MarketContext, TradeDecision

logger = logging.getLogger("daily-paper-trader")


class MyStrategy(BaseDailyPaperTrader):
    def __init__(self, coin_id: str, args: argparse.Namespace):
        super().__init__(coin_id, args)
        logger.info("[STRAT] MyStrategy started")

    def decide(self, ctx: MarketContext) -> Optional[TradeDecision]:
        if ctx.market_prob_up is None:
            return None
        # Example: buy YES when the market prices Up cheaply.
        if ctx.market_prob_up < 0.30:
            return TradeDecision(side="YES", reason=f"cheap-up {ctx.market_prob_up:.2f}")
        if ctx.market_prob_up > 0.70:
            return TradeDecision(side="NO", reason=f"expensive-up {ctx.market_prob_up:.2f}")
        return None
```

Register it:

```python
# papertrade/daily_paper_trader.py
from papertrade.strategies.my_strategy import MyStrategy

STRATEGIES = {
    "an_simple": AnSimpleProbabilityTrader,
    "my_strategy": MyStrategy,          # <-- add this
}
```

Run it:

```bash
python papertrade/daily_paper_trader.py --coin btc --strategy my_strategy
```

---

## Using the P(Up) probability model

The model estimates P(Up) with Geometric Brownian Motion using spot, strike,
time-to-noon, and volatility from recent Binance hourly returns.

```python
from papertrade.probability_model import DailyBtcProbabilityModel

class MyModelStrategy(BaseDailyPaperTrader):
    def __init__(self, coin_id, args):
        super().__init__(coin_id, args)
        self.model = DailyBtcProbabilityModel(symbol=self.coin_config.symbol)

    def decide(self, ctx):
        if ctx.spot is None or ctx.strike is None or ctx.time_left_hours <= 0.01:
            return None
        self.model.refresh_volatility()                 # cached ~5 min internally
        p_up = self.model.prob_up(ctx.spot, ctx.strike, ctx.time_left_hours)
        market = ctx.market_prob_up
        if market is None:
            return None
        edge = p_up - market
        if edge >= 0.05:
            return TradeDecision("YES", f"edge+{edge:.2f}")
        if edge <= -0.05:
            return TradeDecision("NO", f"edge{edge:.2f}")
        return None
```

You can also run the model standalone:

```bash
python -m papertrade.probability_model --strike 64198
```

---

## Optional hooks

Override these only if you need them.

### `on_fill(self, fill)` — react to a fill (async)

Called after every simulated fill (off the fill lock, so network IO is safe).
Use it to record/report trades. `fill` has: `side`, `size`, `price`, `fee`,
`cost`, `fill_time` (unix), `session_id`.

```python
import aiohttp
from papertrade.base_trader import PaperFill

async def on_fill(self, fill: PaperFill) -> None:
    sess = await self._get_session()          # shared aiohttp session
    payload = [{
        "marketId": self.market_id,
        "conditionId": self.condition_id,
        "account": "An",
        "outcome": "up" if fill.side == "YES" else "down",
        "price": round(fill.price, 4),
        "amount": round(fill.size * fill.price, 2),
        "timestamp": ...,                      # your timestamp format
    }]
    async with sess.post("https://.../api/trades", json=payload) as r:
        ...
```

> The built-in `an_simple` strategy already does this (account `"An"`, Vietnam
> timestamp). See `strategies/simple_probability.py`.

### `_strategy_model_probs(self)` — feed the dashboard `[PT-MODEL]` line

Return `(model_p_up, market_p_up)` so the TUI shows your P(Up) vs the market's,
alongside strike and time-left. Return `None` to skip.

```python
def _strategy_model_probs(self):
    ctx = self._build_context()
    if ctx.spot is None or ctx.strike is None:
        return (None, ctx.market_prob_up)
    return (self.model.prob_up(ctx.spot, ctx.strike, ctx.time_left_hours),
            ctx.market_prob_up)
```

---

## What you can read off `self`

Inside `decide()` / hooks you also have access to:

| Attribute | What |
|-----------|------|
| `self.coin_id`, `self.coin_config` | coin + Binance/Polymarket symbol mapping |
| `self.binance_mid` | latest Binance spot mid |
| `self.feed` | Polymarket feed (`.yes_bid/.yes_ask/.no_bid/.no_ask`) |
| `self.inventory` | live inventory (`.yes_shares`, `.no_shares`, `.net`, ...) |
| `self.session_id`, `self.session_open_price` | current daily session + strike |
| `self.condition_id`, `self.market_id`, `self.yes_token_id`, `self.no_token_id` | market identifiers |
| `self.pressure_tracker`, `self.binance_book`, `self.trade_flow`, `self.guard` | order-flow signal trackers (optional inputs) |
| `self.fill_cooldown_sec` | active per-side cooldown |
| `self._get_session()` | shared `aiohttp.ClientSession` (for API calls) |
| `self._build_context()` | build a fresh `MarketContext` on demand |

You generally won't touch order firing/filling — the engine owns that.

---

## Engine behavior you should know

- **Daily session**: one market per calendar day, rolls at **noon ET**. On roll,
  inventory resets, the previous session resolves vs Binance noon→noon close,
  and a new market is found automatically.
- **Strike** = Binance price captured a few seconds after the session opens at
  noon ET (so `ctx.strike` is `None` very briefly after a roll).
- **Execution**: taker BUY at best ask + bump ticks, simulated post latency,
  soft cancel on ask drift, hard cancel timeout. Fees use the Polymarket curve.
- **PnL**: realised PnL is the sum of resolved-session PnLs (each session is one
  self-contained trade). Open positions show as MTM until resolution.

---

## CLI flags

Shared engine flags (from `build_base_parser`) plus runner flags:

| Flag | Description |
|------|-------------|
| `--coin` | `btc`, `eth`, `sol`, `xrp` |
| `--strategy` | strategy key from `STRATEGIES` (default `an_simple`) |
| `--edge-threshold` | (probability strategies) take when \|P_model − P_market\| exceeds this |
| `--decide-interval` | seconds between `decide()` calls (default 1.0) |
| `--no-record` | disable the trades-API POST (for `an_simple`) |
| `--size` / `--max-inv` | order size (shares) / max NET inventory (default 15 / ±80) |
| `--test` / `--live` / `--default` | sizing presets |
| `--bump` | taker bump ticks above best ask |
| `--fill-cooldown` | per-side cooldown after a fill (seconds) |
| `--latency-ms` | fixed sim latency (omit for lognormal) |
| `--cancel-timeout` / `--cancel-ask-drift-ticks` | cancel policy |
| `--loose` | drop trade-flow confirmation (for the reference gate) |
| `--persist-stats` | save all-time stats under `papertrade/paper_state/daily/` |
| `--reset-stats` | delete persisted stats for the coin before start |

---

## Run with the dashboard

```bash
# from the papertrade repo root
pip install -r requirements.txt          # first time
python run_daily_paper_trader.py --coin btc
```

The TUI shows the underlying, market, Polymarket book, your `[PT-MODEL]` P(Up) /
strike / time-left, signal state, inventory, fills, and all-time stats.

To run headless (no TUI), invoke the trader directly:

```bash
python papertrade/daily_paper_trader.py --coin btc --strategy my_strategy
```

---

## Output tags (for parsing / debugging)

The trader prints structured lines the TUI consumes:

| Tag | Meaning |
|-----|---------|
| `[PT-STATUS]` | 1s heartbeat: feeds, book, signals, inventory, PnL |
| `[PT-MODEL]` | strike, time-left, P(Up) model vs market |
| `[PT-FIRE]` | an order was submitted |
| `[PT-FILL]` | an order filled |
| `[PT-CANCEL]` / `[PT-SKIP]` | order cancelled / signal skipped |
| `[PT-RESOLVE]` | a daily session resolved (winner + PnL) |
| `[PT-STATS]` | periodic all-time stats |
| `[TRADE-API]` | (an_simple) trade recording result |

---

## Checklist for a new strategy

- [ ] New file in `papertrade/strategies/`.
- [ ] Subclass `BaseDailyPaperTrader`, implement `decide()`.
- [ ] Guard against `None` fields in `MarketContext`.
- [ ] (Optional) override `on_fill` and/or `_strategy_model_probs`.
- [ ] Add to `STRATEGIES` in `daily_paper_trader.py`.
- [ ] Test: `python papertrade/daily_paper_trader.py --coin btc --strategy <name>`.
