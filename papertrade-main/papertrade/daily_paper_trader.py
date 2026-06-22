"""
Daily Paper Trader — runner
===========================

Thin entry point that wires a strategy onto the `BaseDailyPaperTrader` engine
and runs it. Default strategy: `SimpleProbabilityTrader` (P(Up) vs market mid).

Run:
    python papertrade/daily_paper_trader.py --coin btc
    python -m papertrade.daily_paper_trader --coin eth --edge-threshold 0.07

The companion TUI (`daily_paper_trader_tui.py`) spawns this script and parses
its structured stdout ([PT-STATUS], [PT-FILL], ...).

To plug in your own strategy:
    1. Copy `papertrade/base_trader.py` ideas or subclass `BaseDailyPaperTrader`
       in `papertrade/strategies/<your_strategy>.py` and implement `decide()`.
    2. Import it here and select it via `--strategy`.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Allow running as a script (`python papertrade/daily_paper_trader.py`) by
# putting the repo root (parent of this package) on sys.path.
_PACKAGE_ROOT = Path(os.path.dirname(os.path.abspath(__file__))).parent
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))

from papertrade.base_trader import build_base_parser, run_trader
from papertrade.strategies.simple_probability import (
    DEFAULT_COOLDOWN_SEC,
    DEFAULT_EDGE_THRESHOLD,
    AnSimpleProbabilityTrader,
)

# Strategy registry: name -> trader class
STRATEGIES = {
    "an_simple": AnSimpleProbabilityTrader,
}


def build_parser() -> argparse.ArgumentParser:
    p = build_base_parser(
        description="Daily Paper Trader — pluggable strategy on the daily-market engine"
    )
    p.add_argument(
        "--strategy",
        type=str,
        default="an_simple",
        choices=sorted(STRATEGIES.keys()),
        help="Strategy to run (default: an_simple)",
    )
    p.add_argument(
        "--edge-threshold",
        type=float,
        default=DEFAULT_EDGE_THRESHOLD,
        help=f"Take when |P_model - P_market| exceeds this (default: {DEFAULT_EDGE_THRESHOLD:.0%})",
    )
    p.add_argument(
        "--decide-interval",
        type=float,
        default=1.0,
        help="Seconds between strategy decisions (default: 1.0)",
    )
    p.add_argument(
        "--no-record",
        action="store_true",
        help="Disable POSTing fills to the trades API (account 'An')",
    )
    # Default the per-side cooldown to the strategy's preferred value (30s).
    p.set_defaults(fill_cooldown=DEFAULT_COOLDOWN_SEC)
    return p


def main() -> None:
    args = build_parser().parse_args()
    trader_cls = STRATEGIES[args.strategy]
    trader = trader_cls(args.coin, args)
    run_trader(trader, args)


if __name__ == "__main__":
    main()
