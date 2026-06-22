#!/usr/bin/env python3
"""Launch the 5m microprice paper trader TUI."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from papertrade.microprice_paper_tui import main

if __name__ == "__main__":
    main()
