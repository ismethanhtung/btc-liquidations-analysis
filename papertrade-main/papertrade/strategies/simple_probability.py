"""
An — Simple Probability Strategy
================================

A minimal strategy built on `BaseDailyPaperTrader`. It compares the model's
P(Up) against the market-implied P(Up) (the YES mid price) and takes a position
when they disagree by more than a threshold.

Logic
-----
1. Estimate model P(Up) with the GBM probability model:
   spot (Binance mid), strike (today's noon ET open), time-to-noon, and a
   volatility estimate from recent Binance hourly returns.
2. market_p = YES mid price (Polymarket's implied P(Up)).
3. edge = model_p - market_p
     - edge >= +threshold  -> market underprices Up -> BUY YES
     - edge <= -threshold  -> market overprices Up   -> BUY NO
     - otherwise           -> do nothing
4. After a fill, the engine enforces a per-side cooldown (default 30s here).
5. Every fill is reported to the trades API (account="An", Vietnam timestamp).

Copy this file as a starting point for your own strategy and edit `decide()`.
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiohttp

from papertrade.base_trader import (
    BaseDailyPaperTrader,
    MarketContext,
    PaperFill,
    TradeDecision,
)
from papertrade.probability_model import DailyBtcProbabilityModel

logger = logging.getLogger("daily-paper-trader")

DEFAULT_EDGE_THRESHOLD = 0.05   # take when |model P(Up) - market P(Up)| > 5%
DEFAULT_COOLDOWN_SEC = 30.0     # per-side cooldown after a fill

# Trade-recording API
TRADES_API_URL = "https://infra-fe.vercel.app/api/trades"
ACCOUNT_NAME = "An"
VN_TZ = timezone(timedelta(hours=7))   # Vietnam time (UTC+7)


class AnSimpleProbabilityTrader(BaseDailyPaperTrader):
    """Take when model P(Up) and market P(Up) diverge by > edge_threshold.

    Records every fill to the trades API under account "An".
    """

    def __init__(self, coin_id: str, args: argparse.Namespace):
        super().__init__(coin_id, args)
        self.edge_threshold = float(getattr(args, "edge_threshold", DEFAULT_EDGE_THRESHOLD))
        # Probability model keyed to this coin's Binance symbol.
        self.model = DailyBtcProbabilityModel(symbol=self.coin_config.symbol)
        # Diagnostics for logging.
        self._last_model_p: Optional[float] = None
        self._last_market_p: Optional[float] = None
        self.record_trades = not bool(getattr(args, "no_record", False))
        logger.info(
            f"[STRAT] An SimpleProbability — edge>{self.edge_threshold:.0%} "
            f"cooldown={self.fill_cooldown_sec:.0f}s symbol={self.coin_config.symbol} "
            f"record_trades={self.record_trades} account={ACCOUNT_NAME}"
        )

    def decide(self, ctx: MarketContext) -> Optional[TradeDecision]:
        # Need spot, strike, market price and meaningful time left.
        if ctx.spot is None or ctx.strike is None or ctx.market_prob_up is None:
            return None
        if ctx.time_left_hours <= 0.01:
            return None

        # Keep volatility fresh (the model caches for ~5 min internally).
        self.model.refresh_volatility()

        model_p = self.model.prob_up(ctx.spot, ctx.strike, ctx.time_left_hours)
        market_p = ctx.market_prob_up
        edge = model_p - market_p

        self._last_model_p = model_p
        self._last_market_p = market_p

        if edge >= self.edge_threshold:
            return TradeDecision(
                side="YES",
                reason=f"Pmodel={model_p:.2f}>Pmkt={market_p:.2f} edge+{edge:.2f}",
            )
        if edge <= -self.edge_threshold:
            return TradeDecision(
                side="NO",
                reason=f"Pmodel={model_p:.2f}<Pmkt={market_p:.2f} edge{edge:.2f}",
            )
        return None

    def _strategy_model_probs(self):
        """Live (model P(Up), market P(Up)) for the [PT-MODEL] dashboard line."""
        ctx = self._build_context()
        market_p = ctx.market_prob_up
        if ctx.spot is None or ctx.strike is None or ctx.time_left_hours <= 0.01:
            return (None, market_p)
        self.model.refresh_volatility()
        model_p = self.model.prob_up(ctx.spot, ctx.strike, ctx.time_left_hours)
        return (model_p, market_p)

    # --------------------------------------------------------------------
    # Trade recording — POST each fill to the trades API
    # --------------------------------------------------------------------
    async def on_fill(self, fill: PaperFill) -> None:
        if not self.record_trades:
            return
        if not self.condition_id and not self.market_id:
            logger.warning("[TRADE-API] skip — no market/condition id yet")
            return

        payload = [{
            "marketId": str(self.market_id) if self.market_id is not None else "",
            "conditionId": self.condition_id or "",
            "account": ACCOUNT_NAME,
            "outcome": "up" if fill.side == "YES" else "down",
            "price": round(fill.price, 4),
            # USD notional of the fill (shares × price)
            "amount": round(fill.size * fill.price, 2),
            "timestamp": datetime.fromtimestamp(fill.fill_time, VN_TZ).isoformat(),
        }]

        try:
            sess = await self._get_session()
            async with sess.post(
                TRADES_API_URL,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as resp:
                body = await resp.text()
                if resp.status >= 300:
                    logger.warning(
                        f"[TRADE-API] {resp.status} recording {fill.side} "
                        f"@ {fill.price:.3f}: {body[:200]}"
                    )
                else:
                    logger.info(
                        f"[TRADE-API] recorded {fill.side}→{payload[0]['outcome']} "
                        f"price={payload[0]['price']} amount={payload[0]['amount']} "
                        f"ts={payload[0]['timestamp']} ({resp.status})"
                    )
        except Exception as e:
            logger.warning(f"[TRADE-API] post failed: {e}")
