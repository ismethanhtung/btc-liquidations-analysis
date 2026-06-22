"""
Base Daily Paper Trader (TEMPLATE)
==================================

Reusable paper-trading engine for Polymarket **daily** crypto up/down markets
(resolve at noon ET). This file is the TEMPLATE your team copies/subclasses:
everything except the actual trading decision is already built for you.

What the engine handles for you
-------------------------------
- Finding the current daily market (Gamma API) and rolling at each noon ET.
- Live data feeds: Binance @bookTicker (spot mid) + @trade (trade flow), and the
  Polymarket order book (YES/NO bid/ask) via `PolyMarketFeed`.
- Simulated execution: realistic post latency, taker fills at best ask + bump,
  cancels (timeout / ask-drift), Polymarket-style fees, per-side cooldown.
- Inventory, session resolution vs Binance noon-to-noon close, all-time stats.
- Structured stdout the TUI consumes:
  [PT-STATUS] [PT-FIRE] [PT-FILL] [PT-CANCEL] [PT-SKIP] [PT-RESOLVE] [PT-STATS]

What YOU implement
------------------
Subclass `BaseDailyPaperTrader` and override ONE method:

    def decide(self, ctx: MarketContext) -> Optional[TradeDecision]:
        ...

Return a `TradeDecision(side="YES"|"NO", reason=...)` to fire a paper taker
order, or `None` to do nothing. The engine enforces cooldown, sizing, fills,
and accounting. See `papertrade/strategies/simple_probability.py` for a
worked example using the P(up) probability model.

Optional helpers available on `self` for richer strategies:
    self.pressure_tracker, self.binance_book, self.trade_flow, self.guard
    self.binance_mid (spot), self.feed (Polymarket book), self.inventory
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import os
import random
import statistics
import sys
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Deque, Dict, List, Optional, Tuple

import aiohttp
import websockets
from dotenv import load_dotenv

try:
    import orjson
    def _json_loads(s):
        return orjson.loads(s)
except ImportError:
    import json as _json
    def _json_loads(s):
        return _json.loads(s)

# ── Path setup
_CURRENT_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
_PACKAGE_ROOT = _CURRENT_DIR.parent
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))

from papertrade.config import get_coin_config
from papertrade.polymarket_taker_fee import PAPER_FEE_RATE_AT_MID
from papertrade.poly_market_feed import PolyMarketFeed

import pytz

try:
    from papertrade.crypto_updown_markets import (
        ET_TZ,
        UTC_TZ,
        _current_daily_resolution_date,
        find_btc_daily_market,
        find_eth_daily_market,
        find_sol_daily_market,
        find_xrp_daily_market,
    )
except ImportError:
    ET_TZ = pytz.timezone("America/New_York")
    UTC_TZ = pytz.UTC
    _current_daily_resolution_date = None  # type: ignore
    find_btc_daily_market = find_eth_daily_market = find_sol_daily_market = find_xrp_daily_market = None  # type: ignore

try:
    import binance_sbe  # type: ignore
    _SBE_AVAILABLE = True
except ImportError:
    _SBE_AVAILABLE = False

# ── Logging ──────────────────────────────────────────────────────────────────
# Force UTF-8 stdout so status lines containing →, ≈, Δ, ≥ don't crash the
# logger on Windows consoles (cp1252). Without this, [PT-*] lines silently drop.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("daily-paper-trader")
for noisy in ("urllib3", "requests", "httpcore", "httpx", "websockets"):
    logging.getLogger(noisy).setLevel(logging.WARNING)


# ============================================================================
# CONSTANTS — paper-trader gate (stronger than the live MM defaults)
# ============================================================================
# Live MM defaults (for reference): pressure=30%, flow+skew=50%, alone=80%,
# trade flow ±0.30. We push every threshold up so only high-conviction
# signals fire.
PAPER_PRESSURE_WINDOW_SEC      = 2.0
PAPER_PRESSURE_THRESHOLD_PCT   = 60.0
PAPER_SKEW_FLOW_THRESHOLD_PCT  = 70.0
PAPER_SKEW_ALONE_THRESHOLD_PCT = 92.0
PAPER_TRADE_FLOW_BULL          = 0.50
PAPER_TRADE_FLOW_BEAR          = -0.50
PAPER_TRADE_FLOW_WINDOW_SEC    = 3.0
PAPER_TRADE_FLOW_MAX_WINDOW    = 30.0

# Skew (top-of-book) confirmation
PAPER_SKEW_PLACE_THRESHOLD     = 0.80
PAPER_SKEW_PERSISTENCE_COUNT   = 3
PRESSURE_MAX_SAMPLES           = 200

# ============================================================================
# CONSTANTS — paper-trader execution
# ============================================================================
PAPER_DEFAULT_BUMP_TICKS    = 5      # GTC bump-5 → limit price = best_ask + 5 ticks
# Default simulated post_order RTT (lognormal targeting these quantiles); `--latency-ms` fixes ms.
PAPER_LATENCY_MEDIAN_MS     = 929.0
PAPER_LATENCY_P95_MS        = 2681.0
_PHI_INV_95                 = 1.6448536269514722  # Φ⁻¹(0.95)
PAPER_CANCEL_TIMEOUT_SEC    = 8.0   # hard backstop from submit — match microprice_taker_5m
PAPER_CANCEL_ASK_DRIFT_TICKS = 5     # soft cancel if best_ask drifts above limit — match live
PAPER_FILL_COOLDOWN_SEC     = 10.0   # cooldown per side after every fill
PAPER_FILL_COOLDOWN_TAIL_SEC = 3600.0  # last hour before noon ET resolution
PAPER_FILL_COOLDOWN_IN_TAIL_SEC = 5.0
PAPER_GUARD_WINDOW_MS       = 400    # "price didn't move against us" lookback

# Delay before pulling the session reference price (noon ET open) from Binance.
SESSION_OPEN_FETCH_DELAY_SEC   = 10.0
SESSION_OPEN_RETRY_DELAY_SEC   = 2.5
SESSION_OPEN_MAX_ATTEMPTS      = 4
PAPER_TICK_SIZE             = Decimal("0.01")
PAPER_MIN_PRICE             = Decimal("0.01")
PAPER_MAX_PRICE             = Decimal("0.99")
PAPER_MIN_ORDER_SIZE        = Decimal("5")   # mirrors live MM
PAPER_INITIAL_EQUITY        = 2_000.0   # USDC — used ONLY as the ROI denominator
# Backwards-compat alias (older state files / CLI args still reference "bankroll")
PAPER_DEFAULT_BANKROLL      = PAPER_INITIAL_EQUITY

# Per-coin default sizes — size=15, max NET inventory=±80 for all coins
PAPER_COIN_SIZES: Dict[str, Tuple[Decimal, Decimal]] = {
    "btc": (Decimal("15"), Decimal("80")),
    "eth": (Decimal("15"), Decimal("80")),
    "sol": (Decimal("15"), Decimal("80")),
    "xrp": (Decimal("15"), Decimal("80")),
}
# Mode presets (mirrors live MM --test / --live / --default)
PAPER_MODE_TEST    = (Decimal("15"), Decimal("80"))
PAPER_MODE_LIVE    = (Decimal("30"), Decimal("160"))
PAPER_MODE_DEFAULT = (Decimal("30"), Decimal("150"))

# Inventory-based price-bump thresholds (mirrors live MM)
INV_TICK_BUMP_1_THRESHOLD = Decimal("0.30")  # >30% rebal ratio → +5 ticks
INV_TICK_BUMP_2_THRESHOLD = Decimal("0.60")  # >60% rebal ratio → +8 ticks
INV_TICK_BUMP_1_TICKS     = 5
INV_TICK_BUMP_2_TICKS     = 8

# Polymarket taker fee shape (see microprice_taker_5m.polymarket_fee): ≈7%×C×p(1−p);
# PAPER_FEE_RATE_AT_MID is fee/notional at p=0.5 (≈3.5%).
PAPER_FEE_RATE_AT_MID       = 0.035  # 3.5% of notional at p=0.5

# Binance feeds
BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws"
SBE_BASE_URL    = "wss://stream-sbe.binance.com:9443/ws"

# Optional on-disk stats (`--persist-stats` only)
PAPER_STATE_DIR = _CURRENT_DIR / "paper_state" / "daily"


def polymarket_fee(price: float, shares: float) -> float:
    """Taker-style fee: ≈ 7% × C × p(1−p) (see Polymarket activity / microprice_taker_5m)."""
    if shares <= 0 or price <= 0 or price >= 1:
        return 0.0
    return (2.0 * PAPER_FEE_RATE_AT_MID) * price * (1.0 - price) * shares


def _paper_lognormal_latency_params(median_ms: float, p95_ms: float) -> Tuple[float, float]:
    """`(mu, sigma)` for `random.lognormvariate` with given median and ~95th percentile ms."""
    md = max(1e-6, float(median_ms))
    p95 = max(md, float(p95_ms))
    mu = math.log(md)
    sigma = (math.log(p95) - mu) / _PHI_INV_95
    return mu, max(1e-9, sigma)


def _sample_paper_place_latency_ms(mu: float, sigma: float) -> float:
    """One simulated post-latency draw (ms); clamped for numerical sanity."""
    x = random.lognormvariate(mu, sigma)
    return max(5.0, min(60_000.0, x))


# ============================================================================
# SIGNAL CLASSES — copied verbatim from microprice_mm_5m.py to keep this
# file self-contained. Any change to the live MM signal logic must be
# mirrored here.
# ============================================================================

@dataclass
class BinanceBookState:
    """Top-of-book skew tracker with N-reading persistence filter."""
    bid_volume: float = 0.0
    ask_volume: float = 0.0
    bid_skew: float = 0.0
    ask_skew: float = 0.0
    last_update: float = 0.0
    place_threshold: float = PAPER_SKEW_PLACE_THRESHOLD
    persistence_count: int = PAPER_SKEW_PERSISTENCE_COUNT

    _consecutive_bid_skewed: int = 0
    _consecutive_ask_skewed: int = 0

    def update(self, bids: List, asks: List, min_level_usd: float) -> Tuple[float, float]:
        self.bid_volume = 0.0
        self.ask_volume = 0.0
        for b in bids[:1]:
            try:
                p, q = float(b[0]), float(b[1])
                v = p * q
                if v >= min_level_usd:
                    self.bid_volume += v
            except (ValueError, IndexError):
                continue
        for a in asks[:1]:
            try:
                p, q = float(a[0]), float(a[1])
                v = p * q
                if v >= min_level_usd:
                    self.ask_volume += v
            except (ValueError, IndexError):
                continue

        total = self.bid_volume + self.ask_volume
        if total > 0:
            self.bid_skew = self.bid_volume / total
            self.ask_skew = self.ask_volume / total
        else:
            self.bid_skew = self.ask_skew = 0.5

        if self.bid_skew >= self.place_threshold:
            self._consecutive_bid_skewed += 1
        else:
            self._consecutive_bid_skewed = 0
        if self.ask_skew >= self.place_threshold:
            self._consecutive_ask_skewed += 1
        else:
            self._consecutive_ask_skewed = 0

        self.last_update = time.time()
        return self.bid_skew, self.ask_skew

    def is_bid_skewed(self) -> bool:
        return self._consecutive_bid_skewed >= self.persistence_count

    def is_ask_skewed(self) -> bool:
        return self._consecutive_ask_skewed >= self.persistence_count

    def reset(self) -> None:
        self.bid_volume = 0.0
        self.ask_volume = 0.0
        self.bid_skew = 0.0
        self.ask_skew = 0.0
        self.last_update = 0.0
        self._consecutive_bid_skewed = 0
        self._consecutive_ask_skewed = 0


class DirectionalVolumeEstimator:
    """Rolling buy/sell-volume tracker fed by Binance @trade messages."""

    def __init__(self, max_window_sec: float, bullish_threshold: float, bearish_threshold: float):
        self.max_window_sec = max_window_sec
        self.bullish_threshold = bullish_threshold
        self.bearish_threshold = bearish_threshold
        self._trades: Deque[Tuple[float, float, float]] = deque()

    def record_trade(self, ts: float, usd_value: float, direction: float) -> None:
        self._trades.append((ts, usd_value, direction))
        cutoff = ts - self.max_window_sec
        while self._trades and self._trades[0][0] < cutoff:
            self._trades.popleft()

    def get_volume(self, window_sec: float) -> Tuple[float, float, float]:
        if not self._trades:
            return 0.0, 0.0, 0.0
        now = self._trades[-1][0]
        cutoff = now - window_sec
        up = down = 0.0
        for ts, v, d in self._trades:
            if ts < cutoff:
                continue
            if d > 0:
                up += v
            else:
                down += v
        return up, down, up + down

    def get_skew(self, window_sec: float) -> float:
        up, down, total = self.get_volume(window_sec)
        if total <= 0:
            return 0.0
        return (up - down) / total

    def is_bullish(self, window_sec: float = PAPER_TRADE_FLOW_WINDOW_SEC) -> bool:
        return self.get_skew(window_sec) >= self.bullish_threshold

    def is_bearish(self, window_sec: float = PAPER_TRADE_FLOW_WINDOW_SEC) -> bool:
        return self.get_skew(window_sec) <= self.bearish_threshold

    def reset(self) -> None:
        self._trades.clear()


class BookPressureTracker:
    """Net-flow + extreme-skew gate (copied from microprice_mm_5m)."""

    def __init__(self, pressure_window_sec: float, pressure_threshold_pct: float,
                 skew_flow_pct: float, skew_alone_pct: float):
        self.pressure_window_sec = pressure_window_sec
        self.pressure_threshold_pct = pressure_threshold_pct
        self.skew_flow_pct = skew_flow_pct
        self.skew_alone_pct = skew_alone_pct
        self._snapshots: Deque[Tuple[float, float, float]] = deque(maxlen=PRESSURE_MAX_SAMPLES)
        self.last_mid: float = 0.0
        self.last_bid_usd: float = 0.0
        self.last_ask_usd: float = 0.0
        self.last_bid_delta: float = 0.0
        self.last_ask_delta: float = 0.0
        self.last_pressure: float = 0.0
        self.last_threshold_usd: float = 0.0
        self.last_skew_pct: float = 50.0
        self.last_gate_reason: str = ""

    def update(self, bids: list, asks: list) -> None:
        if not bids or not asks:
            return
        ts = time.time()
        total_bid_usd = total_ask_usd = 0.0
        best_bid = best_ask = 0.0
        for i, (p_str, q_str) in enumerate(bids):
            p = float(p_str); q = float(q_str)
            total_bid_usd += p * q
            if i == 0:
                best_bid = p
        for i, (p_str, q_str) in enumerate(asks):
            p = float(p_str); q = float(q_str)
            total_ask_usd += p * q
            if i == 0:
                best_ask = p
        if best_bid > 0 and best_ask > 0:
            self.last_mid = (best_bid + best_ask) / 2.0
        self.last_bid_usd = total_bid_usd
        self.last_ask_usd = total_ask_usd
        total = total_bid_usd + total_ask_usd
        self.last_skew_pct = 100.0 * total_bid_usd / total if total > 0 else 50.0
        self._snapshots.append((ts, total_bid_usd, total_ask_usd))
        bd, ad = self._compute_deltas(ts)
        self.last_bid_delta = bd
        self.last_ask_delta = ad
        self.last_pressure = bd - ad
        self.last_threshold_usd = total * self.pressure_threshold_pct / 100.0 if total > 0 else 0.0

    def _compute_deltas(self, now_ts: float) -> Tuple[float, float]:
        if len(self._snapshots) < 2:
            return 0.0, 0.0
        _, now_bid, now_ask = self._snapshots[-1]
        cutoff = now_ts - self.pressure_window_sec
        old_bid = now_bid; old_ask = now_ask
        for ts, b, a in self._snapshots:
            if ts >= cutoff:
                old_bid = b; old_ask = a
                break
        return now_bid - old_bid, now_ask - old_ask

    def is_bullish(self) -> bool:
        skew = self.last_skew_pct
        if skew >= self.skew_alone_pct:
            self.last_gate_reason = "SKEW"
            return True
        if self.last_pressure > self.last_threshold_usd and skew > self.skew_flow_pct:
            self.last_gate_reason = "FLOW+SKEW"
            return True
        return False

    def is_bearish(self) -> bool:
        skew = self.last_skew_pct
        if skew <= (100.0 - self.skew_alone_pct):
            self.last_gate_reason = "SKEW"
            return True
        if self.last_pressure < -self.last_threshold_usd and skew < (100.0 - self.skew_flow_pct):
            self.last_gate_reason = "FLOW+SKEW"
            return True
        return False

    def reset(self) -> None:
        self._snapshots.clear()
        self.last_mid = 0.0
        self.last_bid_usd = 0.0
        self.last_ask_usd = 0.0
        self.last_bid_delta = 0.0
        self.last_ask_delta = 0.0
        self.last_pressure = 0.0
        self.last_threshold_usd = 0.0
        self.last_skew_pct = 50.0
        self.last_gate_reason = ""


class PriceMoveGuard:
    """Records Binance mid samples and answers whether the underlying
    moved against us in the last `window_ms`.

    A bullish signal is rejected if Binance mid is LOWER now than it was
    `window_ms` ago. A bearish signal is rejected if the mid is HIGHER.
    """

    def __init__(self, window_ms: int = PAPER_GUARD_WINDOW_MS, max_samples: int = 400):
        self.window_ms = window_ms
        self._samples: Deque[Tuple[float, float]] = deque(maxlen=max_samples)
        self.last_blocked_side: str = ""
        self.last_blocked_reason: str = ""
        self.blocks_yes: int = 0
        self.blocks_no: int = 0

    def record(self, ts: float, mid: float) -> None:
        self._samples.append((ts, mid))

    def _ref_mid(self, now_ts: float) -> Optional[float]:
        if not self._samples:
            return None
        cutoff = now_ts - (self.window_ms / 1000.0)
        ref = None
        for ts, mid in self._samples:
            if ts >= cutoff:
                ref = mid
                break
        if ref is None:
            ref = self._samples[0][1]
        return ref

    def allow(self, side: str) -> Tuple[bool, str]:
        now_ts = time.time()
        if not self._samples:
            return True, ""
        now_mid = self._samples[-1][1]
        ref = self._ref_mid(now_ts)
        if ref is None or ref <= 0:
            return True, ""
        delta_bps = (now_mid - ref) / ref * 1e4
        if side == "YES":  # bullish — need mid >= ref
            if now_mid < ref:
                self.last_blocked_side = "YES"
                self.last_blocked_reason = f"BTC {delta_bps:+.1f}bps in {self.window_ms}ms"
                self.blocks_yes += 1
                return False, self.last_blocked_reason
        else:               # bearish — need mid <= ref
            if now_mid > ref:
                self.last_blocked_side = "NO"
                self.last_blocked_reason = f"BTC {delta_bps:+.1f}bps in {self.window_ms}ms"
                self.blocks_no += 1
                return False, self.last_blocked_reason
        return True, ""


# ============================================================================
# PAPER ORDER & TRADE MODELS
# ============================================================================

@dataclass
class Inventory:
    """Per-session inventory tracker (resets on session roll).

    Mirrors the live MM's Inventory shape so the TUI parser can stay
    similar to `microprice_tui.py`: `yes_shares`, `no_shares`,
    `yes_avg_price`, `no_avg_price`, plus mark-to-market PnL.
    """
    yes_shares: float = 0.0
    no_shares: float = 0.0
    yes_avg_price: float = 0.0
    no_avg_price: float = 0.0
    yes_fees: float = 0.0
    no_fees: float = 0.0

    @property
    def net(self) -> float:
        return self.yes_shares - self.no_shares

    @property
    def matched_pairs(self) -> float:
        return min(self.yes_shares, self.no_shares)

    @property
    def total_cost(self) -> float:
        return (self.yes_shares * self.yes_avg_price
                + self.no_shares * self.no_avg_price
                + self.yes_fees + self.no_fees)

    def add_buy(self, side: str, size: float, price: float, fee: float) -> None:
        if side == "YES":
            old_cost = self.yes_shares * self.yes_avg_price
            self.yes_shares += size
            self.yes_avg_price = (old_cost + size * price) / self.yes_shares if self.yes_shares > 0 else 0.0
            self.yes_fees += fee
        else:
            old_cost = self.no_shares * self.no_avg_price
            self.no_shares += size
            self.no_avg_price = (old_cost + size * price) / self.no_shares if self.no_shares > 0 else 0.0
            self.no_fees += fee

    def position_value(self, yes_mid: Optional[float]) -> float:
        """Current market value of the open position at YES mid.

        value = yes_shares * yes_mid + no_shares * (1 - yes_mid)
        """
        if yes_mid is None or (self.yes_shares == 0 and self.no_shares == 0):
            return 0.0
        return self.yes_shares * yes_mid + self.no_shares * (1.0 - yes_mid)

    def mtm_pnl(self, yes_mid: Optional[float]) -> float:
        """Mark-to-market PnL using current YES mid.

        value = yes_shares * yes_mid + no_shares * (1 - yes_mid)
        pnl   = value - total_cost (incl. fees)
        """
        if yes_mid is None or (self.yes_shares == 0 and self.no_shares == 0):
            return 0.0
        return self.position_value(yes_mid) - self.total_cost

    def worst_case_pnl(self) -> float:
        """PnL if the side with fewer shares wins (worst case)."""
        if self.yes_shares == 0 and self.no_shares == 0:
            return 0.0
        cost = self.total_cost
        return min(self.yes_shares - cost, self.no_shares - cost)

    def reset(self) -> None:
        self.yes_shares = 0.0
        self.no_shares = 0.0
        self.yes_avg_price = 0.0
        self.no_avg_price = 0.0
        self.yes_fees = 0.0
        self.no_fees = 0.0


@dataclass
class PaperOrder:
    order_id: str
    side: str             # "YES" / "NO"
    limit_price: Decimal  # what we placed (best_ask + bump_ticks)
    size: Decimal
    submit_time: float    # when fire() was called
    arrive_time: float    # submit + sampled post latency (first eligible fill check)
    status: str = "PENDING"  # PENDING → FILLED | CANCELLED
    fill_price: Optional[Decimal] = None
    fill_time: Optional[float] = None
    fill_size: Optional[Decimal] = None
    fee: float = 0.0
    notional: float = 0.0
    cancel_reason: str = ""
    # signal context (for logging)
    signal_reason: str = ""
    signal_pressure: float = 0.0
    signal_skew_pct: float = 50.0


@dataclass
class PaperFill:
    """One realised paper fill (one leg of a trade)."""
    side: str
    size: float
    price: float
    fee: float
    cost: float       # size * price + fee  (USDC out)
    fill_time: float
    session_id: str   # 5-min interval start (ISO)


# ============================================================================
# ALL-TIME STATS TRACKER (optional JSON persistence)
# ============================================================================

@dataclass
class AllTimeStats:
    """All-time aggregate PnL — purely the sum of resolved per-session PnLs.

    No bankroll/equity concept: each 5-min session is a self-contained trade,
    and ``realised_pnl`` is just the running sum of those session PnLs (already
    net of fees because session_pnl = sum(payouts) - sum(costs incl. fees)).

    ``starting_bankroll`` is kept only as the **ROI denominator** (default
    $2,000) — the live MM never has a bankroll, this is just a normalising
    constant for the "what % return have I made on this much risk capital"
    headline.
    """
    starting_bankroll: float = PAPER_INITIAL_EQUITY  # ROI denominator only
    realised_pnl: float = 0.0  # cumulative sum of session_pnls (after fees)
    total_fees: float = 0.0
    total_notional: float = 0.0
    total_fills: int = 0
    yes_fills: int = 0
    no_fills: int = 0
    cancelled_orders: int = 0
    fired_orders: int = 0
    skipped_signals: int = 0
    sessions_resolved: int = 0
    win_count: int = 0
    loss_count: int = 0
    push_count: int = 0
    best_session_pnl: float = 0.0
    worst_session_pnl: float = 0.0
    # PnL-curve summary (cumulative session PnL — starts at $0)
    equity_high_water: float = 0.0
    max_drawdown_abs: float = 0.0
    max_drawdown_pct: float = 0.0
    # per-session realised PnL series (most recent N kept for Sharpe)
    session_pnls: List[float] = field(default_factory=list)
    # cumulative trade-level PnL series (per-fill mark-to-resolution)
    trade_pnls: List[float] = field(default_factory=list)
    # cumulative session-PnL curve (running sum, one sample per resolved session)
    equity_curve: List[float] = field(default_factory=list)
    # bookkeeping
    started_at: str = ""
    last_update: str = ""

    def roi_pct(self) -> float:
        if self.starting_bankroll <= 0:
            return 0.0
        return self.realised_pnl / self.starting_bankroll * 100.0

    def gross_pnl(self) -> float:
        """All-time PnL before fees (i.e. what we'd have made fee-free)."""
        return self.realised_pnl + self.total_fees

    def win_rate(self) -> float:
        denom = self.win_count + self.loss_count
        return self.win_count / denom if denom > 0 else 0.0

    def avg_session_pnl(self) -> float:
        return statistics.fmean(self.session_pnls) if self.session_pnls else 0.0

    def avg_trade_pnl(self) -> float:
        return statistics.fmean(self.trade_pnls) if self.trade_pnls else 0.0

    def sharpe(self) -> float:
        """Per-session Sharpe (no risk-free rate, raw returns).

        We use session-level realised PnL because that's the natural
        "trade closes" boundary in a 5-min market. Reports inf if
        stdev is 0 with positive mean.
        """
        if len(self.session_pnls) < 2:
            return 0.0
        try:
            sd = statistics.stdev(self.session_pnls)
            mean = statistics.fmean(self.session_pnls)
            if sd <= 0:
                return float("inf") if mean > 0 else 0.0
            # annualisation: 5-min sessions → 288/day → 288 * 365 = 105,120/yr
            # but keep the raw Sharpe-per-session and let the consumer scale.
            sessions_per_day = 1  # one daily market per calendar day
            return (mean / sd) * math.sqrt(sessions_per_day)
        except statistics.StatisticsError:
            return 0.0


class EquityTracker:
    """All-time stats; disk I/O only when ``persist=True`` (`--persist-stats`)."""

    def __init__(self, coin_id: str, starting_bankroll: float, persist: bool = False):
        self.coin_id = coin_id.lower()
        self.path = PAPER_STATE_DIR / f"{self.coin_id}_daily_paper_state.json"
        self.persist = persist
        self.stats = AllTimeStats(starting_bankroll=starting_bankroll)
        self.stats.started_at = datetime.utcnow().isoformat()
        if self.persist:
            self._load()
        else:
            logger.info("[PT-STATE] in-memory stats only (no disk load/save; use --persist-stats to enable)")

    def _load(self) -> None:
        if not self.path.exists():
            self.stats.started_at = datetime.utcnow().isoformat()
            self._save()
            return
        try:
            with open(self.path, "r") as f:
                raw = json.load(f)
            for k, v in raw.items():
                if hasattr(self.stats, k):
                    setattr(self.stats, k, v)
            # ROI denominator must always reflect the *current* default; older
            # state files used a $10k bankroll which is no longer the policy.
            self.stats.starting_bankroll = PAPER_INITIAL_EQUITY
            # Migrate older "leaky" state where realised_pnl was tracked per-fill
            # (cost subtracted at fill, payout added at resolution). The clean
            # model is realised_pnl == sum(session_pnls). Recompute it and the
            # equity curve from the per-session series.
            if self.stats.session_pnls:
                clean_pnl = sum(self.stats.session_pnls)
                if abs(clean_pnl - self.stats.realised_pnl) > 0.01:
                    logger.info(
                        f"[PT-LOAD] migrating realised_pnl: "
                        f"old=${self.stats.realised_pnl:+.2f} → new=${clean_pnl:+.2f} "
                        f"(sum of {len(self.stats.session_pnls)} session PnLs)"
                    )
                    self.stats.realised_pnl = clean_pnl
                # Rebuild cumulative PnL curve + max drawdown from session PnLs.
                cum = 0.0
                curve: List[float] = []
                hwm = 0.0
                max_dd = 0.0
                for sp in self.stats.session_pnls:
                    cum += sp
                    curve.append(cum)
                    if cum > hwm:
                        hwm = cum
                    dd = hwm - cum
                    if dd > max_dd:
                        max_dd = dd
                self.stats.equity_curve = curve
                self.stats.equity_high_water = hwm
                self.stats.max_drawdown_abs = max_dd
                self.stats.max_drawdown_pct = (
                    max_dd / self.stats.starting_bankroll * 100.0
                    if self.stats.starting_bankroll > 0 else 0.0
                )
            else:
                # No history → reset HWM/curve to clean zero baseline.
                self.stats.equity_high_water = 0.0
                self.stats.equity_curve = []
                self.stats.realised_pnl = 0.0
            logger.info(
                f"[PT-LOAD] State loaded from {self.path.name}: "
                f"PnL=${self.stats.realised_pnl:+.2f} fees=${self.stats.total_fees:.2f} "
                f"ROI={self.stats.roi_pct():+.2f}% (vs ${self.stats.starting_bankroll:,.0f}) "
                f"maxDD=${self.stats.max_drawdown_abs:.2f}/{self.stats.max_drawdown_pct:.2f}% "
                f"sessions={self.stats.sessions_resolved} fills={self.stats.total_fills}"
            )
        except Exception as e:
            logger.warning(f"[PT-LOAD] Failed to load {self.path}: {e} — starting fresh")

    def _save(self) -> None:
        if not self.persist:
            return
        self.stats.last_update = datetime.utcnow().isoformat()
        try:
            PAPER_STATE_DIR.mkdir(parents=True, exist_ok=True)
            with open(self.path, "w") as f:
                json.dump(asdict(self.stats), f, indent=2)
        except Exception as e:
            logger.warning(f"[PT-SAVE] Failed: {e}")

    def record_fire(self) -> None:
        self.stats.fired_orders += 1

    def record_skip(self) -> None:
        self.stats.skipped_signals += 1

    def record_cancel(self) -> None:
        self.stats.cancelled_orders += 1
        self._save()

    def record_fill(self, fill: PaperFill) -> None:
        """Track a fill — does NOT touch realised_pnl.

        The clean model is: realised_pnl is the sum of resolved session PnLs.
        Per-fill cost gets accounted for inside the session via the Inventory
        (avg price + total_cost) and only contributes to realised_pnl once the
        session resolves via record_resolution().
        """
        self.stats.total_fills += 1
        if fill.side == "YES":
            self.stats.yes_fills += 1
        else:
            self.stats.no_fills += 1
        self.stats.total_fees += fill.fee
        self.stats.total_notional += fill.size * fill.price
        self._save()

    def record_resolution(self, session_id: str, fills: List[PaperFill],
                          winning_side: Optional[str]) -> Tuple[float, int, int]:
        """Resolve one 5-min session and roll its PnL into the all-time total.

        Each session is treated as one self-contained trade. The session PnL
        (after fees) is added to `realised_pnl`; the cumulative-PnL curve and
        max drawdown are updated accordingly.

        Returns (session_pnl_after_fees, wins_added, losses_added).
        """
        if not fills:
            return 0.0, 0, 0

        session_payout = 0.0
        session_cost = 0.0
        wins = losses = pushes = 0
        for f in fills:
            session_cost += f.cost  # already includes fees
            if winning_side is None:  # push / unresolved → refund at fill_price
                payout = f.size * f.price  # treat as flat (mid-resolution)
                pushes += 1
            elif f.side == winning_side:
                payout = f.size * 1.0
                wins += 1
            else:
                payout = 0.0
                losses += 1
            session_payout += payout
            self.stats.trade_pnls.append(payout - f.cost)

        session_pnl = session_payout - session_cost  # net of fees
        self.stats.realised_pnl += session_pnl
        self.stats.sessions_resolved += 1
        self.stats.session_pnls.append(session_pnl)
        self.stats.win_count += wins
        self.stats.loss_count += losses
        self.stats.push_count += pushes
        if session_pnl > self.stats.best_session_pnl:
            self.stats.best_session_pnl = session_pnl
        if session_pnl < self.stats.worst_session_pnl:
            self.stats.worst_session_pnl = session_pnl

        # Cumulative session-PnL curve + drawdown (HWM starts at $0).
        cum_pnl = self.stats.realised_pnl
        self.stats.equity_curve.append(cum_pnl)
        if cum_pnl > self.stats.equity_high_water:
            self.stats.equity_high_water = cum_pnl
        dd_abs = self.stats.equity_high_water - cum_pnl
        if dd_abs > self.stats.max_drawdown_abs:
            self.stats.max_drawdown_abs = dd_abs
            if self.stats.starting_bankroll > 0:
                self.stats.max_drawdown_pct = (
                    dd_abs / self.stats.starting_bankroll * 100.0
                )

        # Cap series lengths to keep file small (last 5000 entries)
        if len(self.stats.session_pnls) > 5000:
            self.stats.session_pnls = self.stats.session_pnls[-5000:]
        if len(self.stats.trade_pnls) > 20000:
            self.stats.trade_pnls = self.stats.trade_pnls[-20000:]
        if len(self.stats.equity_curve) > 5000:
            self.stats.equity_curve = self.stats.equity_curve[-5000:]

        self._save()
        return session_pnl, wins, losses


# ============================================================================
# STRATEGY INTERFACE — what your `decide()` receives and returns
# ============================================================================

@dataclass
class MarketContext:
    """Snapshot passed to `decide()` on every tick.

    All prices are floats in [0, 1] for Polymarket probabilities and USD for
    the underlying. Fields may be ``None`` before the feeds warm up — always
    guard against that in your strategy.
    """
    coin: str                              # "btc" / "eth" / ...
    now: float                             # time.time()

    # Underlying (Binance) spot mid
    spot: Optional[float]

    # Polymarket YES/NO book (probabilities 0–1)
    yes_bid: Optional[float]
    yes_ask: Optional[float]
    yes_mid: Optional[float]
    no_bid: Optional[float]
    no_ask: Optional[float]

    # Daily session
    session_id: Optional[str]              # resolution date ISO (e.g. 2026-06-22)
    strike: Optional[float]                # price-to-beat = noon ET open
    time_left_hours: float                 # hours until noon ET resolution

    # Live inventory (this session)
    inv_yes: float
    inv_no: float
    inv_net: float

    @property
    def market_prob_up(self) -> Optional[float]:
        """Market-implied P(Up) = YES mid price."""
        return self.yes_mid


@dataclass
class TradeDecision:
    """Return this from `decide()` to fire a paper taker BUY.

    side:   "YES" (bet Up) or "NO" (bet Down)
    reason: short tag shown in [PT-FIRE] logs / TUI
    size:   optional override; default = engine inventory-aware sizing
    """
    side: str
    reason: str = "decide"
    size: Optional[float] = None


# ============================================================================
# BASE PAPER TRADER (engine) — subclass and override `decide()`
# ============================================================================

class BaseDailyPaperTrader:
    def __init__(self, coin_id: str, args: argparse.Namespace):
        self.coin_id = coin_id.lower()
        self.coin_config = get_coin_config(self.coin_id)
        self.args = args

        # Signal trackers
        self.binance_book = BinanceBookState(
            place_threshold=args.skew_place,
            persistence_count=args.persistence,
        )
        self.pressure_tracker = BookPressureTracker(
            pressure_window_sec=args.pressure_window,
            pressure_threshold_pct=args.pressure_threshold,
            skew_flow_pct=args.skew_flow,
            skew_alone_pct=args.skew_alone,
        )
        self.trade_flow = DirectionalVolumeEstimator(
            max_window_sec=PAPER_TRADE_FLOW_MAX_WINDOW,
            bullish_threshold=args.trade_bull,
            bearish_threshold=args.trade_bear,
        )
        self.guard = PriceMoveGuard(window_ms=args.guard_window_ms)

        # Polymarket feed (read-only) — supervisor swaps the feed each 5m bucket
        self.feed: Optional[PolyMarketFeed] = None
        self.condition_id: Optional[str] = None
        self.market_id: Optional[str] = None
        self.yes_token_id: Optional[str] = None
        self.no_token_id: Optional[str] = None
        self.market_question: Optional[str] = None
        self._poly_switch_event: Optional[asyncio.Event] = None  # created in run()
        self._market_switches: int = 0

        # ── Order sizing (mirrors microprice_mm_5m.py per-coin / mode logic) ──
        if args.test:
            base_sz, inv_max = PAPER_MODE_TEST
            sz_label = "TEST"
        elif args.live:
            base_sz, inv_max = PAPER_MODE_LIVE
            sz_label = "LIVE"
        elif args.default_size:
            base_sz, inv_max = PAPER_MODE_DEFAULT
            sz_label = "DEFAULT"
        else:
            base_sz, inv_max = PAPER_COIN_SIZES.get(self.coin_id, PAPER_MODE_DEFAULT)
            sz_label = f"COIN({self.coin_id.upper()})"
        # CLI overrides take precedence
        if args.size is not None:
            base_sz = Decimal(str(args.size))
            sz_label += "+--size"
        if args.max_inv is not None:
            inv_max = Decimal(str(args.max_inv))
            sz_label += "+--max-inv"
        self._base_order_size = base_sz
        self._inv_max = inv_max
        # Snapshot for per-session reset (live MM does the same)
        self._orig_base_order_size = self._base_order_size
        self._orig_inv_max = self._inv_max
        self._size_label = sz_label

        # Execution state
        self.bump_ticks = args.bump
        self.tick_size = PAPER_TICK_SIZE
        self._latency_fixed_ms: Optional[int] = args.latency_ms
        self._lat_mu: Optional[float] = None
        self._lat_sigma: Optional[float] = None
        if self._latency_fixed_ms is None:
            self._lat_mu, self._lat_sigma = _paper_lognormal_latency_params(
                PAPER_LATENCY_MEDIAN_MS, PAPER_LATENCY_P95_MS
            )
        self.cancel_timeout_sec = args.cancel_timeout
        self.cancel_ask_drift_ticks = max(0, int(args.cancel_ask_drift_ticks))
        self.fill_cooldown_sec = args.fill_cooldown
        self.require_trade_flow = not args.loose
        # Subclasses that rely on the Binance adverse-move guard set this True.
        # Generic strategies leave it off so `decide()` is fully in control.
        self.use_guard: bool = bool(getattr(args, "use_guard", False))
        # How often the strategy `decide()` hook is polled (seconds).
        self.decide_interval_sec: float = float(getattr(args, "decide_interval", 1.0))

        # Per-side cooldown
        self.last_fill_time: Dict[str, float] = {"YES": 0.0, "NO": 0.0}
        # In-flight orders (one per side)
        self.active_order: Dict[str, Optional[PaperOrder]] = {"YES": None, "NO": None}

        # Session tracking (per 5-min interval)
        self.session_start_ts: Optional[float] = None
        self.session_id: Optional[str] = None
        self.session_open_price: Optional[float] = None
        self.session_close_price: Optional[float] = None
        self.session_fills: List[PaperFill] = []
        # Live inventory (resets every 5-min session)
        self.inventory = Inventory()

        # Stats
        self.stats = EquityTracker(self.coin_id, args.initial_equity, args.persist_stats)

        # Telemetry
        self._sbe_depth_count = 0
        self._sbe_trade_count = 0
        self._poly_msg_count = 0
        self.binance_mid: Optional[float] = None  # latest BTC mid (for TUI BTC panel)
        self.binance_depth_ws_connected = False
        self.binance_aggtrade_ws_connected = False
        self.poly_ws_connected = False
        self._last_status_ts = 0.0
        self._last_stats_ts = 0.0
        self._last_fire_ts = 0.0

        # Order-fill simulator state
        self._order_fill_lock = asyncio.Lock()

        # Recent activity log
        self._recent_events: Deque[str] = deque(maxlen=20)

        # Min level USD for skew filter
        self._min_level_usd = {
            "btc": 10000.0, "eth": 2000.0, "sol": 500.0, "xrp": 200.0,
        }.get(self.coin_id, 1000.0)

        # Aiohttp session (for candle fetch only)
        self._aiohttp_session: Optional[aiohttp.ClientSession] = None

        self.running = False

    # --------------------------------------------------------------------
    # Setup / lifecycle
    # --------------------------------------------------------------------
    async def _get_session(self) -> aiohttp.ClientSession:
        if self._aiohttp_session is None or self._aiohttp_session.closed:
            self._aiohttp_session = aiohttp.ClientSession()
        return self._aiohttp_session

    async def _fetch_session_reference_open(self) -> Optional[float]:
        """Reference price at noon ET when the daily market started."""
        if self.session_start_ts is None:
            return None
        return await self._fetch_binance_price_at(self.session_start_ts)

    async def _fetch_binance_price_at(self, ts: float) -> Optional[float]:
        """Fetch Binance close price at the given timestamp via 1m kline."""
        symbol = self.coin_config.symbol.upper()
        ms = int(ts * 1000)
        url = (
            f"https://api.binance.com/api/v3/klines?symbol={symbol}"
            f"&interval=1m&limit=1&endTime={ms}"
        )
        try:
            sess = await self._get_session()
            async with sess.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data:
                        return float(data[0][4])  # close
        except Exception as e:
            logger.warning(f"[CANDLE] Failed to fetch close: {e}")
        return None

    def _find_market(self):
        finders = {
            "btc": find_btc_daily_market,
            "eth": find_eth_daily_market,
            "sol": find_sol_daily_market,
            "xrp": find_xrp_daily_market,
        }
        f = finders.get(self.coin_id)
        if not f:
            return None
        try:
            return f(include_upcoming=True)
        except Exception as e:
            logger.warning(f"[MARKET] find error: {e}")
            return None

    async def _find_market_async(self):
        """Run the (sync) Gamma API market finder off the event loop."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._find_market)

    def _apply_market(self, market) -> bool:
        """Stash market info on the trader. Returns True if a real market was applied."""
        if not market or not market.yes_token_id or not market.no_token_id:
            return False
        self.condition_id = market.condition_id
        self.market_id = getattr(market, "market_id", None)
        self.yes_token_id = market.yes_token_id
        self.no_token_id = market.no_token_id
        self.market_question = getattr(market, "question", None)
        return True

    async def connect(self) -> bool:
        market = None
        for attempt in range(5):
            market = await self._find_market_async()
            if market and market.yes_token_id and market.no_token_id:
                break
            logger.warning(f"[MARKET] no market (attempt {attempt+1}/5), retrying in 5s")
            await asyncio.sleep(5)
        if not self._apply_market(market):
            logger.error("[MARKET] could not find a daily market")
            return False
        logger.info(
            f"[PT-MARKET] {self.market_question[:90] if self.market_question else ''}\n"
            f"[PT-MARKET]   condition={self.condition_id} "
            f"yes={self.yes_token_id[:14]}… no={self.no_token_id[:14]}…"
        )
        return True

    # --------------------------------------------------------------------
    # Binance feeds (signal source)
    # --------------------------------------------------------------------
    async def _binance_bookticker_listener(self):
        """Binance @bookTicker — drives both BinanceBookState and BookPressureTracker."""
        symbol = self.coin_config.symbol.lower()
        url = f"{BINANCE_WS_BASE}/{symbol}@bookTicker"
        delay = 1.0
        while self.running:
            try:
                async with websockets.connect(url, ping_interval=10, ping_timeout=5) as ws:
                    logger.info(f"[BOOKTICKER] connected ({self.coin_config.symbol})")
                    self.binance_depth_ws_connected = True
                    delay = 1.0
                    async for msg in ws:
                        if not self.running:
                            break
                        try:
                            data = _json_loads(msg)
                            bid = data["b"]; ask = data["a"]
                            bid_qty = data["B"]; ask_qty = data["A"]
                            bids = [[bid, bid_qty]]
                            asks = [[ask, ask_qty]]
                            self.binance_book.update(bids, asks, self._min_level_usd)
                            self.pressure_tracker.update(bids, asks)
                            mid = (float(bid) + float(ask)) / 2.0
                            self.binance_mid = mid
                            self.guard.record(time.time(), mid)
                            self._sbe_depth_count += 1
                        except (KeyError, ValueError):
                            pass
            except Exception as e:
                self.binance_depth_ws_connected = False
                logger.warning(f"[BOOKTICKER] disconnected: {e}")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def _binance_aggtrade_listener(self):
        """Binance @trade (SBE preferred, JSON fallback) — feeds DirectionalVolumeEstimator."""
        symbol = self.coin_config.symbol.lower()
        delay = 1.0
        while self.running:
            try:
                if _SBE_AVAILABLE:
                    api_key = os.environ.get("BINANCE_API_KEY", "").strip()
                    url = f"{SBE_BASE_URL}/{symbol}@trade"
                    headers = {"X-MBX-APIKEY": api_key} if api_key else {}
                    async with websockets.connect(
                        url,
                        additional_headers=headers,
                        ping_interval=10,
                        ping_timeout=5,
                    ) as ws:
                        logger.info(f"[SBE TRADES] connected ({self.coin_config.symbol})")
                        self.binance_aggtrade_ws_connected = True
                        delay = 1.0
                        async for raw in ws:
                            if not self.running:
                                break
                            if not isinstance(raw, bytes):
                                continue
                            try:
                                m = binance_sbe.decode_stream_message(raw)
                                if not m or m.get("templateId") != 10000:
                                    continue
                                ts = time.time()
                                for _id, p, q, is_buyer_maker in m["trades"]:
                                    direction = -1.0 if is_buyer_maker else 1.0
                                    self.trade_flow.record_trade(ts, p * q, direction)
                                    self._sbe_trade_count += 1
                            except Exception:
                                pass
                else:
                    url = f"{BINANCE_WS_BASE}/{symbol}@trade"
                    async with websockets.connect(url, ping_interval=10, ping_timeout=5) as ws:
                        logger.info(f"[JSON TRADES] connected ({self.coin_config.symbol}) — SBE not available")
                        self.binance_aggtrade_ws_connected = True
                        delay = 1.0
                        async for msg in ws:
                            if not self.running:
                                break
                            try:
                                data = _json_loads(msg)
                                p = float(data["p"]); q = float(data["q"])
                                is_buyer_maker = bool(data.get("m", False))
                                direction = -1.0 if is_buyer_maker else 1.0
                                self.trade_flow.record_trade(time.time(), p * q, direction)
                                self._sbe_trade_count += 1
                            except (KeyError, ValueError):
                                pass
            except Exception as e:
                self.binance_aggtrade_ws_connected = False
                logger.warning(f"[TRADES] disconnected: {e}")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    # --------------------------------------------------------------------
    # Polymarket feed (read-only)
    # --------------------------------------------------------------------
    async def _poly_feed_supervisor(self):
        """Long-running supervisor that owns the per-market PolyMarketFeed.

        On every 5-min bucket roll, `_maybe_roll_session()` calls
        `_request_market_switch()` which:
          1) re-runs the Gamma market finder for the *new* 5m market
          2) updates condition_id / yes_token_id / no_token_id
          3) sets `_poly_switch_event`

        This supervisor watches the event, tears down the current feed, and
        spins up a fresh `PolyMarketFeed` against the new tokens — mirroring
        `microprice_mm_5m.py`'s "restart on 5-min boundary" loop.
        """
        if self._poly_switch_event is None:
            self._poly_switch_event = asyncio.Event()

        while self.running:
            if not self.yes_token_id or not self.no_token_id:
                await asyncio.sleep(0.25)
                continue

            yt, nt, cid = self.yes_token_id, self.no_token_id, self.condition_id
            self.feed = PolyMarketFeed(
                yes_token_id=yt,
                no_token_id=nt,
                rest_interval_ms=200,
                enable_rest=True,
                enable_dual_ws=True,
            )
            self._poly_msg_count = 0

            def _on_update():
                self._poly_msg_count += 1

            self.feed.on_update = _on_update
            # `PolyMarketFeed.create_tasks()` already returns asyncio.Task objects
            # (it calls `asyncio.create_task` internally), so consume them as-is.
            feed_tasks = list(self.feed.create_tasks())
            logger.info(
                f"[POLY] feed started | condition={cid} "
                f"yes={yt[:14]}… no={nt[:14]}…"
            )

            self._poly_switch_event.clear()
            switch_waiter = asyncio.create_task(self._poly_switch_event.wait())

            try:
                done, pending = await asyncio.wait(
                    [*feed_tasks, switch_waiter],
                    return_when=asyncio.FIRST_COMPLETED,
                )
            except asyncio.CancelledError:
                for t in feed_tasks:
                    t.cancel()
                if not switch_waiter.done():
                    switch_waiter.cancel()
                await asyncio.gather(*feed_tasks, switch_waiter, return_exceptions=True)
                if self.feed:
                    self.feed.stop()
                self.feed = None
                raise

            for t in feed_tasks:
                if not t.done():
                    t.cancel()
            if not switch_waiter.done():
                switch_waiter.cancel()
            await asyncio.gather(*feed_tasks, switch_waiter, return_exceptions=True)
            try:
                self.feed.stop()
            except Exception:
                pass
            self.feed = None

            if switch_waiter in done:
                logger.info("[POLY] feed teardown — switching to new daily market")
            else:
                logger.warning("[POLY] feed tasks ended unexpectedly — respinning in 1s")
                await asyncio.sleep(1.0)

    async def _request_market_switch(self):
        """Look up the next 5m market and signal the supervisor to swap the feed.

        Mirrors the live MM's behavior of re-calling `find_*_5m_market()` on
        every 5-min boundary to lock onto the new market's YES/NO tokens.
        """
        try:
            market = await self._find_market_async()
        except Exception as e:
            logger.warning(f"[PT-MARKET] switch failed: {e}")
            return

        if not market or not market.yes_token_id or not market.no_token_id:
            logger.warning("[PT-MARKET] switch failed: no market returned")
            return

        new_cid = market.condition_id
        if new_cid and new_cid == self.condition_id:
            logger.info(f"[PT-MARKET] same market still active ({new_cid[:14]}…) — feed kept")
            return

        old_cid = self.condition_id
        self._apply_market(market)
        self._market_switches += 1
        logger.info(
            f"[PT-MARKET] #{self._market_switches} switched: "
            f"{(old_cid or '∅')[:14]}… → {new_cid[:14]}… "
            f"yes={self.yes_token_id[:14]}… no={self.no_token_id[:14]}… "
            f"q={(self.market_question or '')[:80]}"
        )
        if self._poly_switch_event is not None:
            self._poly_switch_event.set()

    @property
    def poly_yes_bid(self) -> Optional[Decimal]:
        return self.feed.yes_bid if self.feed else None

    @property
    def poly_yes_ask(self) -> Optional[Decimal]:
        return self.feed.yes_ask if self.feed else None

    @property
    def poly_no_bid(self) -> Optional[Decimal]:
        return self.feed.no_bid if self.feed else None

    @property
    def poly_no_ask(self) -> Optional[Decimal]:
        return self.feed.no_ask if self.feed else None

    @property
    def poly_yes_mid(self) -> Optional[Decimal]:
        if self.feed and self.feed.yes_bid and self.feed.yes_ask:
            return (self.feed.yes_bid + self.feed.yes_ask) / 2
        return None

    # --------------------------------------------------------------------
    # Signal evaluation & order firing
    # --------------------------------------------------------------------
    # --------------------------------------------------------------------
    # Order sizing & bump (mirrors microprice_mm_5m.py inv-management)
    # --------------------------------------------------------------------
    def _get_dynamic_base_size(self) -> Decimal:
        """Always return the configured base order size (matches live MM)."""
        return self._base_order_size

    def _calculate_yes_order_size(self) -> Decimal:
        """Inventory-aware size for a YES BUY (copied from microprice_mm_5m)."""
        net = Decimal(str(self.inventory.net))
        if net >= self._inv_max:
            return Decimal("0")
        net_ratio = float(net / self._inv_max) if self._inv_max > 0 else 0.0
        net_ratio = max(-1.0, min(1.0, net_ratio))
        base_size = self._get_dynamic_base_size()
        # net=+max → 0 ; net=0 → base ; net=-max → 2*base
        size_multiplier = Decimal(str(1.0 - net_ratio))
        size = base_size * size_multiplier
        size = max(Decimal("0"), min(size, base_size * 2))
        size = Decimal(str(int(size)))
        if 0 < size < PAPER_MIN_ORDER_SIZE:
            size = Decimal("0")
        return size

    def _calculate_no_order_size(self) -> Decimal:
        """Inventory-aware size for a NO BUY (copied from microprice_mm_5m)."""
        net = Decimal(str(self.inventory.net))
        if net <= -self._inv_max:
            return Decimal("0")
        net_ratio = float(net / self._inv_max) if self._inv_max > 0 else 0.0
        net_ratio = max(-1.0, min(1.0, net_ratio))
        base_size = self._get_dynamic_base_size()
        # net=-max → 0 ; net=0 → base ; net=+max → 2*base
        size_multiplier = Decimal(str(1.0 + net_ratio))
        size = base_size * size_multiplier
        size = max(Decimal("0"), min(size, base_size * 2))
        size = Decimal(str(int(size)))
        if 0 < size < PAPER_MIN_ORDER_SIZE:
            size = Decimal("0")
        return size

    def _calculate_order_size(self, side: str) -> Decimal:
        return (self._calculate_yes_order_size() if side == "YES"
                else self._calculate_no_order_size())

    def _clamp_size_to_inventory(self, side: str, requested: Decimal) -> Decimal:
        """Clamp a strategy-requested size so NET inventory stays within ±max."""
        if requested <= 0:
            return Decimal("0")
        net = Decimal(str(self.inventory.net))
        if side == "YES":
            room = self._inv_max - net
        else:
            room = self._inv_max + net
        room = max(Decimal("0"), room)
        size = min(requested, room)
        size = Decimal(str(int(size)))
        if 0 < size < PAPER_MIN_ORDER_SIZE:
            return Decimal("0")
        return size

    def _get_bump_ticks(self, side: str) -> Tuple[int, str]:
        """Pick the GTC bump in ticks. Default is `--bump` (5), but if we're
        deeply imbalanced on the underfilled side we escalate to +8 ticks
        (matches live MM INV_TICK_BUMP_2_THRESHOLD logic)."""
        if self._inv_max <= 0:
            return self.bump_ticks, ""
        net = Decimal(str(self.inventory.net))
        rebal_ratio = Decimal("0")
        # YES is the underfilled side when net < 0; NO when net > 0
        if side == "YES" and net < 0:
            rebal_ratio = abs(net) / self._inv_max
        elif side == "NO" and net > 0:
            rebal_ratio = net / self._inv_max
        if rebal_ratio >= INV_TICK_BUMP_2_THRESHOLD:
            return INV_TICK_BUMP_2_TICKS, f"REBAL+{INV_TICK_BUMP_2_TICKS}t"
        if rebal_ratio >= INV_TICK_BUMP_1_THRESHOLD:
            return max(self.bump_ticks, INV_TICK_BUMP_1_TICKS), f"REBAL+{INV_TICK_BUMP_1_TICKS}t"
        return self.bump_ticks, ""

    # --------------------------------------------------------------------
    # STRATEGY HOOK — override this in your subclass
    # --------------------------------------------------------------------
    def decide(self, ctx: "MarketContext") -> Optional["TradeDecision"]:
        """Decide whether to fire a paper taker order this tick.

        Return ``TradeDecision(side="YES"|"NO", reason=...)`` to BUY that side,
        or ``None`` to do nothing. The engine handles cooldown, sizing, the
        simulated fill, fees and accounting — you only decide *if* and *which
        side*.

        This base implementation is intentionally BLANK so a teammate can drop
        in their own logic. See `strategies/simple_probability.py`.
        """
        raise NotImplementedError(
            "Override BaseDailyPaperTrader.decide() in your strategy subclass."
        )

    def _build_context(self) -> "MarketContext":
        """Assemble the per-tick MarketContext handed to `decide()`."""
        ymid = self.poly_yes_mid
        ybid = self.poly_yes_bid
        yask = self.poly_yes_ask
        nbid = self.poly_no_bid
        nask = self.poly_no_ask
        resolution_noon_ts, _ = self._current_daily_session()
        time_left_hours = max(0.0, (resolution_noon_ts - time.time()) / 3600.0)
        return MarketContext(
            coin=self.coin_id,
            now=time.time(),
            spot=self.binance_mid,
            yes_bid=float(ybid) if ybid is not None else None,
            yes_ask=float(yask) if yask is not None else None,
            yes_mid=float(ymid) if ymid is not None else None,
            no_bid=float(nbid) if nbid is not None else None,
            no_ask=float(nask) if nask is not None else None,
            session_id=self.session_id,
            strike=self.session_open_price,
            time_left_hours=time_left_hours,
            inv_yes=self.inventory.yes_shares,
            inv_no=self.inventory.no_shares,
            inv_net=self.inventory.net,
        )

    def _evaluate_gate(self) -> Tuple[Optional[str], str]:
        """Reference microprice gate — available for strategies that want it.

        Returns ('YES', reason) for bullish, ('NO', reason) for bearish, or
        (None, ''). Kept on the base so the [PT-STATUS] dashboard can display
        live signal state even when `decide()` ignores it.
        """
        bullish_pressure = self.pressure_tracker.is_bullish()
        bearish_pressure = self.pressure_tracker.is_bearish()
        bullish_skew = self.binance_book.is_bid_skewed()
        bearish_skew = self.binance_book.is_ask_skewed()
        bullish_flow = self.trade_flow.is_bullish()
        bearish_flow = self.trade_flow.is_bearish()

        if bullish_pressure and bullish_skew:
            if self.require_trade_flow and not bullish_flow:
                return None, "bull-no-flow"
            reason = self.pressure_tracker.last_gate_reason or "PRESS+SKEW"
            return "YES", reason
        if bearish_pressure and bearish_skew:
            if self.require_trade_flow and not bearish_flow:
                return None, "bear-no-flow"
            reason = self.pressure_tracker.last_gate_reason or "PRESS+SKEW"
            return "NO", reason
        return None, ""

    def _quantize_price(self, p: Decimal) -> Decimal:
        return (p / self.tick_size).quantize(Decimal("1")) * self.tick_size

    def _clamp_price(self, p: Decimal) -> Decimal:
        if p < PAPER_MIN_PRICE:
            return PAPER_MIN_PRICE
        if p > PAPER_MAX_PRICE:
            return PAPER_MAX_PRICE
        return p

    def _best_ask_for(self, side: str) -> Optional[Decimal]:
        """Polymarket best ask we'd be lifting for a BUY of `side`."""
        if not self.feed:
            return None
        if side == "YES":
            return self.feed.yes_ask
        return self.feed.no_ask

    def _best_bid_for(self, side: str) -> Optional[Decimal]:
        """Polymarket best bid for `side`. Used to skip pinned 99¢ markets."""
        if not self.feed:
            return None
        if side == "YES":
            return self.feed.yes_bid
        return self.feed.no_bid

    def _draw_place_latency_ms(self) -> float:
        """Simulated CLOB post RTT (ms): fixed `--latency-ms` or lognormal draw."""
        if self._latency_fixed_ms is not None:
            return float(self._latency_fixed_ms)
        assert self._lat_mu is not None and self._lat_sigma is not None
        return _sample_paper_place_latency_ms(self._lat_mu, self._lat_sigma)

    def _effective_fill_cooldown_sec(self) -> float:
        """Post-fill cooldown; reduced in the last hour before noon ET resolution."""
        base = float(self.fill_cooldown_sec)
        if base <= 0:
            return 0.0
        resolution_noon_ts, _ = self._current_daily_session()
        left = resolution_noon_ts - time.time()
        if left <= PAPER_FILL_COOLDOWN_TAIL_SEC:
            return min(base, PAPER_FILL_COOLDOWN_IN_TAIL_SEC)
        return base

    async def _fire_order(self, side: str, reason: str, size_override: Optional[float] = None):
        """Submit a paper GTC bump-N taker order for `side`."""
        # Per-side single-order constraint
        if self.active_order[side] is not None:
            return
        # Cooldown
        now = time.time()
        cd = self._effective_fill_cooldown_sec()
        if cd > 0 and now - self.last_fill_time[side] < cd:
            self.stats.record_skip()
            self._log_skip(side, f"cooldown {cd - (now - self.last_fill_time[side]):.1f}s")
            return

        # Order size: strategy override (clamped to inventory cap) or engine sizing
        if size_override is not None:
            size_dec = self._clamp_size_to_inventory(side, Decimal(str(int(size_override))))
        else:
            size_dec = self._calculate_order_size(side)
        if size_dec <= 0:
            self.stats.record_skip()
            net = self.inventory.net
            self._log_skip(side, f"INV-MAX (net={net:+.0f}, max=±{float(self._inv_max):.0f})")
            return

        best_bid = self._best_bid_for(side)
        if best_bid is not None and best_bid >= PAPER_MAX_PRICE:
            self.stats.record_skip()
            self._log_skip(side, f"pinned best_bid={float(best_bid):.3f}≥{float(PAPER_MAX_PRICE):.2f}")
            return

        best_ask = self._best_ask_for(side)
        if best_ask is None or best_ask < PAPER_MIN_PRICE or best_ask >= 1:
            self.stats.record_skip()
            self._log_skip(
                side,
                f"no usable ask (best_ask={('NA' if best_ask is None else f'{float(best_ask):.3f}')})",
            )
            return
        # Adverse-move guard (only when the strategy opts in via self.use_guard)
        if self.use_guard:
            ok, why = self.guard.allow(side)
            if not ok:
                self.stats.record_skip()
                self._log_skip(side, f"GUARD {why}")
                return

        # Dynamic bump: heavier when rebalancing the underfilled side
        bump_ticks, bump_tag = self._get_bump_ticks(side)
        limit = self._clamp_price(self._quantize_price(best_ask + self.tick_size * bump_ticks))
        if limit >= PAPER_MAX_PRICE:
            self.last_fill_time[side] = now

        order_id = uuid.uuid4().hex[:10]
        lat_ms = self._draw_place_latency_ms()
        order = PaperOrder(
            order_id=order_id,
            side=side,
            limit_price=limit,
            size=size_dec,
            submit_time=now,
            arrive_time=now + lat_ms / 1000.0,
            signal_reason=reason,
            signal_pressure=self.pressure_tracker.last_pressure,
            signal_skew_pct=self.pressure_tracker.last_skew_pct,
        )
        self.active_order[side] = order
        self.stats.record_fire()

        bump_str = f"{bump_ticks}t" + (f" ({bump_tag})" if bump_tag else "")
        logger.info(
            f"[PT-FIRE] {side} id={order_id} bump={bump_str} "
            f"best_ask={float(best_ask):.3f} → limit={float(limit):.3f} sz={float(size_dec):.0f} "
            f"reason={reason} press={order.signal_pressure:+,.0f} skew={order.signal_skew_pct:.0f}% "
            f"net={self.inventory.net:+.0f}"
        )

    async def _signal_loop(self):
        """Poll the strategy `decide()` hook and fire orders it requests."""
        while self.running:
            try:
                # session housekeeping
                self._maybe_roll_session()
                if self.feed is None:
                    await asyncio.sleep(0.1)
                    continue
                ctx = self._build_context()
                decision = self.decide(ctx)
                if decision is not None and decision.side in ("YES", "NO"):
                    await self._fire_order(
                        decision.side, decision.reason, size_override=decision.size
                    )
                await asyncio.sleep(max(0.02, self.decide_interval_sec))
            except NotImplementedError:
                raise
            except Exception as e:
                logger.error(f"[SIGNAL] error: {e}")
                await asyncio.sleep(0.5)

    # --------------------------------------------------------------------
    # Order simulator: latency, fill check, cancel timeout
    # --------------------------------------------------------------------
    async def _order_sim_loop(self):
        """Fill simulation + cancel policy matching `microprice_taker_5m` watchdog.

        After `arrive_time`: try fill; then soft cancel on ask drift; then hard
        timeout from **submit_time** (same as live).
        """
        while self.running:
            try:
                now = time.time()
                for side in ("YES", "NO"):
                    order = self.active_order[side]
                    if order is None or order.status != "PENDING":
                        continue
                    if now < order.arrive_time:
                        continue
                    best_ask = self._best_ask_for(side)
                    if best_ask is not None and best_ask <= order.limit_price:
                        await self._fill_order(order, best_ask, now)
                        continue
                    if best_ask is not None:
                        drift_ticks = float((best_ask - order.limit_price) / self.tick_size)
                        if drift_ticks > self.cancel_ask_drift_ticks:
                            await self._cancel_order(
                                order, now, reason=f"ask-drift+{drift_ticks:.0f}t"
                            )
                            continue
                    if now - order.submit_time >= self.cancel_timeout_sec:
                        await self._cancel_order(order, now, reason="timeout")
                await asyncio.sleep(0.02)
            except Exception as e:
                logger.error(f"[ORDER-SIM] error: {e}")
                await asyncio.sleep(0.2)

    async def _fill_order(self, order: PaperOrder, best_ask: Decimal, now: float):
        async with self._order_fill_lock:
            if order.status != "PENDING":
                return
            fill_price = float(best_ask)  # we get best ask after latency
            shares = float(order.size)
            fee = polymarket_fee(fill_price, shares)
            cost = shares * fill_price + fee
            order.status = "FILLED"
            order.fill_price = best_ask
            order.fill_time = now
            order.fill_size = order.size
            order.fee = fee
            order.notional = shares * fill_price
            self.last_fill_time[order.side] = now

            fill = PaperFill(
                side=order.side,
                size=shares,
                price=fill_price,
                fee=fee,
                cost=cost,
                fill_time=now,
                session_id=self.session_id or "unknown",
            )
            self.session_fills.append(fill)
            self.stats.record_fill(fill)
            # Update live inventory (fees included so MTM PnL is honest)
            self.inventory.add_buy(order.side, shares, fill_price, fee)

            slip_ticks = float((order.limit_price - best_ask) / self.tick_size)
            inv = self.inventory
            logger.info(
                f"[PT-FILL] {order.side} id={order.order_id} sz={shares:.0f} "
                f"@ {fill_price:.3f} (limit {float(order.limit_price):.3f}, "
                f"slip {slip_ticks:+.0f}t) fee=${fee:.4f} cost=${cost:.2f} "
                f"latency={(now - order.submit_time) * 1000:.0f}ms | "
                f"inv: YES={inv.yes_shares:.0f} NO={inv.no_shares:.0f} Net={inv.net:+.0f} "
                f"avgY={inv.yes_avg_price:.3f} avgN={inv.no_avg_price:.3f}"
            )
            self.active_order[order.side] = None

        # Fire the post-fill hook outside the lock (no network IO under lock).
        asyncio.create_task(self._on_fill_safe(fill))

    async def on_fill(self, fill: "PaperFill") -> None:
        """Hook called after every simulated fill.

        Override in a strategy to record/report trades (e.g. POST to an API).
        Default is a no-op. Runs off the fill lock so network IO is safe.
        """
        return None

    async def _on_fill_safe(self, fill: "PaperFill") -> None:
        try:
            await self.on_fill(fill)
        except Exception as e:
            logger.warning(f"[ON-FILL] hook error: {e}")

    async def _cancel_order(self, order: PaperOrder, now: float, reason: str = "timeout"):
        async with self._order_fill_lock:
            if order.status != "PENDING":
                return
            order.status = "CANCELLED"
            order.cancel_reason = reason
            self.stats.record_cancel()
            elapsed = (now - order.submit_time) * 1000
            logger.info(
                f"[PT-CANCEL] {order.side} id={order.order_id} reason={reason} "
                f"elapsed={elapsed:.0f}ms limit={float(order.limit_price):.3f}"
            )
            self.active_order[order.side] = None

    def _log_skip(self, side: str, reason: str):
        # Rate-limit skip logs to avoid spam (1/s per side)
        now = time.time()
        key = f"_last_skip_{side}"
        last = getattr(self, key, 0.0)
        if now - last < 1.0:
            return
        setattr(self, key, now)
        logger.info(f"[PT-SKIP] {side} reason={reason}")

    # --------------------------------------------------------------------
    # Session (daily) management & resolution
    # --------------------------------------------------------------------
    def _current_daily_session(self) -> Tuple[float, str]:
        """Return (resolution_noon_unix_ts, resolution_date_iso)."""
        now_et = datetime.now(ET_TZ)
        if _current_daily_resolution_date is not None:
            resolution_date = _current_daily_resolution_date(now_et)
        else:
            noon_today = now_et.replace(hour=12, minute=0, second=0, microsecond=0)
            resolution_date = (
                now_et.date() if now_et < noon_today else (now_et + timedelta(days=1)).date()
            )
        resolution_noon = ET_TZ.localize(
            datetime.combine(resolution_date, datetime.min.time().replace(hour=12))
        )
        session_start = resolution_noon - timedelta(hours=24)
        return resolution_noon.timestamp(), resolution_date.isoformat()

    def _maybe_roll_session(self):
        resolution_noon_ts, session_id = self._current_daily_session()
        session_start_ts = resolution_noon_ts - 86400.0
        if self.session_id is None:
            self.session_id = session_id
            self.session_start_ts = session_start_ts
            self.session_fills = []
            return
        if session_id != self.session_id:
            old_id = self.session_id
            old_start = self.session_start_ts
            old_fills = list(self.session_fills)
            self.session_id = session_id
            self.session_start_ts = session_start_ts
            self.session_fills = []
            self._reset_session_state(old_id, session_id)
            asyncio.create_task(self._resolve_session(old_id, old_start, old_fills))
            asyncio.create_task(self._request_market_switch())
            asyncio.create_task(self._refresh_session_open(session_id))

    async def _refresh_session_open(self, session_id: str):
        """Fetch Binance reference price at noon ET when the daily market opened."""
        try:
            await asyncio.sleep(SESSION_OPEN_FETCH_DELAY_SEC)
        except asyncio.CancelledError:
            raise
        if self.session_id != session_id:
            return
        open_px = await self._fetch_session_reference_open()
        if open_px is not None and self.session_id == session_id:
            self.session_open_price = open_px
            logger.info(f"[CANDLE] session={session_id} open=${open_px:,.2f}")

    def _reset_session_state(self, old_id: Optional[str], new_id: str) -> None:
        """Wipe every per-session piece of state.

        Modeled on `microprice_mm_5m._reset_state()`:
        - inventory back to zero
        - signal trackers (binance_book, trade_flow, pressure_tracker) cleared
        - in-flight orders force-cancelled (paper)
        - per-side cooldowns / counters reset
        - order sizing snapped back to originals (in case anything scaled)
        - guard kept (it's a continuous Binance mid feed, no boundary)
        """
        # Binance 5m candle open for the *previous* session — must clear so
        # STATUS / TUI never show stale open vs new bucket mid.
        self.session_open_price = None

        # Cancel any paper orders in flight — counted as session-roll cancels
        now = time.time()
        for side in ("YES", "NO"):
            o = self.active_order[side]
            if o is not None and o.status == "PENDING":
                o.status = "CANCELLED"
                o.cancel_reason = "session-roll"
                self.stats.record_cancel()
                logger.info(
                    f"[PT-CANCEL] {side} id={o.order_id} reason=session-roll "
                    f"elapsed={(now - o.submit_time) * 1000:.0f}ms limit={float(o.limit_price):.3f}"
                )
            self.active_order[side] = None
            self.last_fill_time[side] = 0.0

        # Inventory + signals
        self.inventory.reset()
        self.binance_book.reset()
        self.trade_flow.reset()
        self.pressure_tracker.reset()
        # Do NOT clear the price-move guard — it's a continuous BTC mid stream
        # and discarding it would force every signal in the first 400ms to pass
        # without any history (false-permissive). The guard self-prunes.

        # Telemetry counters that are per-session (mirrors live MM)
        self._sbe_depth_count = 0
        self._sbe_trade_count = 0
        self._poly_msg_count = 0

        # Snap sizing back to originals (no per-session scaling in paper, but
        # this matches the live MM contract and protects against future tweaks)
        self._base_order_size = self._orig_base_order_size
        self._inv_max = self._orig_inv_max

        logger.info(
            f"[PT-RESET] {old_id or '∅'} → {new_id} | "
            f"size={float(self._base_order_size):.0f} max_inv=±{float(self._inv_max):.0f} | "
            f"inventory cleared, signal trackers reset, in-flight orders cancelled"
        )

    async def _resolve_session(self, session_id: str, start_ts: Optional[float],
                                fills: List[PaperFill]):
        if not fills:
            logger.info(f"[PT-RESOLVE] session {session_id} — no fills (skip)")
            return
        # Determine winning side via Binance candle:
        # open at start_ts, close at end_ts (start_ts + 300s)
        end_ts = (start_ts or time.time()) + 86400.0
        await asyncio.sleep(2.0)
        open_px = await self._fetch_binance_price_at(start_ts) if start_ts else None
        close_px = await self._fetch_binance_price_at(end_ts) if start_ts else None
        if open_px is None or close_px is None:
            logger.warning(f"[PT-RESOLVE] {session_id} could not fetch candle — treating as PUSH")
            winning_side = None
        else:
            if close_px > open_px:
                winning_side = "YES"
            elif close_px < open_px:
                winning_side = "NO"
            else:
                winning_side = None

        session_pnl, wins, losses = self.stats.record_resolution(session_id, fills, winning_side)
        win_rate = self.stats.win_rate()
        st = self.stats.stats
        logger.info(
            f"[PT-RESOLVE] session={session_id} winner={winning_side or 'PUSH'} "
            f"open={open_px} close={close_px} fills={len(fills)} "
            f"wins={wins} losses={losses} pnl=${session_pnl:+.2f} | "
            f"AllTime PnL=${st.realised_pnl:+.2f} ROI={st.roi_pct():+.2f}% "
            f"MaxDD=${st.max_drawdown_abs:.2f}/{st.max_drawdown_pct:.2f}% "
            f"sessions={st.sessions_resolved} win_rate={win_rate*100:.1f}%"
        )

    # --------------------------------------------------------------------
    # Status / stats logging (consumed by the TUI)
    # --------------------------------------------------------------------
    async def _status_loop(self):
        while self.running:
            try:
                await asyncio.sleep(1.0)
                self._log_status()
                self._log_model_status()
            except Exception as e:
                logger.error(f"[STATUS] error: {e}")

    def _strategy_model_probs(self) -> Optional[Tuple[Optional[float], Optional[float]]]:
        """Strategy hook for the [PT-MODEL] dashboard line.

        Override to return ``(model_p_up, market_p_up)`` so the TUI can show the
        strategy's current probability estimate vs the market-implied one.
        Default returns ``None`` (no model line content beyond strike/time).
        """
        return None

    def _log_model_status(self):
        """Emit [PT-MODEL]: strike (daily open), time-left, and P(Up).

        strike  = Binance price when the daily market began (noon ET open)
        t_left  = hours until noon ET resolution
        P(Up)   = strategy model estimate vs market-implied (YES mid), if any
        """
        resolution_noon_ts, sess_date = self._current_daily_session()
        t_left_h = max(0.0, (resolution_noon_ts - time.time()) / 3600.0)
        strike = self.session_open_price

        model_p = market_p = None
        try:
            probs = self._strategy_model_probs()
            if probs is not None:
                model_p, market_p = probs
        except Exception as e:
            logger.debug(f"[PT-MODEL] strategy probs error: {e}")

        strike_str = f"{strike:.2f}" if strike is not None else "NA"
        model_str = f"{model_p:.4f}" if model_p is not None else "NA"
        market_str = f"{market_p:.4f}" if market_p is not None else "NA"
        edge_str = (
            f"{model_p - market_p:+.4f}"
            if (model_p is not None and market_p is not None) else "NA"
        )
        logger.info(
            f"[PT-MODEL] session={sess_date} strike=${strike_str} "
            f"t_left={t_left_h:.2f}h Pup_model={model_str} "
            f"Pup_mkt={market_str} edge={edge_str}"
        )

    async def _stats_loop(self):
        while self.running:
            try:
                await asyncio.sleep(15.0)
                self._log_full_stats()
            except Exception as e:
                logger.error(f"[STATS] error: {e}")

    def _ws_status_str(self) -> str:
        parts = []
        parts.append("BT" if self.binance_depth_ws_connected else "bt✗")
        parts.append("TR" if self.binance_aggtrade_ws_connected else "tr✗")
        parts.append("PM" if self.feed and self.feed.connected else "pm✗")
        return ",".join(parts)

    def _log_status(self):
        gate_side, gate_reason = self._evaluate_gate()
        if gate_side == "YES":
            gate_str = f"BULL({gate_reason})"
        elif gate_side == "NO":
            gate_str = f"BEAR({gate_reason})"
        else:
            gate_str = "NONE"

        skew_pct = self.pressure_tracker.last_skew_pct
        press = self.pressure_tracker.last_pressure
        thr = self.pressure_tracker.last_threshold_usd
        bd = self.pressure_tracker.last_bid_delta
        ad = self.pressure_tracker.last_ask_delta
        bid_usd = self.pressure_tracker.last_bid_usd
        ask_usd = self.pressure_tracker.last_ask_usd
        trade_skew = self.trade_flow.get_skew(PAPER_TRADE_FLOW_WINDOW_SEC)

        yes_ord = self.active_order["YES"]
        no_ord = self.active_order["NO"]
        yes_active = "Y●" if yes_ord else "Y-"
        no_active = "N●" if no_ord else "N-"

        ymid = self.poly_yes_mid
        ybid = self.poly_yes_bid
        yask = self.poly_yes_ask
        poly_str = (
            f"Mid:{float(ymid):.3f}(Bid:{float(ybid):.3f}/Ask:{float(yask):.3f})"
            if (ymid is not None and ybid is not None and yask is not None) else "Mid:---"
        )

        s = self.stats.stats
        inv = self.inventory
        ymid_f = float(ymid) if ymid is not None else None
        mtm = inv.mtm_pnl(ymid_f) if ymid_f is not None else 0.0
        worst = inv.worst_case_pnl()
        sess_fees = inv.yes_fees + inv.no_fees

        # All-time PnL is purely the sum of resolved sessions.
        all_time_pnl = s.realised_pnl
        all_time_gross = all_time_pnl + s.total_fees
        roi_pct = s.roi_pct()
        max_dd_abs = s.max_drawdown_abs
        max_dd_pct = s.max_drawdown_pct
        fees_total = s.total_fees

        # BTC: session open → current (matches microprice_tui.py BTC panel)
        # Format strictly when both numbers are present so the TUI regex can
        # parse cleanly. After a bucket roll, open is None until REST returns
        # — emit a dedicated "pending" line so the TUI clears stale open/pct but
        # still updates the live mid (see _RE_BTC_PENDING in microprice_paper_tui).
        btc_open = self.session_open_price
        btc_now = self.binance_mid
        if btc_open and btc_now:
            pct = (btc_now - btc_open) / btc_open * 100.0
            btc_str = f"BTC: {btc_open:.2f}\u2192{btc_now:.2f} ({pct:+.3f}%)"
        elif btc_now:
            btc_str = f"BTC: pending {btc_now:.2f} open=reset"
        else:
            btc_str = "BTC: - (no mid)"

        logger.info(
            f"[PT-STATUS] WS:{self._ws_status_str()} | "
            f"d:{self._sbe_depth_count} t:{self._sbe_trade_count} pm:{self._poly_msg_count} | "
            f"{btc_str} | "
            f"{poly_str} | "
            f"BookUSD: bid={bid_usd:,.0f} ask={ask_usd:,.0f} skew={skew_pct:.0f}% | "
            f"Pressure: p={press:+,.0f} thr={thr:,.0f} gate={gate_str} "
            f"bidΔ={bd:+,.0f} askΔ={ad:+,.0f} | "
            f"Trade:{trade_skew:+.2f} | "
            f"{yes_active} {no_active} | "
            f"Sz:{float(self._base_order_size):.0f}/Inv:{float(self._inv_max):.0f} | "
            f"Inv: {inv.yes_shares:.0f}Y/{inv.no_shares:.0f}N (Net:{inv.net:+.0f}) "
            f"Avg: Y{inv.yes_avg_price:.3f} N{inv.no_avg_price:.3f} | "
            f"MTM:${mtm:+.2f} SessFees:-${sess_fees:.2f} Worst:${worst:+.2f} | "
            f"AllTime PnL:${all_time_pnl:+.2f} ROI:{roi_pct:+.2f}% "
            f"MaxDD:${max_dd_abs:.2f}/{max_dd_pct:.2f}% "
            f"Gross:${all_time_gross:+.2f} Fees:-${fees_total:.2f} | "
            f"Sess:{s.sessions_resolved} Fills:Y{s.yes_fills}/N{s.no_fills} "
            f"Cxl:{s.cancelled_orders} Skip:{s.skipped_signals} | "
            f"Guard:Yblk{self.guard.blocks_yes}/Nblk{self.guard.blocks_no}"
        )

    def _log_full_stats(self):
        s = self.stats.stats
        sharpe = s.sharpe()
        roi = s.roi_pct()
        win_rate = s.win_rate()
        avg_session = s.avg_session_pnl()
        avg_trade = s.avg_trade_pnl()
        sharpe_str = f"{sharpe:+.2f}" if sharpe != float("inf") else "inf"
        logger.info(
            f"[PT-STATS] pnl=${s.realised_pnl:+.2f} gross=${s.gross_pnl():+.2f} "
            f"fees=${s.total_fees:.2f} roi_base=${s.starting_bankroll:,.0f} "
            f"roi={roi:+.2f}% sharpe={sharpe_str} "
            f"max_dd=${s.max_drawdown_abs:.2f}/{s.max_drawdown_pct:.2f}% "
            f"sessions={s.sessions_resolved} wins={s.win_count} losses={s.loss_count} push={s.push_count} "
            f"win_rate={win_rate*100:.1f}% "
            f"avg_sess=${avg_session:+.3f} avg_trade=${avg_trade:+.3f} "
            f"best=${s.best_session_pnl:+.2f} worst=${s.worst_session_pnl:+.2f} "
            f"fired={s.fired_orders} fills={s.total_fills} cxl={s.cancelled_orders} "
            f"notional=${s.total_notional:,.0f} "
            f"hwm=${s.equity_high_water:+.2f} "
            f"started={s.started_at}"
        )

    # --------------------------------------------------------------------
    # Run / shutdown
    # --------------------------------------------------------------------
    async def run(self):
        load_dotenv(_PACKAGE_ROOT / ".env")
        # async-friendly Event must be created inside an event loop
        self._poly_switch_event = asyncio.Event()
        if not await self.connect():
            return

        # Session BTC open — same path as live taker: wait SESSION_OPEN_FETCH_DELAY_SEC
        # then fetch+verify (see `_refresh_session_open`); do not pull klines immediately.
        self._maybe_roll_session()
        if self.session_id:
            asyncio.create_task(self._refresh_session_open(self.session_id))

        self.running = True
        tasks = [
            asyncio.create_task(self._binance_bookticker_listener()),
            asyncio.create_task(self._binance_aggtrade_listener()),
            asyncio.create_task(self._poly_feed_supervisor()),
            asyncio.create_task(self._signal_loop()),
            asyncio.create_task(self._order_sim_loop()),
            asyncio.create_task(self._status_loop()),
            asyncio.create_task(self._stats_loop()),
        ]

        logger.info("=" * 78)
        if self._latency_fixed_ms is not None:
            lat_desc = f"{self._latency_fixed_ms}ms fixed"
        else:
            lat_desc = (
                f"lognormal p50≈{PAPER_LATENCY_MEDIAN_MS:.0f}ms p95≈{PAPER_LATENCY_P95_MS:.0f}ms"
            )
        logger.info(
            f"  PAPER TRADER STARTED — coin={self.coin_id.upper()} "
            f"size={float(self._base_order_size):.0f} max_inv=±{float(self._inv_max):.0f} "
            f"({self._size_label}) min={float(PAPER_MIN_ORDER_SIZE):.0f} "
            f"bump={self.bump_ticks}t (escalates to {INV_TICK_BUMP_2_TICKS}t at {float(INV_TICK_BUMP_2_THRESHOLD)*100:.0f}% rebal) "
            f"latency={lat_desc} cancel={self.cancel_timeout_sec}s hard+{self.cancel_ask_drift_ticks}t drift "
            f"cooldown={self.fill_cooldown_sec}s require_flow={self.require_trade_flow}"
        )
        logger.info(
            f"  Gate: pressure>{self.pressure_tracker.pressure_threshold_pct:.0f}% + "
            f"skew>{self.pressure_tracker.skew_flow_pct:.0f}% OR skew_alone>{self.pressure_tracker.skew_alone_pct:.0f}%"
            f"  TopBookSkew place>{self.binance_book.place_threshold*100:.0f}% "
            f"persist={self.binance_book.persistence_count}"
        )
        logger.info(
            f"  Trade flow: bull≥{self.trade_flow.bullish_threshold:+.2f} bear≤{self.trade_flow.bearish_threshold:+.2f}"
        )
        logger.info(
            f"  Guard: window={self.guard.window_ms}ms (block bullish if BTC mid dropped, vice-versa)"
        )
        logger.info(
            f"  Fees: ≈{2 * PAPER_FEE_RATE_AT_MID:.2f}×p(1−p)×size "
            f"(~{PAPER_FEE_RATE_AT_MID:.1%} of notional @ 50¢)"
        )
        logger.info("=" * 78)

        try:
            await asyncio.gather(*tasks)
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            self.running = False
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.feed:
                self.feed.stop()
            if self._aiohttp_session and not self._aiohttp_session.closed:
                await self._aiohttp_session.close()
            self._log_full_stats()
            logger.info("[PT-EXIT] paper trader stopped")


# ============================================================================
# CLI
# ============================================================================

def build_base_parser(description: str = "Daily Paper Trader (base engine)") -> argparse.ArgumentParser:
    """Shared CLI for any strategy built on `BaseDailyPaperTrader`.

    Strategy runners can extend the returned parser with their own flags.
    """
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--coin", type=str, default="btc", choices=["btc", "eth", "sol", "xrp"])
    # Sizing: by default use the same per-coin defaults as microprice_mm_5m.py
    # (BTC: 30/150, ETH: 10/50, SOL/XRP: 30/150). --test / --live / --default
    # match the live-MM presets; --size / --max-inv override anything above.
    p.add_argument("--size", type=float, default=None,
                   help="Override base order size (default: per-coin like live MM)")
    p.add_argument("--max-inv", type=float, default=None,
                   help="Override max NET inventory (default: per-coin like live MM)")
    p.add_argument("--test", action="store_true",
                   help="Test preset: size=15, max_inv=80 (live MM --test)")
    p.add_argument("--live", action="store_true",
                   help="Live preset: size=30, max_inv=160 (live MM --live)")
    p.add_argument("--default", dest="default_size", action="store_true",
                   help="Default preset: size=30, max_inv=150 (live MM --default)")
    p.add_argument("--initial-equity", "--bankroll", dest="initial_equity",
                   type=float, default=PAPER_INITIAL_EQUITY,
                   help=(f"ROI denominator (default: ${PAPER_INITIAL_EQUITY:,.0f}). "
                         "There is no real bankroll — sessions are just summed; "
                         "this only normalises the ROI%%."))
    p.add_argument("--persist-stats", action="store_true",
                   help="Load/save all-time stats JSON under papertrade/paper_state/ (default: in-memory only)")
    # Execution model
    p.add_argument("--bump", type=int, default=PAPER_DEFAULT_BUMP_TICKS,
                   help=f"GTC bump in ticks above best ask (default: {PAPER_DEFAULT_BUMP_TICKS})")
    p.add_argument("--latency-ms", type=int, default=None,
                   help=(
                       "Fixed simulated post latency in ms. Omit for lognormal ~"
                       f"p50≈{PAPER_LATENCY_MEDIAN_MS:.0f}ms ~p95≈{PAPER_LATENCY_P95_MS:.0f}ms"
                   ))
    p.add_argument("--cancel-timeout", type=float, default=PAPER_CANCEL_TIMEOUT_SEC,
                   help=(f"Hard cancel backstop in sec from submit (default: {PAPER_CANCEL_TIMEOUT_SEC}; "
                         "same as live taker)."))
    p.add_argument("--cancel-ask-drift-ticks", type=int, default=PAPER_CANCEL_ASK_DRIFT_TICKS,
                   help=(f"Soft cancel: if best_ask exceeds limit by >N ticks (default: "
                         f"{PAPER_CANCEL_ASK_DRIFT_TICKS}, same as live)."))
    p.add_argument("--fill-cooldown", type=float, default=PAPER_FILL_COOLDOWN_SEC,
                   help=(f"Per-side cooldown after fill in sec (default: {PAPER_FILL_COOLDOWN_SEC}); "
                         f"capped to {PAPER_FILL_COOLDOWN_IN_TAIL_SEC:.0f}s in last "
                         f"{PAPER_FILL_COOLDOWN_TAIL_SEC:.0f}s before noon ET resolution (min with this value)"))
    p.add_argument("--guard-window-ms", type=int, default=PAPER_GUARD_WINDOW_MS,
                   help="Adverse-move guard lookback (default: 400ms)")
    # Signal thresholds
    p.add_argument("--pressure-window", type=float, default=PAPER_PRESSURE_WINDOW_SEC)
    p.add_argument("--pressure-threshold", type=float, default=PAPER_PRESSURE_THRESHOLD_PCT)
    p.add_argument("--skew-flow", type=float, default=PAPER_SKEW_FLOW_THRESHOLD_PCT)
    p.add_argument("--skew-alone", type=float, default=PAPER_SKEW_ALONE_THRESHOLD_PCT)
    p.add_argument("--skew-place", type=float, default=PAPER_SKEW_PLACE_THRESHOLD,
                   help="Top-of-book skew place threshold (0-1)")
    p.add_argument("--persistence", type=int, default=PAPER_SKEW_PERSISTENCE_COUNT,
                   help="Consecutive readings before skew is confirmed (each ≈100ms)")
    p.add_argument("--trade-bull", type=float, default=PAPER_TRADE_FLOW_BULL,
                   help="Trade-flow bullish threshold (e.g. 0.50)")
    p.add_argument("--trade-bear", type=float, default=PAPER_TRADE_FLOW_BEAR,
                   help="Trade-flow bearish threshold (e.g. -0.50)")
    p.add_argument("--loose", action="store_true",
                   help="Drop trade-flow confirmation requirement (pressure+skew only)")
    p.add_argument("--reset-stats", action="store_true",
                   help="Delete persisted JSON for this coin before starting (use with --persist-stats)")
    return p


def run_trader(trader: "BaseDailyPaperTrader", args: argparse.Namespace) -> None:
    """Shared run helper: optional stats reset, then run the async loop."""
    if getattr(args, "reset_stats", False):
        path = PAPER_STATE_DIR / f"{args.coin.lower()}_daily_paper_state.json"
        if path.exists():
            path.unlink()
            logger.info(f"[PT-RESET] removed {path}")
    try:
        asyncio.run(trader.run())
    except KeyboardInterrupt:
        logger.info("\nStopped by user")
