#!/usr/bin/env python3
"""Launch the Daily Paper Trader TUI."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from papertrade.daily_paper_trader_tui import main

if __name__ == "__main__":
    main()
