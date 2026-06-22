"""
TUI dashboard for `daily_paper_trader.py` (Daily Paper Trader).

Run:
    python -m papertrade.daily_paper_trader_tui --coin btc
    python papertrade/daily_paper_trader_tui.py --coin btc
"""

from __future__ import annotations

import argparse
import io
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Deque, List, Optional


# ── ANSI ────────────────────────────────────────────────────────────────────
RESET   = "\033[0m"
BOLD    = "\033[1m"
DIM     = "\033[2m"
RED     = "\033[31m"
GREEN   = "\033[32m"
YELLOW  = "\033[33m"
BLUE    = "\033[34m"
MAGENTA = "\033[35m"
CYAN    = "\033[36m"
WHITE   = "\033[37m"
GRAY    = "\033[90m"
CSI_HOME       = "\033[H"
CSI_CLEAR_DOWN = "\033[J"
CSI_CLEAR_EOL  = "\033[K"
CSI_HIDE_CUR   = "\033[?25l"
CSI_SHOW_CUR   = "\033[?25h"

W = 124  # dashboard width


# ── State ────────────────────────────────────────────────────────────────────
@dataclass
class OrderRow:
    ts: str
    side: str       # "YES" | "NO"
    action: str     # "FIRE" | "FILL" | "CANCEL" | "SKIP"
    price: str
    size: str
    extra: str = ""


@dataclass
class DashState:
    started_at: float = field(default_factory=time.time)

    # Live status (from [PT-STATUS])
    ws: str = "---"
    sbe_d: int = 0
    sbe_t: int = 0
    poly_msgs: int = 0
    poly_mid: Optional[float] = None
    poly_bid: Optional[float] = None
    poly_ask: Optional[float] = None
    bid_usd: Optional[float] = None
    ask_usd: Optional[float] = None
    skew_pct: Optional[float] = None
    pressure: Optional[float] = None
    pressure_thr: Optional[float] = None
    bid_delta: Optional[float] = None
    ask_delta: Optional[float] = None
    gate: str = "NONE"
    gate_reason: str = ""
    trade_skew: Optional[float] = None
    yes_active: bool = False
    no_active: bool = False
    # All-time numbers (sum of resolved sessions only — open MTM is shown separately)
    pnl_live: Optional[float] = None       # all-time PnL (after fees), live from STATUS
    pnl_gross_live: Optional[float] = None # all-time PnL before fees
    fees_live: Optional[float] = None      # cumulative fees paid (negative for display)
    roi_live: Optional[float] = None       # ROI % vs initial-equity denominator
    max_dd_abs_live: Optional[float] = None
    max_dd_pct_live: Optional[float] = None
    sessions_live: int = 0
    yes_fills_live: int = 0
    no_fills_live: int = 0
    cancels_live: int = 0
    skips_live: int = 0
    guard_yes_blk: int = 0
    guard_no_blk: int = 0

    # Live inventory + MTM (per current 5-min session)
    inv_yes: Optional[float] = None
    inv_no: Optional[float] = None
    inv_net: Optional[float] = None
    avg_yes: Optional[float] = None
    avg_no: Optional[float] = None
    mtm_pnl: Optional[float] = None
    worst_pnl: Optional[float] = None
    session_fees: Optional[float] = None    # fees paid this 5m session (from fills)

    # Sizing config (mirrors microprice_mm_5m: base size + max NET inv)
    base_size: Optional[float] = None
    max_inv: Optional[float] = None
    last_reset: str = ""

    # 5-min market rolling (mirrors microprice_mm_5m: new market every bucket)
    market_question: str = ""
    market_cid: str = ""
    market_switches: int = 0
    last_market_switch: str = ""

    # BTC (or coin) underlying price — session open vs current
    btc_open: Optional[float] = None
    btc_current: Optional[float] = None
    btc_pct: Optional[float] = None

    # Probability model ([PT-MODEL]) — strike, time-left, P(Up)
    model_session: str = ""
    model_strike: Optional[float] = None       # daily-open strike (price-to-beat)
    model_time_left_h: Optional[float] = None   # hours until noon ET resolution
    model_prob_up: Optional[float] = None       # strategy model P(Up)
    model_market_prob_up: Optional[float] = None  # market-implied P(Up) = YES mid
    model_edge: Optional[float] = None          # model - market

    # All-time stats (from [PT-STATS]) — pure sum of resolved-session PnLs
    realised_pnl: Optional[float] = None       # all-time PnL (after fees)
    gross_pnl_total: Optional[float] = None    # all-time PnL before fees
    fees_total: Optional[float] = None
    roi_base: Optional[float] = None           # ROI denominator (initial equity)
    roi_pct: Optional[float] = None
    sharpe: Optional[str] = None
    max_dd_abs: Optional[float] = None
    max_dd_pct: Optional[float] = None
    sessions: int = 0
    wins: int = 0
    losses: int = 0
    push: int = 0
    win_rate: Optional[float] = None
    avg_session_pnl: Optional[float] = None
    avg_trade_pnl: Optional[float] = None
    best_session: Optional[float] = None
    worst_session: Optional[float] = None
    fired: int = 0
    total_fills: int = 0
    cancelled: int = 0
    notional: Optional[float] = None
    hwm: Optional[float] = None
    started_iso: str = ""

    # Logs
    orders: Deque[OrderRow] = field(default_factory=lambda: deque(maxlen=40))
    events: Deque[list] = field(default_factory=lambda: deque(maxlen=30))
    fires_total: int = 0
    fills_total: int = 0
    last_resolve: str = ""

    def add_event(self, msg: str):
        if self.events and self.events[0][0] == msg:
            self.events[0][1] += 1
        else:
            self.events.appendleft([msg, 1])


# ── Helpers ─────────────────────────────────────────────────────────────────
def _sf(v: str) -> Optional[float]:
    try:
        return float(v.replace(",", ""))
    except Exception:
        return None


def _si(v: str) -> Optional[int]:
    try:
        return int(v.replace(",", ""))
    except Exception:
        return None


# ── Pre-compiled regexes ────────────────────────────────────────────────────
_RE_PT_STATUS = re.compile(r"\[PT-STATUS\]")
_RE_WS        = re.compile(r"WS:(\S+)\s*\|")
_RE_DT        = re.compile(r"d:(\d+)\s+t:(\d+)\s+pm:(\d+)")
_RE_POLY      = re.compile(r"Mid:([\d.]+)\(Bid:([\d.]+)/Ask:([\d.]+)\)")
_RE_BOOKUSD   = re.compile(r"BookUSD:\s*bid=([\d,.]+)\s+ask=([\d,.]+)\s+skew=([\d.]+)%")
_RE_PRESSURE  = re.compile(
    r"Pressure:\s*p=([+\-\d,.]+)\s+thr=([\d,.]+)\s+gate=(\w+)(?:\(([^)]*)\))?\s+bid(?:Δ|Delta)=([+\-\d,.]+)\s+ask(?:Δ|Delta)=([+\-\d,.]+)"
)
_RE_TRADE     = re.compile(r"Trade:([+\-\d.]+)")
_RE_ACTIVE    = re.compile(r"(Y[●-])\s+(N[●-])")
# All-time PnL block from [PT-STATUS] (post-rewrite — no Equity concept)
# "AllTime PnL:$+12.34 ROI:+0.62% MaxDD:$5.50/0.28% Gross:$+25.00 Fees:-$12.66"
_RE_ALLTIME_LIVE = re.compile(
    r"AllTime\s+PnL:\$([+\-\d,.]+)\s+ROI:([+\-\d.]+)%\s+"
    r"MaxDD:\$([\d,.]+)/([\d.]+)%\s+"
    r"Gross:\$([+\-\d,.]+)\s+Fees:-\$([\d,.]+)"
)
_RE_SESS_LIVE = re.compile(
    r"Sess:(\d+)\s+Fills:Y(\d+)/N(\d+)\s+Cxl:(\d+)\s+Skip:(\d+)"
)
_RE_GUARD     = re.compile(r"Guard:Yblk(\d+)/Nblk(\d+)")
_RE_INV       = re.compile(r"Inv:\s*([\d.]+)Y/([\d.]+)N\s*\(Net:([+\-\d.]+)\)")
_RE_AVG       = re.compile(r"Avg:\s*Y([\d.]+)\s*N([\d.]+)")
_RE_MTM       = re.compile(
    r"MTM:\$([+\-\d.]+)\s+SessFees:-\$([\d.]+)\s+Worst:\$([+\-\d.]+)"
)
_RE_SZINV     = re.compile(r"Sz:([\d.]+)/Inv:([\d.]+)")
_RE_RESET     = re.compile(
    r"\[PT-RESET\]\s+(\S+)\s+→\s+(\S+)\s+\|\s+size=([\d.]+)\s+max_inv=±([\d.]+)"
)
_RE_MARKET_SWITCH = re.compile(
    r"\[PT-MARKET\]\s+#(\d+)\s+switched:\s+(\S+)\s+→\s+(\S+)\s+"
    r"yes=\S+\s+no=\S+\s+q=(.*)$"
)
_RE_MARKET_INIT = re.compile(
    r"\[PT-MARKET\]\s+(.+)"
)
_RE_MARKET_COND = re.compile(
    r"\[PT-MARKET\]\s+condition=(\S+)"
)
_RE_BTC = re.compile(r"BTC:\s*([\d.]+)\u2192([\d.]+)\s+\(([+\-\d.]+)%\)")
_RE_BTC_PENDING = re.compile(r"BTC:\s*pending\s+([\d.]+)\s+open=reset")

# [PT-MODEL] session=2026-06-22 strike=$64198.02 t_left=5.42h
#            Pup_model=0.4712 Pup_mkt=0.5300 edge=-0.0588
_RE_PT_MODEL = re.compile(
    r"\[PT-MODEL\]\s+session=(\S+)\s+strike=\$(\S+)\s+t_left=([\d.]+)h\s+"
    r"Pup_model=(\S+)\s+Pup_mkt=(\S+)\s+edge=(\S+)"
)

_RE_PT_STATS_EQUITY = re.compile(
    r"\[PT-STATS\]\s+pnl=\$([+\-\d,.]+)\s+gross=\$([+\-\d,.]+)\s+fees=\$([\d,.]+)\s+"
    r"roi_base=\$([\d,.]+)\s+roi=([+\-\d.]+)%\s+sharpe=(\S+)\s+"
    r"max_dd=\$([\d,.]+)/([\d.]+)%\s+"
    r"sessions=(\d+)\s+wins=(\d+)\s+losses=(\d+)\s+push=(\d+)\s+"
    r"win_rate=([\d.]+)%\s+avg_sess=\$([+\-\d,.]+)\s+avg_trade=\$([+\-\d,.]+)\s+"
    r"best=\$([+\-\d,.]+)\s+worst=\$([+\-\d,.]+)\s+"
    r"fired=(\d+)\s+fills=(\d+)\s+cxl=(\d+)\s+notional=\$([\d,.]+)\s+hwm=\$([+\-\d,.]+)"
)
_RE_PT_STATS_STARTED = re.compile(r"started=(\S+)")

_RE_PT_FIRE = re.compile(
    r"\[PT-FIRE\]\s+(YES|NO)\s+id=(\w+)\s+bump=(\d+t(?:\s*\([^)]*\))?)\s+"
    r"best_ask=([\d.]+)\s+→\s+limit=([\d.]+)\s+sz=([\d.]+)\s+reason=(.+?)\s+press="
)
_RE_PT_FILL = re.compile(
    r"\[PT-FILL\]\s+(YES|NO)\s+id=(\w+)\s+sz=([\d.]+)\s+@\s+([\d.]+)\s+\(limit\s+([\d.]+),\s+slip\s+([+\-\d.]+)t\)\s+fee=\$([\d.]+)\s+cost=\$([\d.]+)\s+latency=([\d.]+)ms"
)
_RE_PT_FILL_INV = re.compile(
    r"inv:\s+YES=([\d.]+)\s+NO=([\d.]+)\s+Net=([+\-\d.]+)\s+avgY=([\d.]+)\s+avgN=([\d.]+)"
)
_RE_PT_CANCEL = re.compile(
    r"\[PT-CANCEL\]\s+(YES|NO)\s+id=(\w+)\s+reason=(\S+)\s+elapsed=([\d.]+)ms\s+limit=([\d.]+)"
)
_RE_PT_SKIP = re.compile(r"\[PT-SKIP\]\s+(YES|NO)\s+reason=(.+)")
_RE_PT_RESOLVE = re.compile(
    r"\[PT-RESOLVE\]\s+session=(\S+)\s+winner=(\S+)\s+open=(\S+)\s+close=(\S+)"
    r"\s+fills=(\d+)\s+wins=(\d+)\s+losses=(\d+)\s+pnl=\$([+\-\d.]+)\s+\|\s+"
    r"AllTime\s+PnL=\$([+\-\d,.]+)\s+ROI=([+\-\d.]+)%\s+"
    r"MaxDD=\$([\d,.]+)/([\d.]+)%\s+sessions=(\d+)\s+win_rate=([\d.]+)%"
)


# ── Parser ──────────────────────────────────────────────────────────────────
def parse_line(s: DashState, line: str) -> None:
    line = line.rstrip("\n\r")
    if not line:
        return

    if "[PT-STATUS]" in line:
        m = _RE_WS.search(line)
        if m:
            s.ws = m.group(1)
        m = _RE_DT.search(line)
        if m:
            s.sbe_d = int(m.group(1))
            s.sbe_t = int(m.group(2))
            s.poly_msgs = int(m.group(3))
        m = _RE_POLY.search(line)
        if m:
            s.poly_mid = _sf(m.group(1))
            s.poly_bid = _sf(m.group(2))
            s.poly_ask = _sf(m.group(3))
        m = _RE_BOOKUSD.search(line)
        if m:
            s.bid_usd = _sf(m.group(1))
            s.ask_usd = _sf(m.group(2))
            s.skew_pct = _sf(m.group(3))
        m = _RE_PRESSURE.search(line)
        if m:
            s.pressure = _sf(m.group(1))
            s.pressure_thr = _sf(m.group(2))
            s.gate = m.group(3)
            s.gate_reason = m.group(4) or ""
            s.bid_delta = _sf(m.group(5))
            s.ask_delta = _sf(m.group(6))
        m = _RE_TRADE.search(line)
        if m:
            s.trade_skew = _sf(m.group(1))
        m = _RE_ACTIVE.search(line)
        if m:
            s.yes_active = m.group(1) == "Y●"
            s.no_active = m.group(2) == "N●"
        m = _RE_ALLTIME_LIVE.search(line)
        if m:
            s.pnl_live = _sf(m.group(1))
            s.roi_live = _sf(m.group(2))
            s.max_dd_abs_live = _sf(m.group(3))
            s.max_dd_pct_live = _sf(m.group(4))
            s.pnl_gross_live = _sf(m.group(5))
            f = _sf(m.group(6))
            s.fees_live = -f if f is not None else None
        m = _RE_SESS_LIVE.search(line)
        if m:
            s.sessions_live = int(m.group(1))
            s.yes_fills_live = int(m.group(2))
            s.no_fills_live = int(m.group(3))
            s.cancels_live = int(m.group(4))
            s.skips_live = int(m.group(5))
        m = _RE_GUARD.search(line)
        if m:
            s.guard_yes_blk = int(m.group(1))
            s.guard_no_blk = int(m.group(2))
        m = _RE_INV.search(line)
        if m:
            s.inv_yes = _sf(m.group(1))
            s.inv_no = _sf(m.group(2))
            s.inv_net = _sf(m.group(3))
        m = _RE_AVG.search(line)
        if m:
            s.avg_yes = _sf(m.group(1))
            s.avg_no = _sf(m.group(2))
        m = _RE_MTM.search(line)
        if m:
            s.mtm_pnl = _sf(m.group(1))
            s.session_fees = _sf(m.group(2))
            s.worst_pnl = _sf(m.group(3))
        m = _RE_SZINV.search(line)
        if m:
            s.base_size = _sf(m.group(1))
            s.max_inv = _sf(m.group(2))
        m = _RE_BTC.search(line)
        if m:
            s.btc_open = _sf(m.group(1))
            s.btc_current = _sf(m.group(2))
            s.btc_pct = _sf(m.group(3))
        else:
            m = _RE_BTC_PENDING.search(line)
            if m:
                s.btc_open = None
                s.btc_pct = None
                s.btc_current = _sf(m.group(1))
        return

    if "[PT-RESET]" in line:
        m = _RE_RESET.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            new_id = m.group(2)
            sz = m.group(3)
            mx = m.group(4)
            s.base_size = _sf(sz)
            s.max_inv = _sf(mx)
            # Wipe per-session live counters so the dashboard stays in sync
            s.inv_yes = 0.0
            s.inv_no = 0.0
            s.inv_net = 0.0
            s.avg_yes = 0.0
            s.avg_no = 0.0
            s.mtm_pnl = 0.0
            s.worst_pnl = 0.0
            s.session_fees = 0.0
            s.yes_active = False
            s.no_active = False
            # Per-session BTC open clears; current keeps streaming via STATUS
            s.btc_open = None
            s.btc_pct = None
            s.last_reset = f"{now} {new_id} sz={sz}/inv=±{mx}"
            s.add_event(f"🔄 RESET → {new_id} (size={sz}, inv=±{mx})")
        return

    if "[PT-MODEL]" in line:
        m = _RE_PT_MODEL.search(line)
        if m:
            s.model_session = m.group(1)
            s.model_strike = _sf(m.group(2))
            s.model_time_left_h = _sf(m.group(3))
            s.model_prob_up = _sf(m.group(4))
            s.model_market_prob_up = _sf(m.group(5))
            s.model_edge = _sf(m.group(6))
        return

    if "[PT-MARKET]" in line:
        # Switch line: "[PT-MARKET] #N switched: OLD → NEW yes=… no=… q=…"
        m = _RE_MARKET_SWITCH.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            switch_n = int(m.group(1))
            new_cid = m.group(3)
            question = m.group(4).strip()
            s.market_switches = switch_n
            s.market_cid = new_cid
            s.market_question = question
            s.last_market_switch = f"{now} #{switch_n}"
            s.add_event(f"🔀 MARKET #{switch_n} → {new_cid[:14]}… {question[:60]}")
            return
        # Init/condition lines from connect()
        m = _RE_MARKET_COND.search(line)
        if m:
            s.market_cid = m.group(1)
            return
        m = _RE_MARKET_INIT.search(line)
        if m:
            txt = m.group(1).strip()
            if txt and not txt.startswith("condition=") and "switched:" not in txt:
                # Looks like a market question line on first connect
                if not s.market_question:
                    s.market_question = txt[:120]
        return

    if "[PT-STATS]" in line:
        m = _RE_PT_STATS_EQUITY.search(line)
        if m:
            s.realised_pnl = _sf(m.group(1))     # pnl (all-time, after fees)
            s.gross_pnl_total = _sf(m.group(2))  # gross
            s.fees_total = _sf(m.group(3))
            s.roi_base = _sf(m.group(4))         # roi_base (denominator)
            s.roi_pct = _sf(m.group(5))
            s.sharpe = m.group(6)
            s.max_dd_abs = _sf(m.group(7))
            s.max_dd_pct = _sf(m.group(8))
            s.sessions = int(m.group(9))
            s.wins = int(m.group(10))
            s.losses = int(m.group(11))
            s.push = int(m.group(12))
            s.win_rate = _sf(m.group(13))
            s.avg_session_pnl = _sf(m.group(14))
            s.avg_trade_pnl = _sf(m.group(15))
            s.best_session = _sf(m.group(16))
            s.worst_session = _sf(m.group(17))
            s.fired = int(m.group(18))
            s.total_fills = int(m.group(19))
            s.cancelled = int(m.group(20))
            s.notional = _sf(m.group(21))
            s.hwm = _sf(m.group(22))
        m = _RE_PT_STATS_STARTED.search(line)
        if m:
            s.started_iso = m.group(1)
        return

    if "[PT-FIRE]" in line:
        m = _RE_PT_FIRE.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            side = m.group(1)
            bump_s = m.group(3)   # e.g. "5t" or "5t (REBAL+8t)" — must match trader log
            ask = m.group(4)
            limit = m.group(5)
            sz = m.group(6)
            reason = m.group(7).strip()
            s.orders.appendleft(OrderRow(now, side, "FIRE", f"{ask}→{limit}", sz, f"{bump_s} {reason}"))
            s.fires_total += 1
            s.add_event(f"🔥 FIRE {side} ask={ask}→{limit} {bump_s} ({reason})")
            if side == "YES":
                s.yes_active = True
            else:
                s.no_active = True
        return

    if "[PT-FILL]" in line:
        m = _RE_PT_FILL.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            side = m.group(1)
            sz = m.group(3)
            price = m.group(4)
            slip = m.group(6)
            fee = m.group(7)
            cost = m.group(8)
            latency = m.group(9)
            s.orders.appendleft(OrderRow(now, side, "FILL", price, sz, f"slip{slip}t fee${fee}"))
            s.fills_total += 1
            s.add_event(f"✅ FILL {side} {sz}@{price} fee=${fee} cost=${cost} ({latency}ms)")
            if side == "YES":
                s.yes_active = False
            else:
                s.no_active = False
            # Pull live inventory straight off the fill line
            mi = _RE_PT_FILL_INV.search(line)
            if mi:
                s.inv_yes = _sf(mi.group(1))
                s.inv_no = _sf(mi.group(2))
                s.inv_net = _sf(mi.group(3))
                s.avg_yes = _sf(mi.group(4))
                s.avg_no = _sf(mi.group(5))
        return

    if "[PT-CANCEL]" in line:
        m = _RE_PT_CANCEL.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            side = m.group(1)
            reason = m.group(3)
            elapsed = m.group(4)
            limit = m.group(5)
            s.orders.appendleft(OrderRow(now, side, "CANCEL", limit, "-", f"{reason} {elapsed}ms"))
            s.add_event(f"❌ CANCEL {side} {reason} after {elapsed}ms")
            if side == "YES":
                s.yes_active = False
            else:
                s.no_active = False
        return

    if "[PT-SKIP]" in line:
        m = _RE_PT_SKIP.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            side = m.group(1)
            reason = m.group(2)
            s.orders.appendleft(OrderRow(now, side, "SKIP", "-", "-", reason[:40]))
            s.add_event(f"⏭ SKIP {side} {reason}")
        return

    if "[PT-RESOLVE]" in line:
        m = _RE_PT_RESOLVE.search(line)
        if m:
            now = time.strftime("%H:%M:%S")
            session = m.group(1)
            winner = m.group(2)
            pnl = m.group(8)
            wins = m.group(6)
            losses = m.group(7)
            s.last_resolve = f"{now} {session} {winner} pnl=${pnl}"
            s.add_event(f"📊 RESOLVE {session} → {winner} pnl=${pnl} W{wins}/L{losses}")
        return


# ── Color helpers ───────────────────────────────────────────────────────────
def cpnl(v: Optional[float], fmt: str = "+.2f") -> str:
    if v is None:
        return f"{GRAY}---{RESET}"
    c = GREEN if v >= 0 else RED
    return f"{c}${v:{fmt}}{RESET}"


def cval(v: Optional[float], fmt: str = ".2f", suffix: str = "") -> str:
    if v is None:
        return f"{GRAY}---{RESET}"
    return f"{v:{fmt}}{suffix}"


def cint(v: Optional[int]) -> str:
    if v is None:
        return f"{GRAY}---{RESET}"
    return str(v)


def cside(side: str) -> str:
    return f"{GREEN}{side}{RESET}" if side == "YES" else f"{RED}{side}{RESET}"


def caction(action: str) -> str:
    colors = {
        "FIRE":   YELLOW,
        "FILL":   GREEN,
        "CANCEL": RED,
        "SKIP":   GRAY,
    }
    c = colors.get(action, WHITE)
    return f"{c}{BOLD}{action:<7}{RESET}"


def cgate(gate: str, reason: str) -> str:
    if gate == "BULL":
        return f"{GREEN}{BOLD}▲ BULLISH{RESET} {DIM}({reason}){RESET}" if reason else f"{GREEN}{BOLD}▲ BULLISH{RESET}"
    if gate == "BEAR":
        return f"{RED}{BOLD}▼ BEARISH{RESET} {DIM}({reason}){RESET}" if reason else f"{RED}{BOLD}▼ BEARISH{RESET}"
    return f"{GRAY}— no signal —{RESET}"


def cws(ws: str) -> str:
    parts = ws.split(",")
    out = []
    for p in parts:
        if "✗" in p:
            out.append(f"{RED}{p}{RESET}")
        else:
            out.append(f"{GREEN}{p}{RESET}")
    return ",".join(out)


# ── Render ──────────────────────────────────────────────────────────────────
_BORDER_TOP = f"{BOLD}{CYAN}╔{'═' * (W - 2)}╗{RESET}"
_BORDER_MID = f"{BOLD}{CYAN}╠{'═' * (W - 2)}╣{RESET}"
_BORDER_BOT = f"{BOLD}{CYAN}╚{'═' * (W - 2)}╝{RESET}"
_PIPE = f"{CYAN}║{RESET}"

_prev_lines: List[str] = []


def render(s: DashState, coin: str, rows_avail: int = 60):
    global _prev_lines

    buf = io.StringIO()
    _w = buf.write

    uptime = int(time.time() - s.started_at)
    u_min, u_sec = divmod(uptime, 60)
    u_hr, u_min = divmod(u_min, 60)

    # Header
    _w(f"{_BORDER_TOP}\n")
    title = f"  Daily Paper Trader ({coin.upper()}) — full-taker GTC bump-N + adverse-move guard  "
    right = f"Uptime {u_hr}:{u_min:02d}:{u_sec:02d}  |  Refresh"
    pad = W - 4 - len(title) - len(right)
    _w(f"{_PIPE} {BOLD}{title}{RESET}{' ' * max(pad, 1)}{DIM}{right}{RESET} {_PIPE}\n")
    _w(f"{_BORDER_MID}\n")

    # BTC (or coin) underlying — session candle open vs current
    coin_label = coin.upper()
    if s.btc_open is not None and s.btc_current is not None and s.btc_pct is not None:
        delta = s.btc_current - s.btc_open
        pct_c = GREEN if s.btc_pct >= 0 else RED
        _w(
            f"{_PIPE} {BOLD}{coin_label}{RESET}  "
            f"Open: {BOLD}{s.btc_open:,.2f}{RESET}  \u2192  "
            f"Now: {BOLD}{s.btc_current:,.2f}{RESET}  "
            f"({pct_c}{s.btc_pct:+.3f}%{RESET}  "
            f"{pct_c}{delta:+.2f}{RESET})\n"
        )
    elif s.btc_current is not None:
        _w(
            f"{_PIPE} {BOLD}{coin_label}{RESET}  "
            f"Now: {BOLD}{s.btc_current:,.2f}{RESET}   "
            f"{GRAY}(awaiting candle open…){RESET}\n"
        )
    else:
        _w(f"{_PIPE} {BOLD}{coin_label}{RESET}  {GRAY}---{RESET}\n")

    # Market header — current daily market (rolls at noon ET)
    q = s.market_question or ""
    cid_short = (s.market_cid[:14] + "…") if s.market_cid else "—"
    sw_str = f"{MAGENTA}#{s.market_switches}{RESET}" if s.market_switches > 0 else f"{DIM}#0{RESET}"
    last_sw = f"  last:{DIM}{s.last_market_switch}{RESET}" if s.last_market_switch else ""
    if q:
        # Trim question to fit
        max_q = max(20, W - 40 - len(s.market_cid or ""))
        q_short = q if len(q) <= max_q else q[: max_q - 1] + "…"
        _w(
            f"{_PIPE} {BOLD}{MAGENTA}MARKET{RESET}   "
            f"{q_short}   "
            f"{DIM}cid={cid_short}{RESET}   "
            f"sw {sw_str}{last_sw}\n"
        )
    else:
        _w(
            f"{_PIPE} {BOLD}{MAGENTA}MARKET{RESET}   {GRAY}awaiting market lookup…{RESET}   "
            f"sw {sw_str}{last_sw}\n"
        )

    # Polymarket prices
    if s.poly_mid is not None and s.poly_bid is not None and s.poly_ask is not None:
        spread_c = (s.poly_ask - s.poly_bid) * 100
        _w(
            f"{_PIPE} {BOLD}POLYMARKET{RESET}   "
            f"Mid: {BOLD}{s.poly_mid:.3f}{RESET}   "
            f"Bid: {GREEN}{s.poly_bid:.3f}{RESET}  /  Ask: {RED}{s.poly_ask:.3f}{RESET}   "
            f"Spread: {spread_c:.1f}¢   "
            f"WS: {cws(s.ws)}   "
            f"d:{s.sbe_d}  t:{s.sbe_t}  pm:{s.poly_msgs}\n"
        )
    else:
        _w(f"{_PIPE} {BOLD}POLYMARKET{RESET}   {GRAY}waiting for price feed…{RESET}    WS: {cws(s.ws)}\n")
    _w(f"{_BORDER_MID}\n")

    # Signal panel
    _w(f"{_PIPE} {BOLD}SIGNAL{RESET}\n")

    # Probability model: strike (daily open) / time remaining / P(Up)
    if s.model_strike is not None or s.model_prob_up is not None or s.model_time_left_h is not None:
        if s.model_strike is not None:
            strike_str = f"{BOLD}${s.model_strike:,.2f}{RESET}"
        else:
            strike_str = f"{GRAY}awaiting open…{RESET}"
        tleft_str = (
            f"{BOLD}{s.model_time_left_h:.2f}h{RESET}"
            if s.model_time_left_h is not None else f"{GRAY}--{RESET}"
        )
        if s.model_prob_up is not None:
            pu_c = GREEN if s.model_prob_up >= 0.5 else RED
            pmodel_str = f"{pu_c}{BOLD}{s.model_prob_up * 100:.1f}%{RESET}"
        else:
            pmodel_str = f"{GRAY}--{RESET}"
        pmkt_str = (
            f"{s.model_market_prob_up * 100:.1f}%"
            if s.model_market_prob_up is not None else "--"
        )
        if s.model_edge is not None:
            edge_c = GREEN if s.model_edge >= 0 else RED
            edge_str = f"{edge_c}{s.model_edge * 100:+.1f}%{RESET}"
        else:
            edge_str = f"{GRAY}--{RESET}"
        _w(
            f"{_PIPE}   {CYAN}Model{RESET}  P(Up): {pmodel_str}  "
            f"{DIM}mkt{RESET} {pmkt_str}  {DIM}edge{RESET} {edge_str}   "
            f"{DIM}Strike:{RESET} {strike_str}   "
            f"{DIM}Time left:{RESET} {tleft_str}\n"
        )

    _w(f"{_PIPE}   Gate: {cgate(s.gate, s.gate_reason)}\n")

    # Snapshot
    if s.bid_usd is not None and s.ask_usd is not None and s.skew_pct is not None:
        bar_w = 24
        bid_chars = max(1, min(bar_w - 1, int(s.skew_pct / 100 * bar_w)))
        ask_chars = bar_w - bid_chars
        bar = f"{GREEN}{'█' * bid_chars}{RED}{'█' * ask_chars}{RESET}"
        if s.skew_pct >= 92:
            sk_c = GREEN + BOLD
        elif s.skew_pct <= 8:
            sk_c = RED + BOLD
        elif s.skew_pct >= 70:
            sk_c = GREEN
        elif s.skew_pct <= 30:
            sk_c = RED
        else:
            sk_c = GRAY
        _w(
            f"{_PIPE}   {DIM}Snapshot:{RESET} Bids {GREEN}${s.bid_usd:,.0f}{RESET}  "
            f"[{bar}]  Asks {RED}${s.ask_usd:,.0f}{RESET}  "
            f"Skew: {sk_c}{s.skew_pct:.0f}%{RESET}\n"
        )
    else:
        _w(f"{_PIPE}   {DIM}Snapshot:{RESET}  {GRAY}waiting for bookTicker…{RESET}\n")

    # Net flow
    if s.pressure is not None and s.bid_delta is not None and s.ask_delta is not None:
        thr = s.pressure_thr or 0
        if s.pressure > thr:
            pr_c = GREEN
        elif s.pressure < -thr:
            pr_c = RED
        else:
            pr_c = GRAY
        bd_c = GREEN if s.bid_delta > 0 else RED
        ad_c = RED if s.ask_delta > 0 else GREEN
        _w(
            f"{_PIPE}   {DIM}2s flow:{RESET}  Bids {bd_c}{s.bid_delta:+,.0f}{RESET}  "
            f"Asks {ad_c}{s.ask_delta:+,.0f}{RESET}  "
            f"→ Net: {pr_c}{s.pressure:+,.0f}{RESET}  "
            f"{DIM}thr ±${thr:,.0f}{RESET}\n"
        )
    else:
        _w(f"{_PIPE}   {DIM}2s flow:{RESET}  {GRAY}waiting…{RESET}\n")

    # Trade flow + guard
    if s.trade_skew is not None:
        tf_c = GREEN if s.trade_skew > 0.5 else (RED if s.trade_skew < -0.5 else GRAY)
        tf_str = f"{tf_c}{s.trade_skew:+.2f}{RESET}"
    else:
        tf_str = f"{GRAY}---{RESET}"
    _w(
        f"{_PIPE}   Trade flow: {tf_str}   "
        f"Guard blocks: {YELLOW}Y={s.guard_yes_blk}{RESET}/{YELLOW}N={s.guard_no_blk}{RESET}   "
        f"{DIM}(adverse-move guard rejects signals){RESET}\n"
    )
    _w(f"{_BORDER_MID}\n")

    # ── WORKERS & INVENTORY & PnL ─────────────────────────────────────
    y_state = f"{YELLOW}🟡 IN-FLIGHT{RESET}" if s.yes_active else f"{GRAY}⚪ idle{RESET}"
    n_state = f"{YELLOW}🟡 IN-FLIGHT{RESET}" if s.no_active else f"{GRAY}⚪ idle{RESET}"
    inv_y = f"{s.inv_yes:.0f}" if s.inv_yes is not None else "0"
    inv_n = f"{s.inv_no:.0f}" if s.inv_no is not None else "0"
    if s.inv_net is not None:
        net_c = GREEN if s.inv_net >= 0 else RED
        net_str = f"{net_c}{s.inv_net:+.0f}{RESET}"
    else:
        net_str = f"{GRAY}---{RESET}"
    avg_y = f"${s.avg_yes:.4f}" if s.avg_yes else "---"
    avg_n = f"${s.avg_no:.4f}" if s.avg_no else "---"
    avg_sum_str = ""
    if s.avg_yes and s.avg_no and s.avg_yes > 0 and s.avg_no > 0:
        ssum = s.avg_yes + s.avg_no
        sc = GREEN if ssum < 1.0 else RED
        avg_sum_str = f"  Sum: {sc}${ssum:.4f}{RESET}"
    pairs = min(s.inv_yes or 0, s.inv_no or 0)

    sz_str = f"{s.base_size:.0f}" if s.base_size is not None else "---"
    mx_str = f"±{s.max_inv:.0f}" if s.max_inv is not None else "±---"
    # Highlight when net is at risk: ≥60% → red, ≥30% → yellow
    net_pct = 0.0
    if s.inv_net is not None and s.max_inv and s.max_inv > 0:
        net_pct = abs(s.inv_net) / s.max_inv * 100.0
    if net_pct >= 60:
        size_c = RED
    elif net_pct >= 30:
        size_c = YELLOW
    else:
        size_c = GREEN
    pct_str = f"{size_c}{net_pct:.0f}%{RESET}"

    _w(f"{_PIPE} {BOLD}WORKERS · INVENTORY · PnL{RESET}\n")
    _w(
        f"{_PIPE}   YES Worker: {y_state}    NO Worker: {n_state}    "
        f"{BOLD}Sz:{RESET}{sz_str}/{BOLD}Inv:{RESET}{mx_str}    "
        f"Sessions: {BOLD}{s.sessions_live}{RESET}    "
        f"Skip: {DIM}{s.skips_live}{RESET}    "
        f"Cxl: {RED}{s.cancels_live}{RESET}\n"
    )
    _w(
        f"{_PIPE}   Inv: {GREEN}{inv_y}Y{RESET} / {RED}{inv_n}N{RESET}    "
        f"Net: {net_str} ({pct_str} of max)    "
        f"Pairs: {CYAN}{pairs:.0f}{RESET}    "
        f"Avg: Y={avg_y} N={avg_n}{avg_sum_str}\n"
    )
    fees_str = (
        f"{RED}-${abs(s.fees_live):.2f}{RESET}" if s.fees_live is not None else f"{GRAY}---{RESET}"
    )
    # Current daily session — MTM + fees paid on this session's fills
    sess_fees_str = (
        f"{RED}-${abs(s.session_fees):.2f}{RESET}"
        if s.session_fees is not None else f"{GRAY}---{RESET}"
    )
    _w(
        f"{_PIPE}   {BOLD}Session:{RESET} "
        f"MTM {cpnl(s.mtm_pnl)}   "
        f"{BOLD}Fees{RESET} {sess_fees_str}   "
        f"Worst {cpnl(s.worst_pnl)}    "
        f"Live fills: {GREEN}Y{s.yes_fills_live}{RESET}/{RED}N{s.no_fills_live}{RESET}"
        f"   {DIM}(rolls into all-time at session resolve){RESET}\n"
    )
    # All-time = pure sum of resolved sessions (no equity, no open MTM)
    roi_live_str = (
        f"{GREEN if (s.roi_live or 0) >= 0 else RED}{s.roi_live:+.2f}%{RESET}"
        if s.roi_live is not None else f"{GRAY}---{RESET}"
    )
    dd_live_str = (
        f"{RED}-${s.max_dd_abs_live:.2f} ({s.max_dd_pct_live:.2f}%){RESET}"
        if s.max_dd_abs_live is not None else f"{GRAY}---{RESET}"
    )
    _w(
        f"{_PIPE}   {BOLD}{MAGENTA}All-time:{RESET} "
        f"{BOLD}PnL{RESET} {cpnl(s.pnl_live)}   "
        f"{BOLD}ROI{RESET} {roi_live_str}   "
        f"{BOLD}MaxDD{RESET} {dd_live_str}   "
        f"{BOLD}Fees{RESET} {fees_str}   "
        f"{DIM}gross {cpnl(s.pnl_gross_live)}{RESET}\n"
    )
    _w(f"{_BORDER_MID}\n")

    # ALL-TIME STATS — pure sum of resolved sessions (NO equity / NO bankroll)
    sub = (
        f"  {DIM}vs ${s.roi_base:,.0f} initial  ·  "
        f"in-memory unless --persist-stats{RESET}"
        if s.roi_base is not None
        else f"  {DIM}in-memory unless --persist-stats{RESET}"
    )
    _w(
        f"{_PIPE} {BOLD}{MAGENTA}ALL-TIME STATS{RESET}{sub}\n"
    )
    if s.realised_pnl is not None:
        roi_c = GREEN if (s.roi_pct or 0) >= 0 else RED
        roi_str = f"{roi_c}{s.roi_pct:+.2f}%{RESET}" if s.roi_pct is not None else f"{GRAY}---{RESET}"
        sharpe_str = s.sharpe or "---"
        if sharpe_str not in ("---", "0.00", "+0.00", "inf"):
            try:
                sf = float(sharpe_str)
                sh_c = GREEN if sf >= 1.0 else (YELLOW if sf >= 0.5 else (GRAY if sf >= 0 else RED))
                sharpe_str = f"{sh_c}{sf:+.2f}{RESET}"
            except ValueError:
                pass
        elif sharpe_str == "inf":
            sharpe_str = f"{GREEN}\u221e{RESET}"
        elif sharpe_str in ("0.00", "+0.00"):
            sharpe_str = f"{GRAY}{sharpe_str}{RESET}"

        wr_c = GREEN if (s.win_rate or 0) >= 50 else RED
        wr_str = f"{wr_c}{s.win_rate:.1f}%{RESET}" if s.win_rate is not None else f"{GRAY}---{RESET}"

        dd_str = (
            f"{RED}-${s.max_dd_abs:.2f} ({s.max_dd_pct:.2f}%){RESET}"
            if s.max_dd_abs is not None else f"{GRAY}---{RESET}"
        )
        fees_t_str = (
            f"{RED}-${s.fees_total:.2f}{RESET}" if s.fees_total is not None else f"{GRAY}---{RESET}"
        )

        _w(
            f"{_PIPE}   {BOLD}PnL:{RESET} {cpnl(s.realised_pnl)}    "
            f"{BOLD}ROI:{RESET} {roi_str}    "
            f"{BOLD}MaxDD:{RESET} {dd_str}    "
            f"{BOLD}Sharpe:{RESET} {sharpe_str}    "
            f"{BOLD}Fees:{RESET} {fees_t_str}    "
            f"{DIM}gross {cpnl(s.gross_pnl_total)}{RESET}\n"
        )
        _w(
            f"{_PIPE}   {BOLD}Sessions:{RESET} {s.sessions}   "
            f"W/L/P: {GREEN}{s.wins}{RESET}/{RED}{s.losses}{RESET}/{GRAY}{s.push}{RESET}   "
            f"WinRate: {wr_str}   "
            f"AvgSess: {cpnl(s.avg_session_pnl, '+.3f')}   "
            f"AvgTrade: {cpnl(s.avg_trade_pnl, '+.3f')}\n"
        )
        _w(
            f"{_PIPE}   {BOLD}Best:{RESET} {cpnl(s.best_session)}   "
            f"{BOLD}Worst:{RESET} {cpnl(s.worst_session)}   "
            f"{BOLD}HWM:{RESET} {cpnl(s.hwm)}   "
            f"Fired:{s.fired}   Filled:{s.total_fills}   "
            f"Cancelled:{s.cancelled}   "
            f"Notional:${s.notional:,.0f}\n"
        )
        if s.started_iso:
            _w(f"{_PIPE}   {DIM}Tracking since: {s.started_iso}{RESET}\n")
    else:
        _w(f"{_PIPE}   {GRAY}waiting for first [PT-STATS] line (every 15s)…{RESET}\n")
    _w(f"{_BORDER_MID}\n")

    # ── Recent orders — YES (left) / NO (right) two-column layout ───
    _max_rows = max(10, rows_avail - 30)
    _ord_rows = max(8, _max_rows * 2 // 3)
    _evt_rows = max(4, _max_rows - _ord_rows)

    yes_orders = [o for o in s.orders if o.side == "YES"][:_ord_rows]
    no_orders = [o for o in s.orders if o.side == "NO"][:_ord_rows]

    yes_price_str = f"{GREEN}{s.poly_bid:.3f}{RESET}" if s.poly_bid is not None else f"{DIM}---{RESET}"
    no_price_val = (1.0 - s.poly_ask) if s.poly_ask is not None else None
    no_price_str = f"{RED}{no_price_val:.3f}{RESET}" if no_price_val is not None else f"{DIM}---{RESET}"
    spread_str = ""
    if s.poly_bid is not None and s.poly_ask is not None:
        sp = (s.poly_ask - s.poly_bid) * 100
        spread_str = f"  {DIM}spread {sp:.1f}¢{RESET}"

    _w(
        f"{_PIPE} {BOLD}RECENT ORDERS{RESET}  "
        f"{DIM}(fires={s.fires_total}  fills={s.fills_total}){RESET}{spread_str}\n"
    )
    _w(
        f"{_PIPE}   {GREEN}{BOLD}YES{RESET} @ {yes_price_str}"
        f"                                    "
        f"{RED}{BOLD}NO{RESET}  @ {no_price_str}\n"
    )
    hdr = f"{'TIME':<9} {'ACTION':<7} {'PRICE':<11} {'SIZE':<5}  {'INFO':<14}"
    _w(
        f"{_PIPE}   {GREEN}{BOLD}YES{RESET}  {DIM}{hdr}{RESET}"
        f"   {RED}{BOLD}NO{RESET}   {DIM}{hdr}{RESET}\n"
    )

    max_rows = max(len(yes_orders), len(no_orders), 1)
    blank = f"{DIM}{'':<9} {'':<7} {'':<11} {'':<5}  {'':<14}{RESET}"
    for i in range(min(max_rows, _ord_rows)):
        if i < len(yes_orders):
            y = yes_orders[i]
            left = (
                f"{y.ts:<9} {caction(y.action)} "
                f"{y.price:<11} {y.size:<5}  {DIM}{y.extra[:14]:<14}{RESET}"
            )
        else:
            left = blank

        if i < len(no_orders):
            n = no_orders[i]
            right = (
                f"{n.ts:<9} {caction(n.action)} "
                f"{n.price:<11} {n.size:<5}  {DIM}{n.extra[:14]:<14}{RESET}"
            )
        else:
            right = blank

        _w(f"{_PIPE}        {left}        {right}\n")
    _w(f"{_BORDER_MID}\n")

    _w(f"{_PIPE} {BOLD}EVENTS{RESET}\n")
    if not s.events:
        _w(f"{_PIPE}   {DIM}no events yet{RESET}\n")
    else:
        for msg, count in list(s.events)[:_evt_rows]:
            suffix = f" {DIM}×{count}{RESET}" if count > 1 else ""
            max_len = W - 6 - (len(f" ×{count}") if count > 1 else 0)
            disp = msg[:max_len]
            _w(f"{_PIPE}   {disp}{suffix}\n")

    if s.last_resolve:
        _w(f"{_PIPE}   {CYAN}Last resolve: {s.last_resolve}{RESET}\n")
    _w(f"{_BORDER_BOT}\n")

    # ── Diff render ─────────────────────────────────────────────────────
    new_lines = buf.getvalue().split("\n")
    if new_lines and new_lines[-1] == "":
        new_lines.pop()
    out = []
    for i, line in enumerate(new_lines):
        if i < len(_prev_lines) and _prev_lines[i] == line:
            continue
        out.append(f"\033[{i + 1};1H{line}{CSI_CLEAR_EOL}")
    if len(new_lines) < len(_prev_lines):
        for i in range(len(new_lines), len(_prev_lines)):
            out.append(f"\033[{i + 1};1H{CSI_CLEAR_EOL}")
    _prev_lines = new_lines
    if out:
        sys.stdout.write("".join(out))
        sys.stdout.flush()


# ── Subprocess plumbing ─────────────────────────────────────────────────────
def _reader(proc: subprocess.Popen, q: "queue.Queue[str]"):
    assert proc.stdout is not None
    for raw in proc.stdout:
        q.put(raw)
    q.put("__EOF__")


def _enable_win_vt():
    if os.name != "nt":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        h = kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        kernel32.GetConsoleMode(h, ctypes.byref(mode))
        kernel32.SetConsoleMode(h, mode.value | 0x0004)
    except Exception:
        pass


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(
        description="Daily Paper Trader TUI"
    )
    p.add_argument("--coin", type=str, default="btc",
                   choices=["btc", "eth", "sol", "xrp"])
    p.add_argument("--size", type=float, default=None,
                   help="Forwarded to paper trader (--size). Default = per-coin like live MM.")
    p.add_argument("--max-inv", type=float, default=None,
                   help="Forwarded to paper trader (--max-inv).")
    p.add_argument("--test", action="store_true",
                   help="Forward --test to trader (size=15, max_inv=80)")
    p.add_argument("--live", action="store_true",
                   help="Forward --live to trader (size=30, max_inv=160)")
    p.add_argument("--default", dest="default_size", action="store_true",
                   help="Forward --default to trader (size=30, max_inv=150)")
    p.add_argument("--bankroll", type=float, default=None,
                   help="Forwarded to paper trader (--bankroll)")
    p.add_argument("--bump", type=int, default=None,
                   help="Forwarded to paper trader (--bump)")
    p.add_argument("--latency-ms", type=int, default=None,
                   help="Forwarded to paper trader (--latency-ms)")
    p.add_argument("--cancel-timeout", type=float, default=None,
                   help="Forwarded to paper trader (--cancel-timeout)")
    p.add_argument("--cancel-ask-drift-ticks", type=int, default=None,
                   help="Forwarded to paper trader (--cancel-ask-drift-ticks)")
    p.add_argument("--fill-cooldown", type=float, default=None,
                   help="Forwarded to paper trader (--fill-cooldown)")
    p.add_argument("--guard-window-ms", type=int, default=None,
                   help="Forwarded to paper trader (--guard-window-ms)")
    p.add_argument("--pressure-window", type=float, default=None)
    p.add_argument("--pressure-threshold", type=float, default=None)
    p.add_argument("--skew-flow", type=float, default=None)
    p.add_argument("--skew-alone", type=float, default=None)
    p.add_argument("--skew-place", type=float, default=None)
    p.add_argument("--persistence", type=int, default=None)
    p.add_argument("--trade-bull", type=float, default=None)
    p.add_argument("--trade-bear", type=float, default=None)
    p.add_argument("--loose", action="store_true",
                   help="Drop trade-flow confirmation requirement")
    p.add_argument("--reset-stats", action="store_true",
                   help="Forwarded: delete stats JSON before start (with trader --persist-stats)")
    p.add_argument("--persist-stats", action="store_true",
                   help="Forwarded: load/save all-time stats to disk")
    p.add_argument("--refresh-ms", type=int, default=400,
                   help="Dashboard refresh interval in ms (default: 400)")
    args = p.parse_args()

    script = Path(__file__).with_name("daily_paper_trader.py")
    cmd: List[str] = [sys.executable, "-u", str(script), "--coin", args.coin]
    for flag, val in [
        ("--size", args.size),
        ("--max-inv", args.max_inv),
        ("--bankroll", args.bankroll),
        ("--bump", args.bump),
        ("--latency-ms", args.latency_ms),
        ("--cancel-timeout", args.cancel_timeout),
        ("--cancel-ask-drift-ticks", args.cancel_ask_drift_ticks),
        ("--fill-cooldown", args.fill_cooldown),
        ("--guard-window-ms", args.guard_window_ms),
        ("--pressure-window", args.pressure_window),
        ("--pressure-threshold", args.pressure_threshold),
        ("--skew-flow", args.skew_flow),
        ("--skew-alone", args.skew_alone),
        ("--skew-place", args.skew_place),
        ("--persistence", args.persistence),
        ("--trade-bull", args.trade_bull),
        ("--trade-bear", args.trade_bear),
    ]:
        if val is not None:
            cmd.extend([flag, str(val)])
    if args.test:
        cmd.append("--test")
    if args.live:
        cmd.append("--live")
    if args.default_size:
        cmd.append("--default")
    if args.loose:
        cmd.append("--loose")
    if args.persist_stats:
        cmd.append("--persist-stats")
    if args.reset_stats:
        cmd.append("--reset-stats")

    _enable_win_vt()
    sys.stdout.write(CSI_HIDE_CUR)
    sys.stdout.flush()
    os.system("cls" if os.name == "nt" else "clear")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    q: "queue.Queue[str]" = queue.Queue()
    threading.Thread(target=_reader, args=(proc, q), daemon=True).start()

    state = DashState()
    refresh = max(0.05, args.refresh_ms / 1000.0)
    prev_cols, prev_rows = shutil.get_terminal_size((W, 50))

    try:
        while True:
            dirty = False
            while True:
                try:
                    raw = q.get_nowait()
                except queue.Empty:
                    break
                if raw == "__EOF__":
                    dirty = True
                    break
                parse_line(state, raw)
                dirty = True

            cols, rows = shutil.get_terminal_size((W, 50))
            if cols != prev_cols or rows != prev_rows:
                prev_cols, prev_rows = cols, rows
                _prev_lines.clear()
                sys.stdout.write("\033[2J" + CSI_HOME)
                sys.stdout.flush()
                dirty = True

            if dirty:
                render(state, args.coin, rows_avail=rows)

            rc = proc.poll()
            if rc is not None:
                while True:
                    try:
                        raw = q.get_nowait()
                    except queue.Empty:
                        break
                    if raw == "__EOF__":
                        break
                    parse_line(state, raw)
                render(state, args.coin, rows_avail=rows)
                sys.stdout.write(f"\n{BOLD}{RED}Paper trader exited with code {rc}{RESET}\n")
                sys.stdout.flush()
                break
            time.sleep(refresh)
    except KeyboardInterrupt:
        sys.stdout.write(f"\n{YELLOW}Stopping…{RESET}\n")
        sys.stdout.flush()
    finally:
        sys.stdout.write(CSI_SHOW_CUR)
        sys.stdout.flush()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


if __name__ == "__main__":
    main()
