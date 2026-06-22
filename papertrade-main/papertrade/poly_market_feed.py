"""
Polymarket Market Feed — dual WS + REST polling for fastest data.

Runs TWO WebSocket connections to the same market plus an async REST poller
that hits /book every 50ms. All three sources race to update MarketState,
so bots always get the freshest bid/ask available.

Usage:
    from poly_market_feed import PolyMarketFeed

    feed = PolyMarketFeed(yes_token_id, no_token_id)
    feed.on_update = my_callback  # optional: called on every bid/ask change
    tasks = feed.create_tasks()   # returns list of asyncio tasks to gather

    # Read state anytime:
    feed.state.yes_bid   # Decimal
    feed.state.yes_ask   # Decimal
    feed.state.no_bid    # complement of YES ask, or None if YES is pinned at a tick edge
    feed.state.no_ask    # complement of YES bid, or None if YES is pinned at a tick edge
    feed.connected       # True if at least one WS is connected
    feed.stats           # FeedStats with race/freshness data
"""

import asyncio
import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable, List, Optional

try:
    import aiohttp
except ImportError:
    aiohttp = None

try:
    import websockets
except ImportError:
    websockets = None

try:
    from orjson import loads as json_loads
except ImportError:
    json_loads = json.loads

json_dumps = json.dumps

logger = logging.getLogger("poly_market_feed")

MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
CLOB_REST_URL = "https://clob.polymarket.com"
APP_PING_INTERVAL_SEC = 10.0

PRICE_MIN = Decimal("0.01")
PRICE_MAX = Decimal("0.99")

# After a WS reconnects, ignore price updates for this long to let the socket
# "catch up" — the first book snapshot after reconnect is often stale.
WS_RECONNECT_GRACE_MS = 500


def _safe_decimal(val) -> Optional[Decimal]:
    """Convert to Decimal, reject invalid prices outside [0.01, 0.99]."""
    if not val or val == "0":
        return None
    try:
        d = Decimal(str(val))
        if d < PRICE_MIN or d > PRICE_MAX:
            return None
        return d
    except Exception:
        return None


@dataclass
class FeedStats:
    """Race and freshness statistics."""
    ws_a_msgs: int = 0
    ws_b_msgs: int = 0
    rest_polls: int = 0
    rest_new: int = 0
    rest_same: int = 0
    rest_errors: int = 0
    rest_latency_ms: List[float] = field(default_factory=list)

    # Who saw each price change first
    a_first: int = 0
    b_first: int = 0
    rest_first: int = 0  # REST delivered value before either WS
    tie: int = 0
    a_lead_ms: List[float] = field(default_factory=list)
    b_lead_ms: List[float] = field(default_factory=list)
    rest_lead_ms: List[float] = field(default_factory=list)

    # Pending race entries
    _pending: dict = field(default_factory=dict)

    last_update_time: float = 0.0
    bid_changes: int = 0
    ask_changes: int = 0

    def _record_race(self, source: str, price_key: str):
        """Record which source saw a price first."""
        now = time.time()
        if price_key in self._pending:
            first_source, first_time = self._pending.pop(price_key)
            delta_ms = (now - first_time) * 1000
            if delta_ms <= 5.0:
                self.tie += 1
            elif first_source == "A":
                self.a_first += 1
                self.a_lead_ms.append(delta_ms)
                if len(self.a_lead_ms) > 2000:
                    self.a_lead_ms = self.a_lead_ms[-1000:]
            elif first_source == "B":
                self.b_first += 1
                self.b_lead_ms.append(delta_ms)
                if len(self.b_lead_ms) > 2000:
                    self.b_lead_ms = self.b_lead_ms[-1000:]
            elif first_source == "REST":
                self.rest_first += 1
                self.rest_lead_ms.append(delta_ms)
                if len(self.rest_lead_ms) > 2000:
                    self.rest_lead_ms = self.rest_lead_ms[-1000:]
        else:
            self._pending[price_key] = (source, now)
            # Evict stale entries
            if len(self._pending) > 200:
                cutoff = now - 10
                self._pending = {k: v for k, v in self._pending.items() if v[1] > cutoff}

    @property
    def total_races(self) -> int:
        return self.a_first + self.b_first + self.rest_first + self.tie


class PolyMarketFeed:
    """Dual WS + REST feed for Polymarket market data.

    Manages two independent WebSocket connections and an async REST poller
    that all race to update the same MarketState object. Bots just read
    from `feed.state` to get the freshest bid/ask.
    """

    def __init__(
        self,
        yes_token_id: str,
        no_token_id: str,
        rest_interval_ms: int = 50,
        enable_rest: bool = True,
        enable_dual_ws: bool = True,
    ):
        self.yes_token_id = yes_token_id
        self.no_token_id = no_token_id
        self.rest_interval_ms = rest_interval_ms
        self.enable_rest = enable_rest and aiohttp is not None
        self.enable_dual_ws = enable_dual_ws

        # Shared state — bots read from here
        self._yes_bid: Optional[Decimal] = None
        self._yes_ask: Optional[Decimal] = None
        self._yes_bid_size: Decimal = Decimal("0")
        self._yes_ask_size: Decimal = Decimal("0")

        # Connection status
        self._ws_a_connected = False
        self._ws_b_connected = False
        self.running = True

        self.stats = FeedStats()
        self.on_update: Optional[Callable] = None
        self.on_raw_book: Optional[Callable] = None  # callback(all_bids, all_asks) for depth signals
        # Optional: every WS frame after parse, before TOB race (items, recv_wall_ms, source).
        self.on_ws_items: Optional[Callable[[list, float, str], None]] = None

        # Reconnect grace: per-WS connect timestamp to ignore stale snapshots
        self._ws_a_connect_time: float = 0.0
        self._ws_b_connect_time: float = 0.0
        self._ws_a_in_grace: bool = False
        self._ws_b_in_grace: bool = False
        self.grace_msgs_skipped: int = 0

        # Optional: enqueue raw WS frames; parse thread runs json/TOB off asyncio loop.
        self.offload_ws_parse: bool = False
        self._state_lock = threading.Lock()
        self._parse_queue: queue.Queue = queue.Queue(maxsize=8192)
        self._parse_thread: Optional[threading.Thread] = None
        self._parse_thread_stop = threading.Event()

    @property
    def yes_bid(self) -> Optional[Decimal]:
        with self._state_lock:
            return self._yes_bid

    @property
    def yes_ask(self) -> Optional[Decimal]:
        with self._state_lock:
            return self._yes_ask

    @property
    def yes_bid_size(self) -> Decimal:
        with self._state_lock:
            return self._yes_bid_size

    @property
    def yes_ask_size(self) -> Decimal:
        with self._state_lock:
            return self._yes_ask_size

    @property
    def no_bid(self) -> Optional[Decimal]:
        # Complement of YES ask; only meaningful when YES ask is off the tick
        # ceiling/floor (otherwise implied NO is dust or degenerate).
        with self._state_lock:
            yes_ask = self._yes_ask
        if yes_ask is None:
            return None
        if yes_ask <= PRICE_MIN or yes_ask >= PRICE_MAX:
            return None
        return Decimal("1") - yes_ask

    @property
    def no_ask(self) -> Optional[Decimal]:
        # Complement of YES bid — same rule: YES at 0.99 ⇒ no residual NO "ask" to lift.
        with self._state_lock:
            yes_bid = self._yes_bid
        if yes_bid is None:
            return None
        if yes_bid <= PRICE_MIN or yes_bid >= PRICE_MAX:
            return None
        return Decimal("1") - yes_bid

    @property
    def yes_mid(self) -> Optional[Decimal]:
        if self._yes_bid and self._yes_ask:
            return (self._yes_bid + self._yes_ask) / 2
        return None

    @property
    def connected(self) -> bool:
        return self._ws_a_connected or self._ws_b_connected

    def _apply_update(self, new_bid: Optional[Decimal], new_ask: Optional[Decimal],
                      bid_size: Optional[Decimal], ask_size: Optional[Decimal],
                      source: str) -> bool:
        """Apply a bid/ask update from any source. Returns True if anything changed."""
        changed = False
        on_update_cb = None

        with self._state_lock:
            if new_bid is not None and new_bid != self._yes_bid:
                self._yes_bid = new_bid
                self.stats.bid_changes += 1
                changed = True
            if new_ask is not None and new_ask != self._yes_ask:
                self._yes_ask = new_ask
                self.stats.ask_changes += 1
                changed = True
            if bid_size is not None and bid_size != self._yes_bid_size:
                self._yes_bid_size = bid_size
                changed = True
            if ask_size is not None and ask_size != self._yes_ask_size:
                self._yes_ask_size = ask_size
                changed = True

            if changed:
                self.stats.last_update_time = time.time()
                price_key = f"{self._yes_bid}/{self._yes_ask}"
                self.stats._record_race(source, price_key)
                on_update_cb = self.on_update

        if on_update_cb:
            try:
                on_update_cb()
            except Exception:
                pass
        return changed

    def _process_ws_payload(
        self, data, name: str, is_primary: bool, recv_wall_ms: float
    ) -> None:
        items = self.ws_items_from_payload(data)
        if items and self.on_ws_items:
            try:
                self.on_ws_items(items, recv_wall_ms, name)
            except Exception:
                pass
        new_bid, new_ask, bid_size, ask_size, raw_bids, raw_asks = (
            self._parse_ws_message(data)
        )
        if new_bid is not None or new_ask is not None:
            if is_primary:
                self.stats.ws_a_msgs += 1
            else:
                self.stats.ws_b_msgs += 1
            self._apply_update(new_bid, new_ask, bid_size, ask_size, name)
        if raw_bids is not None and self.on_raw_book:
            try:
                self.on_raw_book(raw_bids, raw_asks)
            except Exception:
                pass

    def _parse_thread_main(self) -> None:
        while not self._parse_thread_stop.is_set():
            try:
                item = self._parse_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            if item is None:
                break
            message, name, is_primary, recv_wall_ms = item
            try:
                data = json_loads(message)
                self._process_ws_payload(data, name, is_primary, recv_wall_ms)
            except Exception:
                pass

    def start_parse_thread(self) -> None:
        if self._parse_thread is not None and self._parse_thread.is_alive():
            return
        self._parse_thread_stop.clear()
        self._parse_thread = threading.Thread(
            target=self._parse_thread_main,
            name="poly-feed-parse",
            daemon=True,
        )
        self._parse_thread.start()
        logger.info("[MKT-FEED] WS parse offload thread started")

    def _stop_parse_thread(self) -> None:
        if self._parse_thread is None:
            return
        self._parse_thread_stop.set()
        try:
            self._parse_queue.put_nowait(None)
        except queue.Full:
            pass
        self._parse_thread.join(timeout=2.0)
        self._parse_thread = None
        while True:
            try:
                self._parse_queue.get_nowait()
            except queue.Empty:
                break

    @staticmethod
    def ws_items_from_payload(data) -> list:
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            return [data]
        return []

    def _parse_ws_message(self, data) -> tuple:
        """Parse a WS message, return (new_bid, new_ask, bid_size, ask_size, raw_bids, raw_asks).
        All price values are Decimal or None. raw_bids/raw_asks are sorted (price, size)
        lists from book events (None otherwise) — used by on_raw_book callback."""
        if isinstance(data, list):
            for item in data:
                result = self._parse_ws_message(item)
                if result[0] is not None or result[1] is not None:
                    return result
            return (None, None, None, None, None, None)

        event_type = data.get("event_type", "")
        asset_id = data.get("asset_id", "")

        if event_type not in ("best_bid_ask", "book", "price_change"):
            return (None, None, None, None, None, None)

        new_bid = None
        new_ask = None
        bid_size = None
        ask_size = None
        raw_bids = None
        raw_asks = None

        if event_type == "best_bid_ask":
            if asset_id == self.yes_token_id:
                new_bid = _safe_decimal(data.get("best_bid"))
                new_ask = _safe_decimal(data.get("best_ask"))

        elif event_type == "book":
            if asset_id == self.yes_token_id:
                bids = data.get("bids", [])
                asks = data.get("asks", [])
                try:
                    all_bids = [
                        (Decimal(str(b["price"])), Decimal(str(b["size"])))
                        for b in bids if b.get("price") and b.get("size")
                    ]
                    all_asks = [
                        (Decimal(str(a["price"])), Decimal(str(a["size"])))
                        for a in asks if a.get("price") and a.get("size")
                    ]
                    if all_bids:
                        all_bids.sort(key=lambda x: x[0], reverse=True)
                        best = all_bids[0]
                        new_bid = _safe_decimal(best[0])
                        bid_size = best[1]
                    if all_asks:
                        all_asks.sort(key=lambda x: x[0])
                        best = all_asks[0]
                        new_ask = _safe_decimal(best[0])
                        ask_size = best[1]
                    raw_bids = all_bids
                    raw_asks = all_asks
                except Exception:
                    pass

        elif event_type == "price_change":
            for change in data.get("price_changes", []):
                if change.get("asset_id") == self.yes_token_id:
                    new_bid = _safe_decimal(change.get("best_bid"))
                    new_ask = _safe_decimal(change.get("best_ask"))
                    break

        return (new_bid, new_ask, bid_size, ask_size, raw_bids, raw_asks)

    async def _ws_app_ping(self, ws) -> None:
        """Polymarket market/user WS expects client text PING every ~10s."""
        try:
            while self.running:
                await ws.send("PING")
                await asyncio.sleep(APP_PING_INTERVAL_SEC)
        except asyncio.CancelledError:
            return
        except Exception:
            return

    @staticmethod
    def _ws_text_frame(message) -> Optional[str]:
        if isinstance(message, (bytes, bytearray)):
            try:
                message = message.decode("utf-8", "ignore")
            except Exception:
                return None
        return message if isinstance(message, str) else None

    async def _ws_listener(self, name: str, is_primary: bool):
        """Single WS listener. name is 'A' or 'B'."""
        reconnect_delay = 1.0
        tag = f"[MKT-WS-{name}]"
        grace_sec = WS_RECONNECT_GRACE_MS / 1000.0

        while self.running:
            ping_task: Optional[asyncio.Task] = None
            try:
                async with websockets.connect(
                    MARKET_WS_URL,
                    ping_interval=None,
                    ping_timeout=None,
                    close_timeout=1.0,  # Fast cancel for session rollover
                    compression=None,
                ) as ws:
                    connect_time = time.time()
                    if is_primary:
                        self._ws_a_connected = True
                        self._ws_a_connect_time = connect_time
                        self._ws_a_in_grace = True
                    else:
                        self._ws_b_connected = True
                        self._ws_b_connect_time = connect_time
                        self._ws_b_in_grace = True
                    reconnect_delay = 1.0
                    logger.info(f"{tag} Connected (grace {WS_RECONNECT_GRACE_MS}ms)")

                    subscribe_msg = {
                        "type": "market",
                        "assets_ids": [self.yes_token_id, self.no_token_id],
                        "custom_feature_enabled": True,
                    }
                    await ws.send(json_dumps(subscribe_msg))
                    ping_task = asyncio.create_task(self._ws_app_ping(ws))

                    async for message in ws:
                        if not self.running:
                            break

                        text = self._ws_text_frame(message)
                        if not text or text in ("PING", "PONG"):
                            continue
                        if text[0] not in "{[":
                            continue

                        now = time.time()

                        # Reconnect grace: skip price updates for WS_RECONNECT_GRACE_MS
                        # after connect to avoid stale initial snapshots overwriting fresh data.
                        in_grace = (self._ws_a_in_grace if is_primary else self._ws_b_in_grace)
                        if in_grace:
                            ct = (self._ws_a_connect_time if is_primary else self._ws_b_connect_time)
                            if (now - ct) >= grace_sec:
                                if is_primary:
                                    self._ws_a_in_grace = False
                                else:
                                    self._ws_b_in_grace = False
                                logger.debug(f"{tag} Grace period ended")
                            else:
                                self.grace_msgs_skipped += 1
                                continue

                        recv_wall_ms = time.time() * 1000.0
                        if self.offload_ws_parse:
                            try:
                                self._parse_queue.put_nowait(
                                    (text, name, is_primary, recv_wall_ms)
                                )
                            except queue.Full:
                                pass
                            continue
                        try:
                            data = json_loads(text)
                            self._process_ws_payload(
                                data, name, is_primary, recv_wall_ms
                            )
                            await asyncio.sleep(0)
                        except Exception:
                            pass

            except asyncio.CancelledError:
                break
            except Exception as e:
                if is_primary:
                    self._ws_a_connected = False
                else:
                    self._ws_b_connected = False
                logger.warning(f"{tag} Disconnected: {e}")
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 30.0)
            finally:
                if ping_task is not None:
                    ping_task.cancel()
                    await asyncio.gather(ping_task, return_exceptions=True)

        if is_primary:
            self._ws_a_connected = False
        else:
            self._ws_b_connected = False

    async def _rest_poller(self):
        """Poll /book at fixed interval for supplementary freshness."""
        if not aiohttp:
            return
        interval_sec = self.rest_interval_ms / 1000.0

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5),
            headers={"Accept": "application/json"},
        ) as session:
            while self.running:
                url = f"{CLOB_REST_URL}/book?token_id={self.yes_token_id}"
                t0 = time.time()
                try:
                    async with session.get(url) as resp:
                        if resp.status != 200:
                            self.stats.rest_errors += 1
                            continue
                        data = await resp.json(loads=json_loads)
                    latency = (time.time() - t0) * 1000
                    self.stats.rest_polls += 1
                    self.stats.rest_latency_ms.append(latency)
                    if len(self.stats.rest_latency_ms) > 2000:
                        self.stats.rest_latency_ms = self.stats.rest_latency_ms[-1000:]

                    bids = data.get("bids", [])
                    asks = data.get("asks", [])
                    new_bid = None
                    new_ask = None
                    bid_size = None
                    ask_size = None
                    try:
                        if bids:
                            all_bids = [(Decimal(b["price"]), Decimal(b["size"])) for b in bids if b.get("price") and b.get("size")]
                            if all_bids:
                                all_bids.sort(key=lambda x: x[0], reverse=True)
                                new_bid = _safe_decimal(all_bids[0][0])
                                bid_size = all_bids[0][1]
                        if asks:
                            all_asks = [(Decimal(a["price"]), Decimal(a["size"])) for a in asks if a.get("price") and a.get("size")]
                            if all_asks:
                                all_asks.sort(key=lambda x: x[0])
                                new_ask = _safe_decimal(all_asks[0][0])
                                ask_size = all_asks[0][1]
                    except Exception:
                        pass

                    if new_bid is None and new_ask is None:
                        continue

                    changed = self._apply_update(new_bid, new_ask, bid_size, ask_size, "REST")
                    if changed:
                        self.stats.rest_new += 1
                    else:
                        self.stats.rest_same += 1

                except asyncio.CancelledError:
                    break
                except Exception:
                    self.stats.rest_errors += 1
                await asyncio.sleep(interval_sec)

    def create_tasks(self) -> List[asyncio.Task]:
        """Create and return asyncio tasks for all feed sources."""
        tasks = [
            asyncio.create_task(self._ws_listener("A", is_primary=True)),
        ]
        if self.enable_dual_ws:
            tasks.append(asyncio.create_task(self._ws_listener("B", is_primary=False)))
        if self.enable_rest:
            tasks.append(asyncio.create_task(self._rest_poller()))
        return tasks

    def stop(self):
        self.running = False
        self._stop_parse_thread()

    def reset_tokens(self, yes_token_id: str, no_token_id: str):
        """Update tokens (e.g., on market rotation). Callers should cancel+recreate tasks."""
        self.yes_token_id = yes_token_id
        self.no_token_id = no_token_id
        self._yes_bid = None
        self._yes_ask = None
        self._yes_bid_size = Decimal("0")
        self._yes_ask_size = Decimal("0")
        self.stats = FeedStats()
        self._ws_a_in_grace = False
        self._ws_b_in_grace = False
        self._ws_a_connect_time = 0.0
        self._ws_b_connect_time = 0.0

    def format_stats_line(self) -> str:
        """Rich one-line summary for TUI showing 3-layer system health."""
        s = self.stats

        # Connection status icons
        a_icon = "✓" if self._ws_a_connected else "✗"
        b_icon = "✓" if self._ws_b_connected else "✗"
        r_icon = "✓" if self.enable_rest and s.rest_polls > 0 else ("–" if not self.enable_rest else "…")

        conn_str = f"WS-A:{a_icon} WS-B:{b_icon} REST:{r_icon}"

        # Message counts
        msg_str = f"msgs: A={s.ws_a_msgs} B={s.ws_b_msgs}"

        # REST stats
        rest_str = ""
        if self.enable_rest:
            r_avg = sum(s.rest_latency_ms[-50:]) / max(len(s.rest_latency_ms[-50:]), 1) if s.rest_latency_ms else 0
            rest_str = f" | REST: {s.rest_polls}polls {s.rest_new}new {s.rest_same}same {r_avg:.0f}ms"
            if s.rest_errors > 0:
                rest_str += f" {s.rest_errors}err"

        # Race results
        race_str = ""
        total = s.total_races
        if total > 0:
            a_pct = s.a_first / total * 100
            b_pct = s.b_first / total * 100
            r_pct = s.rest_first / total * 100
            tie_pct = s.tie / total * 100
            race_str = f" | Race({total}): A={s.a_first}({a_pct:.0f}%) B={s.b_first}({b_pct:.0f}%) R={s.rest_first}({r_pct:.0f}%) tie={s.tie}({tie_pct:.0f}%)"

            # Winner tag
            winner_counts = [("WS-A", s.a_first), ("WS-B", s.b_first), ("REST", s.rest_first)]
            winner_counts.sort(key=lambda x: x[1], reverse=True)
            if winner_counts[0][1] > winner_counts[1][1]:
                race_str += f" → {winner_counts[0][0]} fastest"

        # Freshness
        age_ms = (time.time() - s.last_update_time) * 1000 if s.last_update_time > 0 else 0
        fresh_str = f" | age={age_ms:.0f}ms Δbid={s.bid_changes} Δask={s.ask_changes}"

        # Grace period indicator
        grace_str = ""
        if self._ws_a_in_grace or self._ws_b_in_grace:
            g_who = "A" if self._ws_a_in_grace else "B"
            if self._ws_a_in_grace and self._ws_b_in_grace:
                g_who = "A+B"
            grace_str = f" | GRACE({g_who})"
        if self.grace_msgs_skipped > 0:
            grace_str += f" skip={self.grace_msgs_skipped}"

        return f"[3-LAYER] {conn_str} | {msg_str}{rest_str}{race_str}{fresh_str}{grace_str}"
