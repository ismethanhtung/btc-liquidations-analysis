"""
Polymarket Crypto Up/Down Markets Fetcher

Fetches current TRADEABLE 5-minute, 15-minute, 1-hour, 4-hour and daily up/down markets for:
- BTC (Bitcoin)
- ETH (Ethereum)
- XRP
- SOL (Solana)
- DOGE (Dogecoin)

Only returns markets that are actively resolving:
- 5M markets: resolving in 0-5 minutes
- 15M markets: resolving in 0-15 minutes
- 1H markets: resolving in 0-60 minutes

Uses Polymarket Gamma API to search and filter markets.
Markets are in Eastern Time (ET) - this script handles timezone conversion.

API Reference: https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles
"""

import requests
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, as_completed
import pytz
import json
import re
import time

# Polymarket Gamma API endpoints
GAMMA_API_BASE = "https://gamma-api.polymarket.com"
SEARCH_ENDPOINT = f"{GAMMA_API_BASE}/public-search"
# Keyset pagination endpoints (old /events and /markets deprecated ~May 4 2026).
# Response shape:
#   /events/keyset  -> {"events":  [...], "next_cursor": "..."}
#   /markets/keyset -> {"markets": [...], "next_cursor": "..."}
# next_cursor is omitted on last page. Use after_cursor=<token> on subsequent
# pages. "offset" param is explicitly rejected with 422 on keyset endpoints.
EVENTS_ENDPOINT = f"{GAMMA_API_BASE}/events/keyset"
MARKETS_ENDPOINT = f"{GAMMA_API_BASE}/markets/keyset"
TAGS_ENDPOINT = f"{GAMMA_API_BASE}/tags"

# Eastern Time zone (Polymarket uses ET for crypto markets)
ET_TZ = pytz.timezone('America/New_York')
UTC_TZ = pytz.UTC


@dataclass
class CryptoMarket:
    """Represents a crypto up/down market."""
    market_id: str
    question: str
    crypto: str  # BTC, ETH, XRP, SOL
    timeframe: str  # 5M, 15M, 1H, 4H, 1D
    outcome: str  # Up or Down expected
    start_time: datetime
    end_time: datetime
    yes_token_id: Optional[str] = None
    no_token_id: Optional[str] = None
    yes_price: Optional[float] = None
    no_price: Optional[float] = None
    volume: Optional[float] = None
    liquidity: Optional[float] = None
    condition_id: Optional[str] = None
    slug: Optional[str] = None


@dataclass 
class ActiveMarketsResult:
    """Result containing all active markets."""
    timestamp: datetime
    timezone: str
    markets: Dict[str, Dict[str, List[CryptoMarket]]] = field(default_factory=dict)
    # Structure: { "BTC": { "15M": [...], "1H": [...] }, "ETH": {...}, ... }
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "timestamp": self.timestamp.isoformat(),
            "timezone": self.timezone,
            "current_time_et": datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M:%S ET"),
            "markets": {}
        }
        
        for crypto, timeframes in self.markets.items():
            result["markets"][crypto] = {}
            for tf, market_list in timeframes.items():
                result["markets"][crypto][tf] = [
                    {
                        "market_id": m.market_id,
                        "question": m.question,
                        "timeframe": m.timeframe,
                        "start_time": m.start_time.strftime("%Y-%m-%d %H:%M:%S ET"),
                        "end_time": m.end_time.strftime("%Y-%m-%d %H:%M:%S ET"),
                        "yes_token_id": m.yes_token_id,
                        "no_token_id": m.no_token_id,
                        "yes_price": m.yes_price,
                        "no_price": m.no_price,
                        "volume": m.volume,
                        "condition_id": m.condition_id,
                        "slug": m.slug
                    }
                    for m in market_list
                ]
        
        return result


class PolymarketCryptoFetcher:
    """
    Fetches and filters Polymarket crypto up/down markets.
    
    These markets ask questions like:
    - "Will Bitcoin go up in the next 15 minutes?"
    - "Will Ethereum increase by 1pm ET today?"
    """
    
    # Crypto symbols and their search terms
    CRYPTO_MAP = {
        "BTC": ["Bitcoin", "BTC"],
        "ETH": ["Ethereum", "ETH"],
        "XRP": ["XRP", "Ripple"],
        "SOL": ["Solana", "SOL"],
        "DOGE": ["Dogecoin", "DOGE"]
    }
    FIVE_MIN_SLUG_PREFIX = {
        "BTC": "btc",
        "ETH": "eth",
        "XRP": "xrp",
        "SOL": "sol",
        "DOGE": "doge",
    }
    ONE_HOUR_SLUG_NAME = {
        "BTC": "bitcoin",
        "ETH": "ethereum",
        "XRP": "xrp",
        "SOL": "solana",
        "DOGE": "dogecoin",
    }
    
    # Timeframe patterns to search for
    TIMEFRAME_PATTERNS = {
        "5M": ["5 minutes", "5min", "5-minute", "5M"],
        "15M": ["15 minutes", "15min", "15-minute", "15M"],
        "1H": ["1 hour", "1hr", "1-hour", "1H", "hourly"],
        "4H": ["4 hours", "4 hour", "4hr", "4-hour", "4H"],
        "1D": ["daily", "up or down on"],
    }
    
    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json"
        })
        self._tag_cache: Dict[str, str] = {}  # label -> id
    
    def _get_current_time_et(self) -> datetime:
        """Get current time in Eastern Time."""
        return datetime.now(ET_TZ)

    def get_market_by_slug(self, slug: str) -> Optional[Dict]:
        """Fetch one Gamma market by deterministic slug."""
        try:
            response = self.session.get(
                f"{GAMMA_API_BASE}/markets/slug/{slug}",
                timeout=min(self.timeout, 10.0)
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            data = response.json()
            return data if isinstance(data, dict) else None
        except Exception as e:
            print(f"Error fetching market slug '{slug}': {e}")
            return None
    
    def _parse_datetime(self, dt_str: Optional[str]) -> Optional[datetime]:
        """Parse datetime string to timezone-aware datetime."""
        if not dt_str:
            return None
        
        try:
            # Try ISO format first
            if 'T' in dt_str:
                # Normalize the datetime string to handle variable-length microseconds
                # Python's fromisoformat requires exactly 6 digits for microseconds
                normalized_str = dt_str
                
                # Replace 'Z' with '+00:00' for UTC
                normalized_str = normalized_str.replace('Z', '+00:00')
                
                # Handle microseconds: normalize to 6 digits or remove if malformed
                # Pattern: YYYY-MM-DDTHH:MM:SS.microseconds+00:00
                # Match microseconds part (between . and + or end)
                microsecond_pattern = r'\.(\d+)(?=[\+\-]|$)'
                match = re.search(microsecond_pattern, normalized_str)
                
                if match:
                    microseconds = match.group(1)
                    if len(microseconds) > 6:
                        # Truncate to 6 digits
                        microseconds = microseconds[:6]
                    elif len(microseconds) < 6:
                        # Pad with zeros to 6 digits
                        microseconds = microseconds.ljust(6, '0')
                    
                    # Replace the microseconds part
                    normalized_str = re.sub(
                        microsecond_pattern,
                        f'.{microseconds}',
                        normalized_str,
                        count=1
                    )
                
                # Parse the normalized string
                dt = datetime.fromisoformat(normalized_str)
                if dt.tzinfo is None:
                    dt = UTC_TZ.localize(dt)
                return dt.astimezone(ET_TZ)
            else:
                # Try other formats
                for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d"]:
                    try:
                        dt = datetime.strptime(dt_str, fmt)
                        return ET_TZ.localize(dt)
                    except ValueError:
                        continue
        except Exception as e:
            print(f"Warning: Could not parse datetime '{dt_str}': {e}")
        
        return None
    
    def get_tags(self) -> Dict[str, str]:
        """
        Fetch all available tags from Polymarket.
        
        Returns:
            Dict mapping tag label to tag ID
        """
        if self._tag_cache:
            return self._tag_cache
        
        try:
            response = self.session.get(
                TAGS_ENDPOINT,
                params={"limit": 500},
                timeout=self.timeout
            )
            response.raise_for_status()
            tags = response.json()
            
            for tag in tags:
                label = tag.get("label", "")
                tag_id = tag.get("id", "")
                if label and tag_id:
                    self._tag_cache[label] = tag_id
            
            return self._tag_cache
        except Exception as e:
            print(f"Error fetching tags: {e}")
            return {}
    
    def search_markets(self, query: str, limit: int = 100, include_closed: bool = True) -> List[Dict]:
        """
        Search for markets using the public-search endpoint.
        
        Args:
            query: Search query string
            limit: Maximum results per type
            include_closed: If True, include closed/resolved markets (default True
                since Gamma API changed to exclude closed by default, which breaks
                fast-cycling markets like 5M crypto up/down)
            
        Returns:
            List of event dictionaries containing markets
        """
        try:
            params = {
                "q": query,
                "limit_per_type": limit,
                "events_status": "active",
                "keep_closed_markets": 1 if include_closed else 0,
                "closed": "true" if include_closed else "false",
                "search_tags": "true"
            }
            
            response = self.session.get(
                SEARCH_ENDPOINT,
                params=params,
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()
            
            return data.get("events", [])
        except Exception as e:
            print(f"Error searching markets for '{query}': {e}")
            return []
    
    def get_events(
        self,
        tag_slugs: Optional[List[str]] = None,
        active: bool = True,
        closed: bool = True,
        limit: int = 100
    ) -> List[Dict]:
        """
        Fetch events from the events endpoint with optional tag filtering.
        
        Args:
            tag_slugs: List of tag slugs to filter by
            active: Include active events
            closed: Include closed events (default True since Gamma API changed
                to exclude closed by default)
            limit: Maximum results
            
        Returns:
            List of event dictionaries
        """
        try:
            params = {
                "active": str(active).lower(),
                "closed": str(closed).lower(),
                "limit": limit
            }
            
            if tag_slugs:
                params["tag"] = ",".join(tag_slugs)
            
            response = self.session.get(
                EVENTS_ENDPOINT,
                params=params,
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()
            # /events/keyset returns {"events": [...], "next_cursor": "..."};
            # be tolerant of a raw list (legacy or upstream variants).
            if isinstance(data, dict):
                return data.get("events", [])
            return data if isinstance(data, list) else []
        except Exception as e:
            print(f"Error fetching events: {e}")
            return []
    
    def _extract_crypto_from_question(self, question: str) -> Optional[str]:
        """Extract crypto symbol from market question."""
        question_lower = question.lower()
        
        for symbol, keywords in self.CRYPTO_MAP.items():
            for keyword in keywords:
                if keyword.lower() in question_lower:
                    return symbol
        
        return None
    
    def _extract_timeframe_from_question(self, question: str, start_time: datetime = None, end_time: datetime = None) -> Optional[str]:
        """
        Extract timeframe from market question title.
        
        Market title formats:
        - 15M: "Bitcoin Up or Down - January 11, 5:30AM-5:45AM ET" (time range with :15/:30/:45)
        - 1H: "Bitcoin Up or Down - January 11, 9AM ET" (single hour, no range)
        
        Priority:
        1. Check for single-hour format (1H markets) - "9AM ET" or "11PM ET"
        2. Parse time range for 15M markets
        3. Fall back to patterns
        """
        question_lower = question.lower()

        # Daily: "Bitcoin Up or Down on June 19?"
        if re.search(r'\bup or down on\b', question_lower):
            return "1D"
        
        # Pattern 1: Single hour format for 1H markets (e.g., "9AM ET", "11PM ET", "10AM ET")
        # These are hourly markets with format like "January 11, 9AM ET" without a range
        single_hour_match = re.search(
            r',\s*(\d{1,2})(AM|PM|am|pm)\s+ET',
            question
        )
        
        if single_hour_match:
            # This is a 1-hour market (single time, no range)
            return "1H"
        
        # Pattern 2: Time range format for 15M markets (e.g., "5:30AM-5:45AM")
        time_range_match = re.search(
            r'(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?',
            question
        )
        
        if time_range_match:
            start_hour = int(time_range_match.group(1))
            start_min = int(time_range_match.group(2))
            start_ampm = (time_range_match.group(3) or "").upper()
            end_hour = int(time_range_match.group(4))
            end_min = int(time_range_match.group(5))
            end_ampm = (time_range_match.group(6) or "").upper()
            
            # Convert to 24-hour for calculation
            if start_ampm == "PM" and start_hour != 12:
                start_hour += 12
            elif start_ampm == "AM" and start_hour == 12:
                start_hour = 0
            
            if end_ampm == "PM" and end_hour != 12:
                end_hour += 12
            elif end_ampm == "AM" and end_hour == 12:
                end_hour = 0
            
            # Calculate duration in minutes
            start_total = start_hour * 60 + start_min
            end_total = end_hour * 60 + end_min
            
            # Handle overnight
            if end_total < start_total:
                end_total += 24 * 60
            
            duration_minutes = end_total - start_total
            
            # Classify based on duration
            if 3 <= duration_minutes <= 7:  # 5 minutes
                return "5M"
            elif 12 <= duration_minutes <= 18:  # 15 minutes
                return "15M"
            elif 55 <= duration_minutes <= 75:  # ~1 hour
                return "1H"
            elif 220 <= duration_minutes <= 260:  # ~4 hours
                return "4H"
            elif duration_minutes > 120:  # other multi-hour ranges
                return "4H"
        
        # Check for explicit 5-minute patterns
        if any(pattern.lower() in question_lower for pattern in self.TIMEFRAME_PATTERNS["5M"]):
            return "5M"
        
        # Check for explicit 15-minute patterns
        if any(pattern.lower() in question_lower for pattern in self.TIMEFRAME_PATTERNS["15M"]):
            return "15M"
        
        # Check for 1-hour patterns
        if any(pattern.lower() in question_lower for pattern in self.TIMEFRAME_PATTERNS["1H"]):
            return "1H"

        # Check for 4-hour patterns
        if any(pattern.lower() in question_lower for pattern in self.TIMEFRAME_PATTERNS["4H"]):
            return "4H"

        # Check for daily patterns
        if any(pattern.lower() in question_lower for pattern in self.TIMEFRAME_PATTERNS["1D"]):
            return "1D"
        
        return None
    
    def _extract_times_from_market(self, market: Dict) -> tuple:
        """Extract start and end times from market data."""
        # Try different field names
        start_str = market.get("startDate") or market.get("start_date") or market.get("startDateIso")
        end_str = market.get("endDate") or market.get("end_date") or market.get("endDateIso")
        
        start_time = self._parse_datetime(start_str)
        end_time = self._parse_datetime(end_str)
        
        return start_time, end_time
    
    def _is_market_currently_active(
        self,
        start_time: Optional[datetime],
        end_time: Optional[datetime]
    ) -> bool:
        """Check if market is currently active (current time is within start-end window)."""
        if not start_time or not end_time:
            return False
        
        current_time = self._get_current_time_et()
        
        # Market is active if current time is between start and end
        return start_time <= current_time <= end_time
    
    def _extract_token_ids(self, market: Dict) -> tuple:
        """Extract YES and NO token IDs from market data."""
        yes_token_id = None
        no_token_id = None
        
        # Try clobTokenIds field (JSON string)
        clob_tokens = market.get("clobTokenIds")
        if clob_tokens:
            try:
                if isinstance(clob_tokens, str):
                    token_ids = json.loads(clob_tokens)
                else:
                    token_ids = clob_tokens
                
                if isinstance(token_ids, list) and len(token_ids) >= 2:
                    yes_token_id = str(token_ids[0])
                    no_token_id = str(token_ids[1])
                elif isinstance(token_ids, list) and len(token_ids) == 1:
                    yes_token_id = str(token_ids[0])
            except (json.JSONDecodeError, TypeError):
                pass
        
        # Try tokens array
        if not yes_token_id:
            tokens = market.get("tokens", [])
            for token in tokens:
                outcome = token.get("outcome", "").lower()
                token_id = token.get("token_id")
                if outcome == "yes" and token_id:
                    yes_token_id = str(token_id)
                elif outcome == "no" and token_id:
                    no_token_id = str(token_id)
        
        return yes_token_id, no_token_id
    
    def _extract_prices(self, market: Dict) -> tuple:
        """Extract YES and NO prices from market data."""
        yes_price = None
        no_price = None
        
        # Try outcomePrices field (JSON string)
        outcome_prices = market.get("outcomePrices")
        if outcome_prices:
            try:
                if isinstance(outcome_prices, str):
                    prices = json.loads(outcome_prices)
                else:
                    prices = outcome_prices
                
                if isinstance(prices, list) and len(prices) >= 2:
                    yes_price = float(prices[0])
                    no_price = float(prices[1])
                elif isinstance(prices, list) and len(prices) == 1:
                    yes_price = float(prices[0])
                    no_price = 1.0 - yes_price if yes_price else None
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        
        return yes_price, no_price
    
    def _process_market(self, market: Dict, event: Optional[Dict] = None) -> Optional[CryptoMarket]:
        """
        Process a market dictionary and create a CryptoMarket if it matches criteria.
        
        Args:
            market: Market dictionary from API
            event: Parent event dictionary (optional)
            
        Returns:
            CryptoMarket if valid, None otherwise
        """
        question = market.get("question", "") or market.get("title", "")
        if not question:
            return None
        
        # Check if this is an up/down market
        question_lower = question.lower()
        if not any(term in question_lower for term in ["up", "down", "increase", "decrease", "higher", "lower", "above", "below"]):
            return None
        
        # Extract crypto symbol
        crypto = self._extract_crypto_from_question(question)
        if not crypto:
            return None
        
        # Get times first (needed for duration-based timeframe detection)
        start_time, end_time = self._extract_times_from_market(market)
        
        # Check if currently active
        if not self._is_market_currently_active(start_time, end_time):
            return None
        
        # Extract timeframe (pass times for duration-based detection)
        timeframe = self._extract_timeframe_from_question(question, start_time, end_time)
        if not timeframe or timeframe not in ["5M", "15M", "1H"]:  # Only want 5M, 15M and 1H
            return None
        
        # Get token IDs
        yes_token_id, no_token_id = self._extract_token_ids(market)
        
        # Get prices
        yes_price, no_price = self._extract_prices(market)
        
        # Get volume
        volume = market.get("volume") or market.get("volumeNum")
        if volume:
            try:
                volume = float(volume)
            except (ValueError, TypeError):
                volume = None
        
        # Get liquidity
        liquidity = market.get("liquidity") or market.get("liquidityNum")
        if liquidity:
            try:
                liquidity = float(liquidity)
            except (ValueError, TypeError):
                liquidity = None
        
        return CryptoMarket(
            market_id=market.get("id", ""),
            question=question,
            crypto=crypto,
            timeframe=timeframe,
            outcome="Up/Down",
            start_time=start_time,
            end_time=end_time,
            yes_token_id=yes_token_id,
            no_token_id=no_token_id,
            yes_price=yes_price,
            no_price=no_price,
            volume=volume,
            liquidity=liquidity,
            condition_id=market.get("conditionId"),
            slug=market.get("slug")
        )
    
    def _is_resolving_soon(self, market: CryptoMarket) -> bool:
        """
        Check if market is resolving within its timeframe window.
        
        - 5M markets: resolving in 0-5 minutes
        - 15M markets: resolving in 0-15 minutes
        - 1H markets: resolving in 0-60 minutes
        """
        if not market.end_time:
            return False
        
        current_time = self._get_current_time_et()
        time_until_resolution = (market.end_time - current_time).total_seconds() / 60
        
        # Must be resolving in the future (not already resolved)
        if time_until_resolution < 0:
            return False
        
        # Check based on timeframe
        if market.timeframe == "5M":
            return time_until_resolution <= 5
        elif market.timeframe == "15M":
            return time_until_resolution <= 15
        elif market.timeframe == "1H":
            return time_until_resolution <= 60
        
        return False
    
    def get_markets_by_end_date(
        self,
        end_date_min: str,
        end_date_max: str,
        limit: int = 200,
    ) -> List[Dict]:
        """
        Fetch markets from the /markets endpoint filtered by end date range.
        
        This is the reliable way to find fast-cycling markets (5M, 15M) that
        the /public-search endpoint fails to index.
        
        Args:
            end_date_min: ISO datetime string for minimum end date (e.g. "2026-04-09T14:00:00Z")
            end_date_max: ISO datetime string for maximum end date
            limit: Maximum results
            
        Returns:
            List of market dictionaries
        """
        # NOTE: /markets/keyset is flaky for end_date_min/max queries — same
        # params can return 500 vs 200 across consecutive calls (cursor encode
        # failures on the server side). Two mitigations:
        #   1. Pass `order=endDate&ascending=true`. This is server-indexed and
        #      gives earliest-ending-first (what 5M/15M finders want), and
        #      empirically reduces (but does not eliminate) the 500 rate.
        #   2. Retry transient 5xx with short backoff. Only log if every
        #      attempt fails, to avoid spamming the writer log on flaky calls.
        params = {
            "end_date_min": end_date_min,
            "end_date_max": end_date_max,
            "limit": limit,
            "order": "endDate",
            "ascending": "true",
        }
        backoffs = (0.4, 0.9, 2.0)  # 3 retries -> ~3.3s total worst case
        last_err: Optional[Exception] = None
        for attempt, sleep_s in enumerate((0.0,) + backoffs):
            if sleep_s > 0:
                time.sleep(sleep_s)
            try:
                response = self.session.get(
                    MARKETS_ENDPOINT,
                    params=params,
                    timeout=self.timeout,
                )
                # Retry only on transient 5xx (server-side flakes); let other
                # status codes (4xx, etc.) bubble up immediately.
                if 500 <= response.status_code < 600:
                    last_err = requests.HTTPError(
                        f"{response.status_code} {response.reason} (attempt {attempt + 1})",
                        response=response,
                    )
                    continue
                response.raise_for_status()
                data = response.json()
                # /markets/keyset returns {"markets": [...], "next_cursor": "..."};
                # be tolerant of a raw list (legacy or upstream variants).
                if isinstance(data, dict):
                    return data.get("markets", [])
                return data if isinstance(data, list) else []
            except requests.RequestException as e:
                # Connection / read errors — also worth retrying.
                last_err = e
                continue
            except Exception as e:
                last_err = e
                break
        print(f"Error fetching markets by end date (after {len(backoffs) + 1} attempts): {last_err}")
        return []

    def _process_market_from_direct(self, market: Dict) -> Optional[CryptoMarket]:
        """
        Process a market from the /markets endpoint (bypasses active-window check
        since we already filtered by end_date range).
        
        Uses eventStartTime for the true market start time when available.
        """
        question = market.get("question", "") or market.get("title", "")
        if not question:
            return None
        
        question_lower = question.lower()
        if not any(term in question_lower for term in ["up", "down"]):
            return None
        
        crypto = self._extract_crypto_from_question(question)
        if not crypto:
            return None
        
        start_time, end_time = self._extract_times_from_market(market)
        
        # Prefer eventStartTime (actual market start) over startDate (creation date)
        event_start_str = market.get("eventStartTime")
        if event_start_str:
            parsed = self._parse_datetime(event_start_str)
            if parsed:
                start_time = parsed
        
        timeframe = self._extract_timeframe_from_question(question, start_time, end_time)
        if not timeframe or timeframe not in ["5M", "15M", "1H", "4H", "1D"]:
            return None
        
        yes_token_id, no_token_id = self._extract_token_ids(market)
        yes_price, no_price = self._extract_prices(market)
        
        volume = market.get("volume") or market.get("volumeNum")
        if volume:
            try:
                volume = float(volume)
            except (ValueError, TypeError):
                volume = None
        
        liquidity = market.get("liquidity") or market.get("liquidityNum")
        if liquidity:
            try:
                liquidity = float(liquidity)
            except (ValueError, TypeError):
                liquidity = None
        
        return CryptoMarket(
            market_id=market.get("id", ""),
            question=question,
            crypto=crypto,
            timeframe=timeframe,
            outcome="Up/Down",
            start_time=start_time,
            end_time=end_time,
            yes_token_id=yes_token_id,
            no_token_id=no_token_id,
            yes_price=yes_price,
            no_price=no_price,
            volume=volume,
            liquidity=liquidity,
            condition_id=market.get("conditionId"),
            slug=market.get("slug")
        )

    def _search_single_query(self, query: str) -> List[Dict]:
        """Execute a single search query and return events."""
        try:
            return self.search_markets(query, limit=100)
        except Exception as e:
            print(f"  Warning: Query '{query}' failed: {e}")
            return []
    
    def fetch_active_crypto_markets(self) -> ActiveMarketsResult:
        """
        Fetch currently TRADEABLE crypto up/down markets.
        
        Only returns markets that are actively resolving:
        - 5M markets: resolving in 0-5 minutes
        - 15M markets: resolving in 0-15 minutes
        - 1H markets: resolving in 0-60 minutes
        
        Primary: /markets endpoint with end_date_min/max (reliable for fast-cycling markets).
        Fallback: /public-search endpoint (may miss 5M markets due to indexing lag).
        
        Returns:
            ActiveMarketsResult containing tradeable markets organized by crypto and timeframe
        """
        result = ActiveMarketsResult(
            timestamp=datetime.now(UTC_TZ),
            timezone="America/New_York (ET)"
        )
        
        for crypto in self.CRYPTO_MAP.keys():
            result.markets[crypto] = {"5M": [], "15M": [], "1H": []}
        
        current_time = self._get_current_time_et()
        print(f"\n{'='*60}")
        print(f"Fetching TRADEABLE Crypto Up/Down Markets")
        print(f"Current Time (ET): {current_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"Looking for: 5M (0-5min), 15M (0-15min) and 1H (0-60min) markets")
        print(f"{'='*60}\n")
        
        all_markets_found = set()
        
        # PRIMARY: Use /markets endpoint with end_date_min/max
        # This reliably finds fast-cycling 5M/15M markets that /public-search misses
        now_utc = datetime.now(UTC_TZ)
        end_min = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
        end_max = (now_utc + timedelta(minutes=65)).strftime("%Y-%m-%dT%H:%M:%SZ")
        
        print(f"Fetching markets (end_date_min method)...")
        raw_markets = self.get_markets_by_end_date(end_min, end_max, limit=500)
        print(f"  Found {len(raw_markets)} markets ending in next ~65 min")
        
        for market in raw_markets:
            market_id = market.get("id", "")
            if market_id in all_markets_found:
                continue
            
            crypto_market = self._process_market_from_direct(market)
            if crypto_market and self._is_resolving_soon(crypto_market):
                all_markets_found.add(market_id)
                result.markets[crypto_market.crypto][crypto_market.timeframe].append(crypto_market)
                
                mins_left = (crypto_market.end_time - current_time).total_seconds() / 60
                print(f"  [+] {crypto_market.crypto} {crypto_market.timeframe}: {crypto_market.question[:45]}... ({mins_left:.1f}m left)")
        
        # FALLBACK: If primary found nothing, try /public-search
        total_found = sum(
            len(result.markets[c][tf])
            for c in result.markets
            for tf in result.markets[c]
        )
        if total_found == 0:
            print("  No markets from /markets endpoint, trying /public-search fallback...")
            search_queries = [
                "up down crypto",
                "Bitcoin up down",
                "Ethereum up down",
                "Solana up down",
                "XRP up down"
            ]
            
            all_events = []
            with ThreadPoolExecutor(max_workers=5) as executor:
                futures = {executor.submit(self._search_single_query, q): q for q in search_queries}
                for future in as_completed(futures):
                    events = future.result()
                    all_events.extend(events)
            
            for event in all_events:
                markets = event.get("markets", [])
                for market in markets:
                    market_id = market.get("id", "")
                    if market_id in all_markets_found:
                        continue
                    
                    crypto_market = self._process_market(market, event)
                    if crypto_market and self._is_resolving_soon(crypto_market):
                        all_markets_found.add(market_id)
                        result.markets[crypto_market.crypto][crypto_market.timeframe].append(crypto_market)
                        
                        mins_left = (crypto_market.end_time - current_time).total_seconds() / 60
                        print(f"  [+] {crypto_market.crypto} {crypto_market.timeframe}: {crypto_market.question[:45]}... ({mins_left:.1f}m left)")
        
        for crypto in result.markets:
            for tf in result.markets[crypto]:
                result.markets[crypto][tf].sort(key=lambda m: m.end_time)
        
        return result
    
    def get_market_details(self, market_id: str) -> Optional[Dict]:
        """
        Fetch detailed information for a specific market.
        
        Args:
            market_id: The market ID to fetch
            
        Returns:
            Market details dictionary or None
        """
        try:
            response = self.session.get(
                f"{MARKETS_ENDPOINT}",
                params={"id": market_id},
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()
            
            if isinstance(data, list) and len(data) > 0:
                return data[0]
            return data
        except Exception as e:
            print(f"Error fetching market {market_id}: {e}")
            return None


def get_active_crypto_markets() -> ActiveMarketsResult:
    """
    Main function to get all active crypto up/down markets.
    
    Returns:
        ActiveMarketsResult with all currently tradeable markets
    """
    fetcher = PolymarketCryptoFetcher()
    return fetcher.fetch_active_crypto_markets()


def print_market_summary(result: ActiveMarketsResult):
    """Print a formatted summary of tradeable markets."""
    current_et = datetime.now(ET_TZ)
    
    print(f"\n{'='*60}")
    print("TRADEABLE CRYPTO UP/DOWN MARKETS")
    print(f"{'='*60}")
    print(f"Current Time: {current_et.strftime('%Y-%m-%d %H:%M:%S')} ET")
    print(f"5M markets: resolving in 0-5 minutes")
    print(f"15M markets: resolving in 0-15 minutes")
    print(f"1H markets: resolving in 0-60 minutes")
    print(f"{'='*60}\n")
    
    total_markets = 0
    
    for crypto in ["BTC", "ETH", "XRP", "SOL"]:
        timeframes = result.markets.get(crypto, {})
        crypto_total = sum(len(timeframes.get(tf, [])) for tf in ["5M", "15M", "1H"])
        
        if crypto_total == 0:
            continue
            
        print(f"\n{crypto}:")
        print("-" * 50)
        
        for tf in ["5M", "15M", "1H"]:
            markets = timeframes.get(tf, [])
            total_markets += len(markets)
            
            if markets:
                for m in markets:
                    mins_left = (m.end_time - current_et).total_seconds() / 60
                    price_str = f"YES: {m.yes_price:.2f}" if m.yes_price else "YES: N/A"
                    
                    print(f"\n  [{tf}] {m.question[:50]}...")
                    print(f"    Market ID: {m.market_id}")
                    print(f"    YES Token: {m.yes_token_id}")
                    print(f"    {price_str} | Resolves in: {mins_left:.1f} min")
    
    if total_markets == 0:
        print("\nNo markets currently resolving.")
        print("Markets typically available at :00, :15, :30, :45 minute marks.")
    
    print(f"\n{'='*60}")
    print(f"TOTAL TRADEABLE MARKETS: {total_markets}")
    print(f"{'='*60}\n")


def get_market_ids_only(result: ActiveMarketsResult) -> Dict[str, Dict[str, List[str]]]:
    """
    Extract just the market IDs from the result.
    
    Returns:
        Dictionary structure: {crypto: {timeframe: [market_ids]}}
    """
    ids = {}
    
    for crypto, timeframes in result.markets.items():
        ids[crypto] = {}
        for tf, markets in timeframes.items():
            ids[crypto][tf] = [m.market_id for m in markets]
    
    return ids


def get_next_markets(result: ActiveMarketsResult, within_minutes: int = 30) -> Dict[str, Dict[str, List[CryptoMarket]]]:
    """
    Get markets that will resolve within the specified number of minutes.
    
    These are the most actionable markets for immediate trading.
    
    Args:
        result: ActiveMarketsResult from fetch
        within_minutes: Only include markets resolving within this many minutes
        
    Returns:
        Filtered dictionary with markets ending soon
    """
    current_time = datetime.now(ET_TZ)
    cutoff_time = current_time + timedelta(minutes=within_minutes)
    
    filtered = {}
    
    for crypto, timeframes in result.markets.items():
        filtered[crypto] = {}
        for tf, markets in timeframes.items():
            # Filter to markets ending within the window
            soon_markets = [
                m for m in markets
                if m.end_time and current_time <= m.end_time <= cutoff_time
            ]
            if soon_markets:
                filtered[crypto][tf] = soon_markets
    
    return filtered


def get_token_ids_only(result: ActiveMarketsResult) -> Dict[str, Dict[str, List[Dict[str, str]]]]:
    """
    Extract market IDs and token IDs for trading.
    
    Returns:
        Dictionary with market_id, yes_token_id, no_token_id for each market
    """
    token_data = {}
    
    for crypto, timeframes in result.markets.items():
        token_data[crypto] = {}
        for tf, markets in timeframes.items():
            token_data[crypto][tf] = [
                {
                    "market_id": m.market_id,
                    "yes_token_id": m.yes_token_id,
                    "no_token_id": m.no_token_id,
                    "yes_price": m.yes_price,
                    "no_price": m.no_price,
                    "question": m.question
                }
                for m in markets
            ]
    
    return token_data


def _market_matches_hour(market: CryptoMarket, target_hour: Optional[datetime] = None, tolerance_minutes: int = 5) -> bool:
    """
    Check if a market matches a specific hour.
    
    For 1H markets: checks if market's END time minus 1 hour matches the target hour
                   (since 1H markets start at the hour and end at next hour, and end_time
                   is more reliable than start_time which can have wrong dates).
    For 15M markets: checks if market's START time matches the target hour.
    
    Args:
        market: The market to check
        target_hour: The target hour datetime (with minute=0, second=0, microsecond=0).
                     If None, uses current hour. Should be in ET timezone.
        tolerance_minutes: Allow markets within this many minutes of the target hour (default: 5)
    
    Returns:
        True if market matches target hour (within tolerance), False otherwise
    """
    if target_hour is None:
        target_hour = datetime.now(ET_TZ).replace(minute=0, second=0, microsecond=0)
    
    # Convert target_hour to ET if needed
    if target_hour.tzinfo is None:
        target_hour = ET_TZ.localize(target_hour)
    elif target_hour.tzinfo != ET_TZ:
        target_hour = target_hour.astimezone(ET_TZ)
    target_hour = target_hour.replace(minute=0, second=0, microsecond=0)
    
    if market.timeframe == "1H":
        # For 1H markets, use end_time minus 1 hour (more reliable than start_time)
        # because start_time can have wrong dates but end_time is usually correct
        if not market.end_time:
            return False
        
        # Convert market end_time to ET if needed
        market_end_et = market.end_time
        if market_end_et.tzinfo is None:
            market_end_et = ET_TZ.localize(market_end_et)
        elif market_end_et.tzinfo != ET_TZ:
            market_end_et = market_end_et.astimezone(ET_TZ)
        
        # Calculate market start hour from end_time (1H markets end 1 hour after start)
        market_end_hour = market_end_et.replace(minute=0, second=0, microsecond=0)
        from datetime import timedelta
        market_start_hour = market_end_hour - timedelta(hours=1)
        
        # Check if the market's start hour (derived from end_time) matches target hour
        time_diff = abs((market_start_hour - target_hour).total_seconds() / 60)
        return time_diff <= tolerance_minutes
    
    else:
        # For 15M markets, check start_time
        time_to_check = market.start_time if market.start_time else market.end_time
        if not time_to_check:
            return False
        
        # Convert market time to ET if needed
        market_time_et = time_to_check
        if market_time_et.tzinfo is None:
            market_time_et = ET_TZ.localize(market_time_et)
        elif market_time_et.tzinfo != ET_TZ:
            market_time_et = market_time_et.astimezone(ET_TZ)
        
        # Check if the market's start hour matches the target hour
        market_start_hour = market_time_et.replace(minute=0, second=0, microsecond=0)
        time_diff = abs((market_start_hour - target_hour).total_seconds() / 60)
        return time_diff <= tolerance_minutes


def _floor_hour_et(dt: datetime) -> datetime:
    """Normalize a datetime to the containing ET hour."""
    if dt.tzinfo is None:
        dt = ET_TZ.localize(dt)
    else:
        dt = dt.astimezone(ET_TZ)
    return dt.replace(minute=0, second=0, microsecond=0)


def _build_1h_slug(crypto_symbol: str, target_hour: datetime) -> Optional[str]:
    """Build Polymarket's title-based 1H market slug."""
    name = PolymarketCryptoFetcher.ONE_HOUR_SLUG_NAME.get(crypto_symbol)
    if not name:
        return None
    target_hour = _floor_hour_et(target_hour)
    month = target_hour.strftime("%B").lower()
    hour_12 = target_hour.hour % 12 or 12
    am_pm = "am" if target_hour.hour < 12 else "pm"
    return (
        f"{name}-up-or-down-{month}-{target_hour.day}-"
        f"{target_hour.year}-{hour_12}{am_pm}-et"
    )


def _find_1h_market_by_slug(fetcher: PolymarketCryptoFetcher, crypto_symbol: str,
                            target_hour: Optional[datetime], logger) -> Optional[CryptoMarket]:
    """Resolve a 1H market through the deterministic title slug endpoint."""
    current_time = fetcher._get_current_time_et()
    target_interval = _floor_hour_et(target_hour or current_time)
    direct_slug = _build_1h_slug(crypto_symbol, target_interval)
    if not direct_slug:
        return None

    logger.info(f"{crypto_symbol} 1H finder: Trying direct slug {direct_slug}")
    market_data = fetcher.get_market_by_slug(direct_slug)
    cm = fetcher._process_market_from_direct(market_data) if market_data else None
    if (
        cm and cm.crypto == crypto_symbol and cm.timeframe == "1H" and
        cm.end_time and cm.end_time > current_time and
        _market_matches_hour(cm, target_interval)
    ):
        logger.info(f"  Found {crypto_symbol} 1H via direct slug")
        return cm
    return None


def find_btc_1h_market(include_upcoming: bool = True, target_hour: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming BTC 1H market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_hour: If provided, only return markets that match this specific hour.
                     Should be a datetime with minute=0, second=0, microsecond=0 in ET timezone.
    
    Returns:
        CryptoMarket object for the BTC 1H market, or None if not found
    """
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_1h_market_by_slug(fetcher, "BTC", target_hour, logger)
    if slug_market:
        return slug_market
    
    # First, try to find markets resolving soon (0-60 min)
    result = get_active_crypto_markets()
    btc_markets = result.markets.get("BTC", {}).get("1H", [])
    
    if btc_markets:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            matching_markets = [m for m in btc_markets if _market_matches_hour(m, target_hour)]
            if matching_markets:
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            return None
        # Return the first (most immediate) market
        return btc_markets[0]
    
    # If no markets resolving soon and include_upcoming is True, search more broadly
    if not include_upcoming:
        return None
    
    # Search for any active BTC 1H market that hasn't resolved yet
    # Include specific queries to catch all markets, including current hour
    current_time = fetcher._get_current_time_et()
    current_hour = current_time.hour
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current hour market
    date_str = current_time.strftime("%B %d")
    specific_query = f"Bitcoin Up or Down - {date_str}, {hour_12}{am_pm}"
    
    search_queries = [
        "Bitcoin up down", 
        "BTC up down", 
        "Bitcoin 1 hour",
        specific_query  # Specific query for current hour
    ]
    all_markets_found = []
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's BTC
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != "BTC":
                    continue
                
                # Extract timeframe
                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                
                if timeframe != "1H":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                # Get token IDs
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                # Process the market - but bypass the "currently active" check
                # since we want markets that haven't resolved yet (even if not yet started)
                # Create CryptoMarket directly instead of using _process_market which filters by active status
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None
                
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="BTC",
                    timeframe="1H",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
    
    if all_markets_found:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            matching_markets = [m for m in all_markets_found if _market_matches_hour(m, target_hour)]
            if matching_markets:
                # Sort by end_time (soonest first)
                matching_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            return None
        
        # Sort by end_time (soonest first)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        return all_markets_found[0]
    
    return None


def find_eth_1h_market(include_upcoming: bool = True, target_hour: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming ETH 1H market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_hour: If provided, only return markets that match this specific hour.
                     Should be a datetime with minute=0, second=0, microsecond=0 in ET timezone.
    
    Returns:
        CryptoMarket object for the ETH 1H market, or None if not found
    """
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_1h_market_by_slug(fetcher, "ETH", target_hour, logger)
    if slug_market:
        return slug_market
    
    # First, try to find markets resolving soon (0-60 min)
    result = get_active_crypto_markets()
    eth_markets = result.markets.get("ETH", {}).get("1H", [])
    
    if eth_markets:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            matching_markets = [m for m in eth_markets if _market_matches_hour(m, target_hour)]
            if matching_markets:
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            return None
        # Return the first (most immediate) market
        return eth_markets[0]
    
    # If no markets resolving soon and include_upcoming is True, search more broadly
    if not include_upcoming:
        return None
    
    # Search for any active ETH 1H market that hasn't resolved yet
    current_time = fetcher._get_current_time_et()
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current hour market
    date_str = current_time.strftime("%B %d")
    specific_query = f"Ethereum Up or Down - {date_str}, {hour_12}{am_pm}"
    
    search_queries = [
        "Ethereum up down", 
        "ETH up down", 
        "Ethereum 1 hour",
        specific_query
    ]
    all_markets_found = []
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's ETH
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != "ETH":
                    continue
                
                # Extract timeframe
                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                
                if timeframe != "1H":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                # Get token IDs
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                # Create CryptoMarket directly
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None
                
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="ETH",
                    timeframe="1H",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
    
    if all_markets_found:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            matching_markets = [m for m in all_markets_found if _market_matches_hour(m, target_hour)]
            if matching_markets:
                # Sort by end_time (soonest first)
                matching_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            return None
        
        # Sort by end_time (soonest first)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        return all_markets_found[0]
    
    return None


def find_xrp_1h_market(include_upcoming: bool = True, target_hour: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming XRP 1H market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_hour: If provided, only return markets that match this specific hour.
                     Should be a datetime with minute=0, second=0, microsecond=0 in ET timezone.
    
    Returns:
        CryptoMarket object for the XRP 1H market, or None if not found
    """
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_1h_market_by_slug(fetcher, "XRP", target_hour, logger)
    if slug_market:
        return slug_market
    
    # First, try to find markets resolving soon (0-60 min)
    result = get_active_crypto_markets()
    xrp_markets = result.markets.get("XRP", {}).get("1H", [])
    
    if xrp_markets:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            # Debug: log all found markets
            logger.debug(f"Found {len(xrp_markets)} XRP 1H markets, checking against target hour {target_hour.strftime('%Y-%m-%d %H:00:00 ET')}")
            for m in xrp_markets:
                if m.end_time:
                    m_hour = m.end_time.replace(minute=0, second=0, microsecond=0)
                    logger.debug(f"  Market: {m.question[:50]}... ends at {m_hour.strftime('%Y-%m-%d %H:00:00 ET')}")
            
            matching_markets = [m for m in xrp_markets if _market_matches_hour(m, target_hour)]
            if matching_markets:
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            logger.warning(f"No XRP 1H market found matching hour {target_hour.strftime('%H:00 ET')} (found {len(xrp_markets)} markets but none matched)")
            return None
        # Return the first (most immediate) market
        return xrp_markets[0]
    
    # If no markets resolving soon and include_upcoming is True, search more broadly
    if not include_upcoming:
        return None
    
    # Search for any active XRP 1H market that hasn't resolved yet
    current_time = fetcher._get_current_time_et()
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current hour market
    date_str = current_time.strftime("%B %d")
    specific_query = f"XRP Up or Down - {date_str}, {hour_12}{am_pm}"
    
    search_queries = [
        "XRP up down", 
        "XRP 1 hour",
        "Ripple up down",
        specific_query
    ]
    all_markets_found = []
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's XRP
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != "XRP":
                    continue
                
                # Extract timeframe
                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                
                if timeframe != "1H":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                # Get token IDs
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                # Create CryptoMarket directly
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None
                
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="XRP",
                    timeframe="1H",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
    
    if all_markets_found:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            # Debug: log all found markets
            logger.debug(f"Found {len(all_markets_found)} XRP 1H markets in broader search, checking against target hour {target_hour.strftime('%Y-%m-%d %H:00:00 ET')}")
            for m in all_markets_found:
                if m.end_time:
                    m_hour = m.end_time.replace(minute=0, second=0, microsecond=0)
                    if target_hour:
                        target_hour_clean = target_hour.replace(minute=0, second=0, microsecond=0)
                        time_diff = abs((m_hour - target_hour_clean).total_seconds() / 60)
                        logger.debug(f"  Market: {m.question[:50]}... ends at {m_hour.strftime('%Y-%m-%d %H:00:00 ET')} (diff: {time_diff:.1f} min)")
                    else:
                        logger.debug(f"  Market: {m.question[:50]}... ends at {m_hour.strftime('%Y-%m-%d %H:00:00 ET')}")
            
            matching_markets = [m for m in all_markets_found if _market_matches_hour(m, target_hour)]
            if matching_markets:
                # Sort by end_time (soonest first)
                matching_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            logger.warning(f"No XRP 1H market found matching hour {target_hour.strftime('%H:00 ET')} in broader search (found {len(all_markets_found)} markets but none matched)")
            return None
        
        # Sort by end_time (soonest first)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        return all_markets_found[0]
    
    return None


def find_sol_1h_market(include_upcoming: bool = True, target_hour: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming SOL 1H market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_hour: If provided, only return markets that match this specific hour.
                     Should be a datetime with minute=0, second=0, microsecond=0 in ET timezone.
    
    Returns:
        CryptoMarket object for the SOL 1H market, or None if not found
    """
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_1h_market_by_slug(fetcher, "SOL", target_hour, logger)
    if slug_market:
        return slug_market
    
    # First, try to find markets resolving soon (0-60 min)
    result = get_active_crypto_markets()
    sol_markets = result.markets.get("SOL", {}).get("1H", [])
    
    if sol_markets:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            matching_markets = [m for m in sol_markets if _market_matches_hour(m, target_hour)]
            if matching_markets:
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            return None
        # Return the first (most immediate) market
        return sol_markets[0]
    
    # If no markets resolving soon and include_upcoming is True, search more broadly
    if not include_upcoming:
        return None
    
    # Search for any active SOL 1H market that hasn't resolved yet
    current_time = fetcher._get_current_time_et()
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current hour market
    date_str = current_time.strftime("%B %d")
    specific_query = f"Solana Up or Down - {date_str}, {hour_12}{am_pm}"
    
    search_queries = [
        "Solana up down", 
        "SOL up down", 
        "Solana 1 hour",
        specific_query
    ]
    all_markets_found = []
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's SOL
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != "SOL":
                    continue
                
                # Extract timeframe
                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                
                if timeframe != "1H":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                # Get token IDs
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                # Create CryptoMarket directly
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None
                
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="SOL",
                    timeframe="1H",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
    
    if all_markets_found:
        # If target_hour is specified, filter to match that hour
        if target_hour is not None:
            matching_markets = [m for m in all_markets_found if _market_matches_hour(m, target_hour)]
            if matching_markets:
                # Sort by end_time (soonest first)
                matching_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                return matching_markets[0]
            # If no matching market found for target hour, return None to skip
            return None
        
        # Sort by end_time (soonest first)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        return all_markets_found[0]
    
    return None


def find_btc_15m_market(include_upcoming: bool = True, target_15min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming BTC 15M market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_15min: If provided, only return markets that match this specific 15-minute interval.
                     Should be a datetime with minute in [0, 15, 30, 45], second=0, microsecond=0 in ET timezone.
    
    Returns:
        CryptoMarket object for the BTC 15M market, or None if not found
    """
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_15m_market_by_slug(fetcher, "BTC", target_15min, logger)
    if slug_market:
        return slug_market
    
    # First, try to find markets resolving soon (0-15 min)
    result = get_active_crypto_markets()
    btc_markets = result.markets.get("BTC", {}).get("15M", [])
    
    logger.info(f"BTC 15M finder: get_active_crypto_markets() returned {len(btc_markets)} BTC 15M markets")
    if btc_markets:
        logger.info(f"  Found markets: {[m.question[:50] + '...' for m in btc_markets[:3]]}")
    
    if btc_markets:
        # PRIORITY 1: Check for currently active markets FIRST (most reliable)
        # These are markets that are running RIGHT NOW
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in btc_markets 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            # If target_15min specified, prefer active markets that match the date
            if target_15min is not None:
                target_date = target_15min.date()
                matching_active = [m for m in active_markets if m.start_time.date() == target_date]
                if matching_active:
                    logger.info(f"  Found {len(matching_active)} currently active BTC 15M markets for today - using the one ending soonest")
                    matching_active.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                    return matching_active[0]
            # If no target or no date match, use any active market (it's running now!)
            logger.info(f"  Found {len(active_markets)} currently active BTC 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: If target_15min is specified, try exact match
        if target_15min is not None:
            # Debug: log what we're checking
            for m in btc_markets:
                match_result = _market_matches_15min(m, target_15min)
                logger.info(f"  Checking market: {m.question[:60]}... start={m.start_time}, end={m.end_time}, match={match_result}")
            
            matching_markets = [m for m in btc_markets if _market_matches_15min(m, target_15min)]
            if matching_markets:
                return matching_markets[0]
            
            # If we only found one market from get_active_crypto_markets(), use it only if date matches
            # (get_active_crypto_markets only returns markets resolving soon, so it's likely the right one)
            if len(btc_markets) == 1:
                market = btc_markets[0]
                if market.start_time and market.start_time.date() == target_date:
                    logger.info(f"  No exact match for {target_15min.strftime('%H:%M ET')}, but found 1 market from get_active_crypto_markets() with matching date - using it")
                    return market
                else:
                    logger.warning(f"  Found 1 market but date doesn't match (market date={market.start_time.date() if market.start_time else 'unknown'}, target={target_date})")
            
            # If no matching market found for target interval, return None to skip
            logger.warning(f"  Found {len(btc_markets)} BTC 15M markets but none match target {target_15min.strftime('%H:%M ET')}")
            return None
        # Return the first (most immediate) market
        return btc_markets[0]
    
    # If no markets resolving soon and include_upcoming is True, search more broadly
    if not include_upcoming:
        return None
    
    # Search for any active BTC 15M market that hasn't resolved yet
    # Include specific queries to catch all markets, including current 15-minute interval
    current_time = fetcher._get_current_time_et()
    minute_interval = (current_time.minute // 15) * 15
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current 15-minute market (format: "Bitcoin Up or Down January 22, 12:15-12:30PM ET")
    date_str = current_time.strftime("%B %d")
    end_minute = minute_interval + 15
    end_hour = current_time.hour
    end_hour_12 = hour_12
    if end_minute >= 60:
        end_minute -= 60
        end_hour += 1
        if end_hour >= 24:
            end_hour = 0
        end_hour_12 = end_hour if end_hour <= 12 else end_hour - 12
        if end_hour_12 == 0:
            end_hour_12 = 12
        am_pm_end = "AM" if end_hour < 12 else "PM"
    else:
        am_pm_end = am_pm
    
    # Format: "Bitcoin Up or Down January 22, 12:15-12:30PM ET" (no dash after "Up or Down")
    specific_query = f"Bitcoin Up or Down {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    # Also try with dash: "Bitcoin Up or Down - January 22, 12:15-12:30PM ET"
    specific_query_dash = f"Bitcoin Up or Down - {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    # Simpler format
    specific_query2 = f"Bitcoin Up or Down {hour_12}:{minute_interval:02d}"
    
    search_queries = [
        specific_query,  # Most specific: "Bitcoin Up or Down January 22, 12:15-12:30PM ET"
        specific_query_dash,  # With dash: "Bitcoin Up or Down - January 22, 12:15-12:30PM ET"
        specific_query2,  # Simpler: "Bitcoin Up or Down 12:15"
        "Bitcoin up down", 
        "BTC up down", 
        "Bitcoin 15 minute",
        "BTC 15 minute"
    ]
    all_markets_found = []
    
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"BTC 15M finder: Starting broader search with {len(search_queries)} queries")
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        logger.info(f"  Query '{query}': {len(events)} events")
        
        btc_count = 0
        btc_15m_count = 0
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's BTC
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto == "BTC":
                    btc_count += 1
                    # Extract timeframe
                    start_time, end_time = fetcher._extract_times_from_market(market_data)
                    timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                    logger.info(f"    BTC market: {question[:60]}... -> timeframe={timeframe}")
                    if timeframe == "15M":
                        btc_15m_count += 1
                
                if crypto != "BTC":
                    continue
                
                # Extract timeframe
                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                
                if timeframe != "15M":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                # Get token IDs
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                # Process the market - but bypass the "currently active" check
                # since we want markets that haven't resolved yet (even if not yet started)
                # Create CryptoMarket directly instead of using _process_market which filters by active status
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None
                
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="BTC",
                    timeframe="15M",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
        
        if btc_count > 0:
            logger.info(f"    Found {btc_count} BTC markets, {btc_15m_count} are 15M")
    
    logger.info(f"BTC 15M finder: Broader search found {len(all_markets_found)} total BTC 15M markets")
    if all_markets_found:
        # PRIORITY 1: If any market is currently ACTIVE (running right now), use it!
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in all_markets_found 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            logger.info(f"  Found {len(active_markets)} currently ACTIVE BTC 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: Sort by end_time and return the one ending soonest (most relevant)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        logger.info(f"  No active market, using the one ending soonest: {all_markets_found[0].question[:60]}...")
        return all_markets_found[0]
    
    return None


def find_eth_15m_market(include_upcoming: bool = True, target_15min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming ETH 15M market."""
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_15m_market_by_slug(fetcher, "ETH", target_15min, logger)
    if slug_market:
        return slug_market

    result = get_active_crypto_markets()
    eth_markets = result.markets.get("ETH", {}).get("15M", [])

    logger.info(f"ETH 15M finder: get_active_crypto_markets() returned {len(eth_markets)} ETH 15M markets")
    if eth_markets:
        logger.info(f"  Found markets: {[m.question[:50] + '...' for m in eth_markets[:3]]}")
    
    if eth_markets:
        # PRIORITY 1: Check for currently active markets FIRST (most reliable)
        # These are markets that are running RIGHT NOW
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in eth_markets 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            # If target_15min specified, prefer active markets that match the date
            if target_15min is not None:
                target_date = target_15min.date()
                matching_active = [m for m in active_markets if m.start_time.date() == target_date]
                if matching_active:
                    logger.info(f"  Found {len(matching_active)} currently active ETH 15M markets for today - using the one ending soonest")
                    matching_active.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                    return matching_active[0]
            # If no target or no date match, use any active market (it's running now!)
            logger.info(f"  Found {len(active_markets)} currently active ETH 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: If target_15min is specified, try exact match
        if target_15min is not None:
            # Debug: log what we're checking
            for m in eth_markets:
                match_result = _market_matches_15min(m, target_15min)
                logger.info(f"  Checking market: {m.question[:60]}... start={m.start_time}, end={m.end_time}, match={match_result}")
            
            matching_markets = [m for m in eth_markets if _market_matches_15min(m, target_15min)]
            if matching_markets:
                return matching_markets[0]
            
            # If we only found one market from get_active_crypto_markets(), use it only if date matches
            # (get_active_crypto_markets only returns markets resolving soon, so it's likely the right one)
            if len(eth_markets) == 1:
                market = eth_markets[0]
                target_date = target_15min.date()
                if market.start_time and market.start_time.date() == target_date:
                    logger.info(f"  No exact match for {target_15min.strftime('%H:%M ET')}, but found 1 market from get_active_crypto_markets() with matching date - using it")
                    return market
                else:
                    logger.warning(f"  Found 1 market but date doesn't match (market date={market.start_time.date() if market.start_time else 'unknown'}, target={target_date})")
            
            # If we found markets but none match exactly, and none are active, check if any are close to the target
            # This handles cases where the market exists but start_time is slightly off
            if eth_markets:
                # Check if any market's start time is within 15 minutes of target
                for m in eth_markets:
                    if m.start_time:
                        start_rounded = m.start_time.replace(second=0, microsecond=0)
                        start_rounded = start_rounded.replace(minute=(start_rounded.minute // 15) * 15)
                        time_diff = abs((start_rounded - target_15min).total_seconds() / 60)
                        if time_diff <= 15:  # Within 15 minutes
                            logger.info(f"  No exact match, but found market within 15min of target ({time_diff:.1f}min diff) - using it")
                            return m
            
            # If no matching market found for target interval, return None to skip
            logger.warning(f"  Found {len(eth_markets)} ETH 15M markets but none match target {target_15min.strftime('%H:%M ET')}")
            return None
        # Return the first (most immediate) market
        return eth_markets[0]
    
    if not include_upcoming:
        return None
    
    # Search for any active ETH 15M market that hasn't resolved yet
    # Include specific queries to catch all markets, including current 15-minute interval
    current_time = fetcher._get_current_time_et()
    minute_interval = (current_time.minute // 15) * 15
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current 15-minute market (format: "Ethereum Up or Down January 22, 12:15-12:30PM ET")
    date_str = current_time.strftime("%B %d")
    end_minute = minute_interval + 15
    end_hour = current_time.hour
    end_hour_12 = hour_12
    if end_minute >= 60:
        end_minute -= 60
        end_hour += 1
        if end_hour >= 24:
            end_hour = 0
        end_hour_12 = end_hour if end_hour <= 12 else end_hour - 12
        if end_hour_12 == 0:
            end_hour_12 = 12
        am_pm_end = "AM" if end_hour < 12 else "PM"
    else:
        am_pm_end = am_pm
    
    # Format: "Ethereum Up or Down January 22, 12:15-12:30PM ET" (no dash after "Up or Down")
    specific_query_full = f"Ethereum Up or Down {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    # Also try with dash: "Ethereum Up or Down - January 22, 12:15-12:30PM ET"
    specific_query_dash = f"Ethereum Up or Down - {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    specific_query_simple = f"Ethereum Up or Down {hour_12}:{minute_interval:02d}"
    
    search_queries = [
        specific_query_full, # Most specific: "Ethereum Up or Down January 22, 12:15-12:30PM ET"
        specific_query_dash, # With dash: "Ethereum Up or Down - January 22, 12:15-12:30PM ET"
        specific_query_simple, # Simpler: "Ethereum Up or Down 12:15"
        "Ethereum up down", 
        "ETH up down", 
        "Ethereum 15 minute",
        "ETH 15 minute",
    ]
    all_markets_found = []
    
    logger.info(f"ETH 15M finder: Starting broader search with {len(search_queries)} queries")
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        logger.info(f"  Query '{query}': {len(events)} events")
        
        eth_count = 0
        eth_15m_count = 0
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's ETH
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto == "ETH":
                    eth_count += 1
                    # Extract timeframe
                    start_time, end_time = fetcher._extract_times_from_market(market_data)
                    timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                    logger.info(f"    ETH market: {question[:60]}... -> timeframe={timeframe}")
                    if timeframe == "15M":
                        eth_15m_count += 1
                
                if crypto != "ETH":
                    continue
                
                # Only accept 15M markets
                if timeframe != "15M":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                volume = float(volume) if volume else None
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                liquidity = float(liquidity) if liquidity else None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="ETH",
                    timeframe="15M",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
        
        if eth_count > 0:
            logger.info(f"    Found {eth_count} ETH markets, {eth_15m_count} are 15M")
    
    logger.info(f"ETH 15M finder: Broader search found {len(all_markets_found)} total ETH 15M markets")
    if all_markets_found:
        # PRIORITY 1: If any market is currently ACTIVE (running right now), use it!
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in all_markets_found 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            logger.info(f"  Found {len(active_markets)} currently ACTIVE ETH 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: Sort by end_time and return the one ending soonest (most relevant)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        logger.info(f"  No active market, using the one ending soonest: {all_markets_found[0].question[:60]}...")
        return all_markets_found[0]
    
    return None


def find_sol_15m_market(include_upcoming: bool = True, target_15min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming SOL 15M market."""
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_15m_market_by_slug(fetcher, "SOL", target_15min, logger)
    if slug_market:
        return slug_market

    result = get_active_crypto_markets()
    sol_markets = result.markets.get("SOL", {}).get("15M", [])

    logger.info(f"SOL 15M finder: get_active_crypto_markets() returned {len(sol_markets)} SOL 15M markets")
    if sol_markets:
        logger.info(f"  Found markets: {[m.question[:50] + '...' for m in sol_markets[:3]]}")
    
    if sol_markets:
        # If target_15min is specified, filter to match that interval
        if target_15min is not None:
            matching_markets = [m for m in sol_markets if _market_matches_15min(m, target_15min)]
            if matching_markets:
                return matching_markets[0]
            
            # If no exact match, check if any market is currently active (started but not ended)
            # CRITICAL: Also check that the market date matches the target date
            current_time = fetcher._get_current_time_et()
            target_date = target_15min.date()
            active_markets = [
                m for m in sol_markets 
                if m.start_time and m.end_time and 
                m.start_time <= current_time < m.end_time and
                m.start_time.date() == target_date  # Must be same date
            ]
            if active_markets:
                logger.info(f"  No exact match for {target_15min.strftime('%H:%M ET')}, but found {len(active_markets)} active markets from get_active_crypto_markets()")
                active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                return active_markets[0]
            
            # If we only found one market from get_active_crypto_markets(), use it only if date matches
            if len(sol_markets) == 1:
                market = sol_markets[0]
                target_date = target_15min.date()
                if market.start_time and market.start_time.date() == target_date:
                    logger.info(f"  No exact match for {target_15min.strftime('%H:%M ET')}, but found 1 market from get_active_crypto_markets() with matching date - using it")
                    return market
                else:
                    logger.warning(f"  Found 1 market but date doesn't match (market date={market.start_time.date() if market.start_time else 'unknown'}, target={target_date})")
            
            # If we found markets but none match exactly, check if any are close to the target
            if sol_markets:
                for m in sol_markets:
                    if m.start_time:
                        start_rounded = m.start_time.replace(second=0, microsecond=0)
                        start_rounded = start_rounded.replace(minute=(start_rounded.minute // 15) * 15)
                        time_diff = abs((start_rounded - target_15min).total_seconds() / 60)
                        if time_diff <= 15:  # Within 15 minutes
                            logger.info(f"  No exact match, but found market within 15min of target ({time_diff:.1f}min diff) - using it")
                            return m
            
            logger.warning(f"  Found {len(sol_markets)} SOL 15M markets but none match target {target_15min.strftime('%H:%M ET')}")
            return None
        # Return the first (most immediate) market
        return sol_markets[0]
    
    if not include_upcoming:
        return None
    
    # Search for any active SOL 15M market that hasn't resolved yet
    # Include specific queries to catch all markets, including current 15-minute interval
    current_time = fetcher._get_current_time_et()
    minute_interval = (current_time.minute // 15) * 15
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current 15-minute market (format: "Solana Up or Down January 22, 12:15-12:30PM ET")
    date_str = current_time.strftime("%B %d")
    end_minute = minute_interval + 15
    end_hour = current_time.hour
    end_hour_12 = hour_12
    if end_minute >= 60:
        end_minute -= 60
        end_hour += 1
        if end_hour >= 24:
            end_hour = 0
        end_hour_12 = end_hour if end_hour <= 12 else end_hour - 12
        if end_hour_12 == 0:
            end_hour_12 = 12
        am_pm_end = "AM" if end_hour < 12 else "PM"
    else:
        am_pm_end = am_pm
    
    # Format: "Solana Up or Down January 22, 12:15-12:30PM ET" (no dash after "Up or Down")
    specific_query_full = f"Solana Up or Down {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    # Also try with dash: "Solana Up or Down - January 22, 12:15-12:30PM ET"
    specific_query_dash = f"Solana Up or Down - {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    specific_query_simple = f"Solana Up or Down {hour_12}:{minute_interval:02d}"
    
    search_queries = [
        specific_query_full, # Most specific: "Solana Up or Down January 22, 12:15-12:30PM ET"
        specific_query_dash, # With dash: "Solana Up or Down - January 22, 12:15-12:30PM ET"
        specific_query_simple, # Simpler: "Solana Up or Down 12:15"
        "Solana up down 15", 
        "SOL up down 15", 
        "Solana 15 minute", 
        "SOL 15 minute"
    ]
    all_markets_found = []
    
    logger.info(f"SOL 15M finder: Starting broader search with {len(search_queries)} queries")
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        logger.info(f"  Query '{query}': {len(events)} events")
        
        sol_count = 0
        sol_15m_count = 0
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's SOL
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto == "SOL":
                    sol_count += 1
                    # Extract timeframe
                    start_time, end_time = fetcher._extract_times_from_market(market_data)
                    timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                    logger.info(f"    SOL market: {question[:60]}... -> timeframe={timeframe}")
                    if timeframe == "15M":
                        sol_15m_count += 1
                
                if crypto != "SOL":
                    continue
                
                # Only accept 15M markets
                if timeframe != "15M":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                volume = float(volume) if volume else None
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                liquidity = float(liquidity) if liquidity else None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="SOL",
                    timeframe="15M",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
        
        if sol_count > 0:
            logger.info(f"    Found {sol_count} SOL markets, {sol_15m_count} are 15M")
    
    logger.info(f"SOL 15M finder: Broader search found {len(all_markets_found)} total SOL 15M markets")
    if all_markets_found:
        # PRIORITY 1: If any market is currently ACTIVE (running right now), use it!
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in all_markets_found 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            logger.info(f"  Found {len(active_markets)} currently ACTIVE SOL 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: Sort by end_time and return the one ending soonest (most relevant)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        logger.info(f"  No active market, using the one ending soonest: {all_markets_found[0].question[:60]}...")
        return all_markets_found[0]
    
    return None


def find_xrp_15m_market(include_upcoming: bool = True, target_15min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming XRP 15M market."""
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    slug_market = _find_15m_market_by_slug(fetcher, "XRP", target_15min, logger)
    if slug_market:
        return slug_market

    result = get_active_crypto_markets()
    xrp_markets = result.markets.get("XRP", {}).get("15M", [])

    logger.info(f"XRP 15M finder: get_active_crypto_markets() returned {len(xrp_markets)} XRP 15M markets")
    if xrp_markets:
        logger.info(f"  Found markets: {[m.question[:50] + '...' for m in xrp_markets[:3]]}")
    
    if xrp_markets:
        # PRIORITY 1: Check for currently active markets FIRST (most reliable)
        # These are markets that are running RIGHT NOW
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in xrp_markets 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            # If target_15min specified, prefer active markets that match the date
            if target_15min is not None:
                target_date = target_15min.date()
                matching_active = [m for m in active_markets if m.start_time.date() == target_date]
                if matching_active:
                    logger.info(f"  Found {len(matching_active)} currently active XRP 15M markets for today - using the one ending soonest")
                    matching_active.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                    return matching_active[0]
            # If no target or no date match, use any active market (it's running now!)
            logger.info(f"  Found {len(active_markets)} currently active XRP 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: If target_15min is specified, try exact match
        if target_15min is not None:
            matching_markets = [m for m in xrp_markets if _market_matches_15min(m, target_15min)]
            if matching_markets:
                return matching_markets[0]
            
            # If we only found one market from get_active_crypto_markets(), use it only if date matches
            if len(xrp_markets) == 1:
                market = xrp_markets[0]
                target_date = target_15min.date()
                if market.start_time and market.start_time.date() == target_date:
                    logger.info(f"  No exact match for {target_15min.strftime('%H:%M ET')}, but found 1 market from get_active_crypto_markets() with matching date - using it")
                    return market
                else:
                    logger.warning(f"  Found 1 market but date doesn't match (market date={market.start_time.date() if market.start_time else 'unknown'}, target={target_date})")
            
            # If we found markets but none match exactly, check if any are close to the target
            if xrp_markets:
                for m in xrp_markets:
                    if m.start_time:
                        start_rounded = m.start_time.replace(second=0, microsecond=0)
                        start_rounded = start_rounded.replace(minute=(start_rounded.minute // 15) * 15)
                        time_diff = abs((start_rounded - target_15min).total_seconds() / 60)
                        if time_diff <= 15:  # Within 15 minutes
                            logger.info(f"  No exact match, but found market within 15min of target ({time_diff:.1f}min diff) - using it")
                            return m
            
            logger.warning(f"  Found {len(xrp_markets)} XRP 15M markets but none match target {target_15min.strftime('%H:%M ET')}")
            return None
        # Return the first (most immediate) market
        return xrp_markets[0]
    
    if not include_upcoming:
        return None
    
    # Search for any active XRP 15M market that hasn't resolved yet
    # Include specific queries to catch all markets, including current 15-minute interval
    current_time = fetcher._get_current_time_et()
    minute_interval = (current_time.minute // 15) * 15
    am_pm = "AM" if current_time.hour < 12 else "PM"
    hour_12 = current_time.hour if current_time.hour <= 12 else current_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    # Build specific query for current 15-minute market (format: "XRP Up or Down January 22, 12:15-12:30PM ET")
    date_str = current_time.strftime("%B %d")
    end_minute = minute_interval + 15
    end_hour = current_time.hour
    end_hour_12 = hour_12
    if end_minute >= 60:
        end_minute -= 60
        end_hour += 1
        if end_hour >= 24:
            end_hour = 0
        end_hour_12 = end_hour if end_hour <= 12 else end_hour - 12
        if end_hour_12 == 0:
            end_hour_12 = 12
        am_pm_end = "AM" if end_hour < 12 else "PM"
    else:
        am_pm_end = am_pm
    
    # Format: "XRP Up or Down January 22, 12:15-12:30PM ET" (no dash after "Up or Down")
    specific_query_full = f"XRP Up or Down {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    # Also try with dash: "XRP Up or Down - January 22, 12:15-12:30PM ET"
    specific_query_dash = f"XRP Up or Down - {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    
    specific_query_simple = f"XRP Up or Down {hour_12}:{minute_interval:02d}"
    
    search_queries = [
        specific_query_full, # Most specific: "XRP Up or Down January 22, 12:15-12:30PM ET"
        specific_query_dash, # With dash: "XRP Up or Down - January 22, 12:15-12:30PM ET"
        specific_query_simple, # Simpler: "XRP Up or Down 12:15"
        "XRP up down 15", 
        "Ripple up down 15", 
        "XRP 15 minute", 
        "Ripple 15 minute"
    ]
    all_markets_found = []
    
    logger.info(f"XRP 15M finder: Starting broader search with {len(search_queries)} queries")
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        logger.info(f"  Query '{query}': {len(events)} events")
        
        xrp_count = 0
        xrp_15m_count = 0
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                # Check if it's XRP
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto == "XRP":
                    xrp_count += 1
                    # Extract timeframe
                    start_time, end_time = fetcher._extract_times_from_market(market_data)
                    timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                    logger.info(f"    XRP market: {question[:60]}... -> timeframe={timeframe}")
                    if timeframe == "15M":
                        xrp_15m_count += 1
                
                if crypto != "XRP":
                    continue
                
                # Only accept 15M markets
                if timeframe != "15M":
                    continue
                
                # Check if market hasn't resolved yet
                if end_time and end_time < current_time:
                    continue
                
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                volume = float(volume) if volume else None
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                liquidity = float(liquidity) if liquidity else None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto="XRP",
                    timeframe="15M",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
        
        if xrp_count > 0:
            logger.info(f"    Found {xrp_count} XRP markets, {xrp_15m_count} are 15M")
    
    logger.info(f"XRP 15M finder: Broader search found {len(all_markets_found)} total XRP 15M markets")
    if all_markets_found:
        # PRIORITY 1: If any market is currently ACTIVE (running right now), use it!
        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in all_markets_found 
            if m.start_time and m.end_time and 
            m.start_time <= current_time < m.end_time
        ]
        if active_markets:
            logger.info(f"  Found {len(active_markets)} currently ACTIVE XRP 15M markets - using the one ending soonest")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: Sort by end_time and return the one ending soonest (most relevant)
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        logger.info(f"  No active market, using the one ending soonest: {all_markets_found[0].question[:60]}...")
        return all_markets_found[0]
    
    return None


def _floor_15min_et(dt: datetime) -> datetime:
    """Normalize a datetime to the containing 15-minute ET interval start."""
    if dt.tzinfo is None:
        dt = ET_TZ.localize(dt)
    else:
        dt = dt.astimezone(ET_TZ)
    return dt.replace(minute=(dt.minute // 15) * 15, second=0, microsecond=0)


def _get_15m_interval_start(market: CryptoMarket) -> Optional[datetime]:
    """Return the true 15M interval start; Gamma startDate is often creation time."""
    if market.end_time:
        return market.end_time - timedelta(minutes=15)
    return market.start_time


def _build_15m_slug(crypto_symbol: str, interval_start: datetime) -> Optional[str]:
    """Build Polymarket's deterministic 15M market slug for an interval start."""
    prefix = PolymarketCryptoFetcher.FIVE_MIN_SLUG_PREFIX.get(crypto_symbol)
    if not prefix:
        return None
    interval_start = _floor_15min_et(interval_start)
    start_ts = int(interval_start.astimezone(UTC_TZ).timestamp())
    return f"{prefix}-updown-15m-{start_ts}"


def _find_15m_market_by_slug(fetcher: PolymarketCryptoFetcher, crypto_symbol: str,
                             target_15min: Optional[datetime], logger) -> Optional[CryptoMarket]:
    """Resolve a 15M market through the deterministic slug endpoint."""
    current_time = fetcher._get_current_time_et()
    target_interval = _floor_15min_et(target_15min or current_time)
    direct_slug = _build_15m_slug(crypto_symbol, target_interval)
    if not direct_slug:
        return None

    logger.info(f"{crypto_symbol} 15M finder: Trying direct slug {direct_slug}")
    market_data = fetcher.get_market_by_slug(direct_slug)
    cm = fetcher._process_market_from_direct(market_data) if market_data else None
    if (
        cm and cm.crypto == crypto_symbol and cm.timeframe == "15M" and
        cm.end_time and cm.end_time > current_time and
        _market_matches_15min(cm, target_interval)
    ):
        logger.info(f"  Found {crypto_symbol} 15M via direct slug")
        return cm
    return None


def _market_matches_15min(market: CryptoMarket, target_15min: Optional[datetime] = None, tolerance_minutes: int = 5) -> bool:
    """
    Check if a market matches a specific 15-minute interval.
    
    For 15M markets: checks if market's START time matches the target 15-minute interval.
    
    Args:
        market: The market to check
        target_15min: The target 15-minute interval datetime (with minute in [0, 15, 30, 45], second=0, microsecond=0).
                     If None, uses current 15-minute interval. Should be in ET timezone.
        tolerance_minutes: Allow markets within this many minutes of the target interval (default: 5, increased for flexibility)
    
    Returns:
        True if market matches target interval (within tolerance), False otherwise
    """
    if target_15min is None:
        current_time = datetime.now(ET_TZ)
        target_15min = current_time.replace(second=0, microsecond=0)
        # Round down to nearest 15-minute mark
        target_15min = target_15min.replace(minute=(target_15min.minute // 15) * 15)
    
    # Convert target_15min to ET if needed
    if target_15min.tzinfo is None:
        target_15min = ET_TZ.localize(target_15min)
    elif target_15min.tzinfo != ET_TZ:
        target_15min = target_15min.astimezone(ET_TZ)
    
    # Round to nearest 15-minute mark
    target_15min = target_15min.replace(second=0, microsecond=0)
    target_15min = target_15min.replace(minute=(target_15min.minute // 15) * 15)
    
    if market.timeframe != "15M":
        return False
    
    interval_start = _get_15m_interval_start(market)
    if not interval_start:
        return False
    
    # Check if time matches target interval (within tolerance)
    time_et = interval_start
    if time_et.tzinfo is None:
        time_et = ET_TZ.localize(time_et)
    elif time_et.tzinfo != ET_TZ:
        time_et = time_et.astimezone(ET_TZ)
    
    # CRITICAL: Check if the DATE matches first (same day)
    # Only check time if dates match
    target_date = target_15min.date()
    market_date = time_et.date()
    
    if market_date != target_date:
        # Different dates - don't match
        import logging
        logger = logging.getLogger(__name__)
        logger.debug(f"_market_matches_15min: Date mismatch - market date={market_date}, target date={target_date}")
        return False
    
    time_rounded = time_et.replace(second=0, microsecond=0)
    time_rounded = time_rounded.replace(minute=(time_rounded.minute // 15) * 15)
    
    time_diff = abs((time_rounded - target_15min).total_seconds() / 60)
    return time_diff <= tolerance_minutes


def _market_matches_5min(market: CryptoMarket, target_5min: Optional[datetime] = None, tolerance_minutes: int = 2) -> bool:
    """
    Check if a market matches a specific 5-minute interval.
    
    For 5M markets: checks if market's START time matches the target 5-minute interval.
    
    Args:
        market: The market to check
        target_5min: The target 5-minute interval datetime (with minute in [0, 5, 10, ...55], second=0, microsecond=0).
                     If None, uses current 5-minute interval. Should be in ET timezone.
        tolerance_minutes: Allow markets within this many minutes of the target interval (default: 2)
    
    Returns:
        True if market matches target interval (within tolerance), False otherwise
    """
    if target_5min is None:
        current_time = datetime.now(ET_TZ)
        target_5min = current_time.replace(second=0, microsecond=0)
        # Round down to nearest 5-minute mark
        target_5min = target_5min.replace(minute=(target_5min.minute // 5) * 5)
    
    # Convert target_5min to ET if needed
    if target_5min.tzinfo is None:
        target_5min = ET_TZ.localize(target_5min)
    elif target_5min.tzinfo != ET_TZ:
        target_5min = target_5min.astimezone(ET_TZ)
    
    # Round to nearest 5-minute mark
    target_5min = target_5min.replace(second=0, microsecond=0)
    target_5min = target_5min.replace(minute=(target_5min.minute // 5) * 5)
    
    if market.timeframe != "5M":
        return False
    
    # For Polymarket 5M markets, end_time is the reliable interval anchor.
    # Some feeds provide start_time as market creation time (not interval start).
    if market.end_time:
        interval_start = market.end_time - timedelta(minutes=5)
    elif market.start_time:
        interval_start = market.start_time
    else:
        return False

    # Normalize to ET
    time_et = interval_start
    if time_et.tzinfo is None:
        time_et = ET_TZ.localize(time_et)
    else:
        time_et = time_et.astimezone(ET_TZ)

    # Date must match target day
    if time_et.date() != target_5min.date():
        return False

    # Round to 5-minute boundary and compare
    time_rounded = time_et.replace(second=0, microsecond=0)
    time_rounded = time_rounded.replace(minute=(time_rounded.minute // 5) * 5)

    time_diff = abs((time_rounded - target_5min).total_seconds() / 60)
    return time_diff <= tolerance_minutes


def _floor_5min_et(dt: datetime) -> datetime:
    """Normalize a datetime to the containing 5-minute ET interval start."""
    if dt.tzinfo is None:
        dt = ET_TZ.localize(dt)
    else:
        dt = dt.astimezone(ET_TZ)
    return dt.replace(minute=(dt.minute // 5) * 5, second=0, microsecond=0)


def _get_5m_interval_start(market: CryptoMarket) -> Optional[datetime]:
    """Return the true 5M interval start; Gamma startDate is often creation time."""
    if market.end_time:
        return market.end_time - timedelta(minutes=5)
    return market.start_time


def _is_5m_market_active(market: CryptoMarket, current_time: datetime) -> bool:
    """Check active status using the 5M interval, not Gamma's creation startDate."""
    if market.timeframe != "5M" or not market.end_time:
        return False
    interval_start = _get_5m_interval_start(market)
    if not interval_start:
        return False
    if current_time.tzinfo is None:
        current_time = ET_TZ.localize(current_time)
    else:
        current_time = current_time.astimezone(ET_TZ)
    interval_start = interval_start.astimezone(ET_TZ) if interval_start.tzinfo else ET_TZ.localize(interval_start)
    end_time = market.end_time.astimezone(ET_TZ) if market.end_time.tzinfo else ET_TZ.localize(market.end_time)
    return interval_start <= current_time < end_time


def _build_5m_slug(crypto_symbol: str, interval_start: datetime) -> Optional[str]:
    """Build Polymarket's deterministic 5M market slug for an interval start."""
    prefix = PolymarketCryptoFetcher.FIVE_MIN_SLUG_PREFIX.get(crypto_symbol)
    if not prefix:
        return None
    interval_start = _floor_5min_et(interval_start)
    start_ts = int(interval_start.astimezone(UTC_TZ).timestamp())
    return f"{prefix}-updown-5m-{start_ts}"


def _find_5m_market_generic(crypto_symbol: str, crypto_name: str, search_terms: list,
                             include_upcoming: bool = True, target_5min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Generic 5M market finder for any crypto.
    
    Primary: /markets endpoint with end_date_min/max (reliable for 5M markets).
    Fallback: get_active_crypto_markets() then /public-search.
    
    Args:
        crypto_symbol: e.g. "BTC", "ETH", "SOL", "XRP"
        crypto_name: e.g. "Bitcoin", "Ethereum", "Solana", "XRP"
        search_terms: List of search queries e.g. ["Bitcoin up down", "BTC up down"]
        include_upcoming: If True, also search for upcoming markets
        target_5min: If provided, only return markets that match this specific 5-minute interval.
    
    Returns:
        CryptoMarket object for the 5M market, or None if not found
    """
    fetcher = PolymarketCryptoFetcher()
    
    import logging
    logger = logging.getLogger(__name__)
    
    current_time = fetcher._get_current_time_et()

    # Fast path: 5M slugs are deterministic and the direct slug endpoint is
    # available before search/keyset indexes catch up at a new session boundary.
    target_interval = _floor_5min_et(target_5min or current_time)
    direct_slug = _build_5m_slug(crypto_symbol, target_interval)
    if direct_slug:
        logger.info(f"{crypto_symbol} 5M finder: Trying direct slug {direct_slug}")
        market_data = fetcher.get_market_by_slug(direct_slug)
        cm = fetcher._process_market_from_direct(market_data) if market_data else None
        if (
            cm and cm.crypto == crypto_symbol and cm.timeframe == "5M" and
            cm.end_time and cm.end_time > current_time and
            _market_matches_5min(cm, target_interval)
        ):
            logger.info(f"  Found {crypto_symbol} 5M via direct slug")
            return cm
    
    # PRIMARY: Use /markets endpoint with end_date_min/max
    # This reliably finds 5M markets that /public-search misses
    now_utc = datetime.now(UTC_TZ)
    end_min = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    # When a target interval is supplied (e.g. a pre-fetch for the NEXT
    # 5-minute session), make sure the query window extends past the
    # target's end_time with at least 10 extra minutes of padding — a
    # too-narrow window was silently missing the upcoming market when
    # called close to the boundary.
    base_end_max = now_utc + timedelta(minutes=10)
    if target_5min is not None:
        target_et = target_5min
        if target_et.tzinfo is None:
            target_et = ET_TZ.localize(target_et)
        target_end_utc = target_et.astimezone(UTC_TZ) + timedelta(minutes=5)
        end_max_dt = max(base_end_max, target_end_utc)
    else:
        end_max_dt = base_end_max
    end_max = end_max_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    
    logger.info(f"{crypto_symbol} 5M finder: Querying /markets endpoint (end_date_min={end_min}, end_date_max={end_max})")
    raw_markets = fetcher.get_markets_by_end_date(end_min, end_max, limit=200)
    logger.info(f"  /markets returned {len(raw_markets)} total markets")
    
    all_markets_found = []
    for market_data in raw_markets:
        cm = fetcher._process_market_from_direct(market_data)
        if cm and cm.crypto == crypto_symbol and cm.timeframe == "5M":
            if cm.end_time and cm.end_time > current_time:
                if cm.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(cm)
    
    logger.info(f"  Found {len(all_markets_found)} {crypto_symbol} 5M markets via /markets endpoint")
    
    # If /markets endpoint found results, use them
    if all_markets_found:
        if target_5min is not None:
            matching = [m for m in all_markets_found if _market_matches_5min(m, target_5min)]
            if matching:
                return matching[0]
            if len(all_markets_found) == 1:
                market = all_markets_found[0]
                target_date = target_5min.date()
                if market.start_time and market.start_time.date() == target_date:
                    logger.info(f"  No exact match, but found 1 market with matching date - using it")
                    return market
            logger.warning(f"  Found {len(all_markets_found)} {crypto_symbol} 5M markets but none match target")
            return None

        # PRIORITY 1 (no target): currently active market by true 5M interval.
        active_markets = [
            m for m in all_markets_found
            if _is_5m_market_active(m, current_time)
        ]
        if active_markets:
            logger.info(f"  Found {len(active_markets)} currently active {crypto_symbol} 5M markets")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        # PRIORITY 2: Soonest ending
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        logger.info(f"  Using soonest-ending: {all_markets_found[0].question[:60]}...")
        return all_markets_found[0]
    
    # FALLBACK 1: get_active_crypto_markets (which now also uses /markets endpoint)
    logger.info(f"{crypto_symbol} 5M finder: /markets returned nothing, trying get_active_crypto_markets()")
    result = get_active_crypto_markets()
    markets_5m = result.markets.get(crypto_symbol, {}).get("5M", [])
    logger.info(f"  get_active_crypto_markets() returned {len(markets_5m)} {crypto_symbol} 5M markets")
    
    if markets_5m:
        if target_5min is not None:
            matching_markets = [m for m in markets_5m if _market_matches_5min(m, target_5min)]
            if matching_markets:
                return matching_markets[0]
            if len(markets_5m) == 1:
                market = markets_5m[0]
                target_date = target_5min.date()
                if market.start_time and market.start_time.date() == target_date:
                    return market
            logger.warning(f"  Found {len(markets_5m)} {crypto_symbol} 5M markets but none match target")
            return None

        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in markets_5m 
            if _is_5m_market_active(m, current_time)
        ]
        if active_markets:
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        return markets_5m[0]
    
    if not include_upcoming:
        return None
    
    # FALLBACK 2: /public-search (may not find 5M markets due to API indexing issues)
    current_time = fetcher._get_current_time_et()
    query_time = target_5min if target_5min is not None else current_time
    if query_time.tzinfo is None:
        query_time = ET_TZ.localize(query_time)
    else:
        query_time = query_time.astimezone(ET_TZ)

    minute_interval = (query_time.minute // 5) * 5
    am_pm = "AM" if query_time.hour < 12 else "PM"
    hour_12 = query_time.hour if query_time.hour <= 12 else query_time.hour - 12
    if hour_12 == 0:
        hour_12 = 12
    
    date_str = query_time.strftime("%B %d")
    end_minute = minute_interval + 5
    end_hour = query_time.hour
    end_hour_12 = hour_12
    if end_minute >= 60:
        end_minute -= 60
        end_hour += 1
        if end_hour >= 24:
            end_hour = 0
        end_hour_12 = end_hour if end_hour <= 12 else end_hour - 12
        if end_hour_12 == 0:
            end_hour_12 = 12
        am_pm_end = "AM" if end_hour < 12 else "PM"
    else:
        am_pm_end = am_pm
    
    specific_query = f"{crypto_name} Up or Down {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    specific_query_dash = f"{crypto_name} Up or Down - {date_str}, {hour_12}:{minute_interval:02d}-{end_hour_12}:{end_minute:02d}{am_pm_end} ET"
    specific_query_simple = f"{crypto_name} Up or Down {hour_12}:{minute_interval:02d}"
    
    search_queries = [
        specific_query,
        specific_query_dash,
        specific_query_simple,
    ] + search_terms
    
    all_markets_found = []
    
    logger.info(f"{crypto_symbol} 5M finder: Starting /public-search fallback with {len(search_queries)} queries")
    
    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        
        for event in events:
            markets = event.get("markets", [])
            for market_data in markets:
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue
                
                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != crypto_symbol:
                    continue
                
                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                
                if timeframe != "5M":
                    continue
                
                if end_time and end_time < current_time:
                    continue
                
                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue
                
                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None
                
                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None
                
                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto=crypto_symbol,
                    timeframe="5M",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug")
                )
                
                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)
    
    logger.info(f"{crypto_symbol} 5M finder: /public-search fallback found {len(all_markets_found)} total 5M markets")
    if all_markets_found:
        if target_5min is not None:
            matching_markets = [m for m in all_markets_found if _market_matches_5min(m, target_5min)]
            if matching_markets:
                matching_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
                return matching_markets[0]
            logger.warning(
                f"  Broader search found {len(all_markets_found)} markets but none match target {target_5min.strftime('%H:%M ET')}"
            )
            return None

        current_time = fetcher._get_current_time_et()
        active_markets = [
            m for m in all_markets_found 
            if _is_5m_market_active(m, current_time)
        ]
        if active_markets:
            logger.info(f"  Found {len(active_markets)} currently ACTIVE {crypto_symbol} 5M markets")
            active_markets.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return active_markets[0]
        
        all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
        logger.info(f"  No active market, using soonest: {all_markets_found[0].question[:60]}...")
        return all_markets_found[0]
    
    return None


def find_btc_5m_market(include_upcoming: bool = True, target_5min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming BTC 5M market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_5min: If provided, only return markets that match this specific 5-minute interval.
                     Should be a datetime with minute in [0, 5, 10, ...55], second=0, microsecond=0 in ET timezone.
    
    Returns:
        CryptoMarket object for the BTC 5M market, or None if not found
    """
    return _find_5m_market_generic(
        "BTC", "Bitcoin",
        ["Bitcoin up down", "BTC up down", "Bitcoin 5 minute", "BTC 5 minute"],
        include_upcoming=include_upcoming, target_5min=target_5min
    )


def find_eth_5m_market(include_upcoming: bool = True, target_5min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming ETH 5M market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_5min: If provided, only return markets that match this specific 5-minute interval.
    
    Returns:
        CryptoMarket object for the ETH 5M market, or None if not found
    """
    return _find_5m_market_generic(
        "ETH", "Ethereum",
        ["Ethereum up down", "ETH up down", "Ethereum 5 minute", "ETH 5 minute"],
        include_upcoming=include_upcoming, target_5min=target_5min
    )


def find_sol_5m_market(include_upcoming: bool = True, target_5min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming SOL 5M market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_5min: If provided, only return markets that match this specific 5-minute interval.
    
    Returns:
        CryptoMarket object for the SOL 5M market, or None if not found
    """
    return _find_5m_market_generic(
        "SOL", "Solana",
        ["Solana up down", "SOL up down", "Solana 5 minute", "SOL 5 minute"],
        include_upcoming=include_upcoming, target_5min=target_5min
    )


def find_xrp_5m_market(include_upcoming: bool = True, target_5min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming XRP 5M market.
    
    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_5min: If provided, only return markets that match this specific 5-minute interval.
    
    Returns:
        CryptoMarket object for the XRP 5M market, or None if not found
    """
    return _find_5m_market_generic(
        "XRP", "XRP",
        ["XRP up down", "Ripple up down", "XRP 5 minute"],
        include_upcoming=include_upcoming, target_5min=target_5min
    )


def find_doge_5m_market(include_upcoming: bool = True, target_5min: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """
    Find the current or upcoming DOGE 5M market.

    Args:
        include_upcoming: If True, also search for upcoming markets (not just resolving soon)
        target_5min: If provided, only return markets that match this specific 5-minute interval.

    Returns:
        CryptoMarket object for the DOGE 5M market, or None if not found
    """
    return _find_5m_market_generic(
        "DOGE", "Dogecoin",
        ["Dogecoin up down", "DOGE up down", "Dogecoin 5 minute", "DOGE 5 minute"],
        include_upcoming=include_upcoming, target_5min=target_5min
    )


# ─────────────────────────────────────────────────────────────────────────────
# "NEXT" market helpers
#
# Calling the plain find_<coin>_5m_market(include_upcoming=True) *without* a
# target_5min returns the CURRENTLY active market (whatever is live right now).
# When you want to pre-fetch metadata for the session that comes AFTER the
# currently active one (e.g. 10-30 seconds before the interval boundary) you
# must pass target_5min = <next interval start in ET> so the candidate is
# filtered by end_time instead of "currently active".
#
# The helpers below do that for you: they compute the next 5-minute interval
# start in ET and delegate to the base finder. They return None if the next
# market isn't listed yet (in which case callers should fall back to live
# fetch on the boundary roll-over).
# ─────────────────────────────────────────────────────────────────────────────

def _next_5min_interval_et() -> datetime:
    """Return the start of the NEXT (upcoming) 5-minute interval in ET."""
    now = datetime.now(ET_TZ)
    current_interval = now.replace(
        minute=(now.minute // 5) * 5, second=0, microsecond=0
    )
    return current_interval + timedelta(minutes=5)


def find_next_btc_5m_market() -> Optional[CryptoMarket]:
    """Find the NEXT (upcoming) BTC 5M market — the one after the active one."""
    return find_btc_5m_market(include_upcoming=True, target_5min=_next_5min_interval_et())


def find_next_eth_5m_market() -> Optional[CryptoMarket]:
    """Find the NEXT (upcoming) ETH 5M market — the one after the active one."""
    return find_eth_5m_market(include_upcoming=True, target_5min=_next_5min_interval_et())


def find_next_sol_5m_market() -> Optional[CryptoMarket]:
    """Find the NEXT (upcoming) SOL 5M market — the one after the active one."""
    return find_sol_5m_market(include_upcoming=True, target_5min=_next_5min_interval_et())


def find_next_xrp_5m_market() -> Optional[CryptoMarket]:
    """Find the NEXT (upcoming) XRP 5M market — the one after the active one."""
    return find_xrp_5m_market(include_upcoming=True, target_5min=_next_5min_interval_et())


def find_next_doge_5m_market() -> Optional[CryptoMarket]:
    """Find the NEXT (upcoming) DOGE 5M market — the one after the active one."""
    return find_doge_5m_market(include_upcoming=True, target_5min=_next_5min_interval_et())


def _current_daily_resolution_date(now_et: Optional[datetime] = None):
    """Return the resolution date for the current daily up/down market."""
    if now_et is None:
        now_et = datetime.now(ET_TZ)
    elif now_et.tzinfo is None:
        now_et = ET_TZ.localize(now_et)
    else:
        now_et = now_et.astimezone(ET_TZ)

    noon_today = now_et.replace(hour=12, minute=0, second=0, microsecond=0)
    if now_et < noon_today:
        return now_et.date()
    return (now_et + timedelta(days=1)).date()


def _floor_4h_et(dt: datetime) -> datetime:
    """Normalize a datetime to the containing 4-hour ET interval start."""
    if dt.tzinfo is None:
        dt = ET_TZ.localize(dt)
    else:
        dt = dt.astimezone(ET_TZ)
    return dt.replace(hour=(dt.hour // 4) * 4, minute=0, second=0, microsecond=0)


def _get_4h_interval_start(market: CryptoMarket) -> Optional[datetime]:
    """Return the true 4H interval start; Gamma startDate is often creation time."""
    if market.end_time:
        return market.end_time - timedelta(hours=4)
    return market.start_time


def _build_daily_slug(crypto_symbol: str, target_date) -> Optional[str]:
    """Build Polymarket's deterministic daily market slug."""
    name = PolymarketCryptoFetcher.ONE_HOUR_SLUG_NAME.get(crypto_symbol)
    if not name:
        return None
    month = target_date.strftime("%B").lower()
    return f"{name}-up-or-down-on-{month}-{target_date.day}-{target_date.year}"


def _build_4h_slug(crypto_symbol: str, interval_start: datetime) -> Optional[str]:
    """Build Polymarket's deterministic 4H market slug for an interval start."""
    prefix = PolymarketCryptoFetcher.FIVE_MIN_SLUG_PREFIX.get(crypto_symbol)
    if not prefix:
        return None
    interval_start = _floor_4h_et(interval_start)
    start_ts = int(interval_start.astimezone(UTC_TZ).timestamp())
    return f"{prefix}-updown-4h-{start_ts}"


def _market_matches_daily(
    market: CryptoMarket,
    target_date=None,
    tolerance_minutes: int = 5,
) -> bool:
    """Check if a daily market resolves on the target ET date (default: current daily)."""
    if market.timeframe != "1D" or not market.end_time:
        return False

    if target_date is None:
        target_date = _current_daily_resolution_date()

    end_et = market.end_time
    if end_et.tzinfo is None:
        end_et = ET_TZ.localize(end_et)
    else:
        end_et = end_et.astimezone(ET_TZ)

    if end_et.date() != target_date:
        return False

    noon = end_et.replace(hour=12, minute=0, second=0, microsecond=0)
    return abs((end_et - noon).total_seconds() / 60) <= tolerance_minutes


def _market_matches_4h(
    market: CryptoMarket,
    target_4h: Optional[datetime] = None,
    tolerance_minutes: int = 5,
) -> bool:
    """Check if a 4H market matches a specific 4-hour interval start."""
    if target_4h is None:
        target_4h = _floor_4h_et(datetime.now(ET_TZ))
    elif target_4h.tzinfo is None:
        target_4h = ET_TZ.localize(target_4h)
    else:
        target_4h = target_4h.astimezone(ET_TZ)
    target_4h = _floor_4h_et(target_4h)

    if market.timeframe != "4H":
        return False

    interval_start = _get_4h_interval_start(market)
    if not interval_start:
        return False

    if interval_start.tzinfo is None:
        interval_start = ET_TZ.localize(interval_start)
    else:
        interval_start = interval_start.astimezone(ET_TZ)
    interval_start = _floor_4h_et(interval_start)

    if interval_start.date() != target_4h.date():
        return False

    time_diff = abs((interval_start - target_4h).total_seconds() / 60)
    return time_diff <= tolerance_minutes


def _find_daily_market_by_slug(
    fetcher: PolymarketCryptoFetcher,
    crypto_symbol: str,
    target_date,
    logger,
) -> Optional[CryptoMarket]:
    """Resolve a daily market through the deterministic slug endpoint."""
    current_time = fetcher._get_current_time_et()
    resolution_date = target_date or _current_daily_resolution_date(current_time)
    direct_slug = _build_daily_slug(crypto_symbol, resolution_date)
    if not direct_slug:
        return None

    logger.info(f"{crypto_symbol} 1D finder: Trying direct slug {direct_slug}")
    market_data = fetcher.get_market_by_slug(direct_slug)
    cm = fetcher._process_market_from_direct(market_data) if market_data else None
    if (
        cm and cm.crypto == crypto_symbol and cm.timeframe == "1D" and
        cm.end_time and cm.end_time > current_time and
        _market_matches_daily(cm, resolution_date)
    ):
        logger.info(f"  Found {crypto_symbol} 1D via direct slug")
        return cm
    return None


def _find_4h_market_by_slug(
    fetcher: PolymarketCryptoFetcher,
    crypto_symbol: str,
    target_4h: Optional[datetime],
    logger,
) -> Optional[CryptoMarket]:
    """Resolve a 4H market through the deterministic slug endpoint."""
    current_time = fetcher._get_current_time_et()
    target_interval = _floor_4h_et(target_4h or current_time)
    direct_slug = _build_4h_slug(crypto_symbol, target_interval)
    if not direct_slug:
        return None

    logger.info(f"{crypto_symbol} 4H finder: Trying direct slug {direct_slug}")
    market_data = fetcher.get_market_by_slug(direct_slug)
    cm = fetcher._process_market_from_direct(market_data) if market_data else None
    if (
        cm and cm.crypto == crypto_symbol and cm.timeframe == "4H" and
        cm.end_time and cm.end_time > current_time and
        _market_matches_4h(cm, target_interval)
    ):
        logger.info(f"  Found {crypto_symbol} 4H via direct slug")
        return cm
    return None


def _find_daily_market_generic(
    crypto_symbol: str,
    crypto_name: str,
    search_terms: list,
    include_upcoming: bool = True,
    target_date=None,
) -> Optional[CryptoMarket]:
    """Generic daily market finder for any crypto."""
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    current_time = fetcher._get_current_time_et()
    resolution_date = target_date or _current_daily_resolution_date(current_time)

    slug_market = _find_daily_market_by_slug(fetcher, crypto_symbol, resolution_date, logger)
    if slug_market:
        return slug_market

    if not include_upcoming:
        return None

    month = resolution_date.strftime("%B")
    day = resolution_date.day
    specific_query = f"{crypto_name} Up or Down on {month} {day}"
    search_queries = list(search_terms) + [specific_query, f"{crypto_name} up or down daily"]
    all_markets_found = []

    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        for event in events:
            for market_data in event.get("markets", []):
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue

                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != crypto_symbol:
                    continue

                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                if timeframe != "1D":
                    continue

                if end_time and end_time < current_time:
                    continue

                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue

                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None

                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None

                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto=crypto_symbol,
                    timeframe="1D",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug"),
                )

                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)

    if all_markets_found:
        matching = [m for m in all_markets_found if _market_matches_daily(m, resolution_date)]
        if matching:
            matching.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return matching[0]
        if target_date is None:
            all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return all_markets_found[0]

    return None


def _find_4h_market_generic(
    crypto_symbol: str,
    crypto_name: str,
    search_terms: list,
    include_upcoming: bool = True,
    target_4h: Optional[datetime] = None,
) -> Optional[CryptoMarket]:
    """Generic 4H market finder for any crypto."""
    fetcher = PolymarketCryptoFetcher()
    import logging
    logger = logging.getLogger(__name__)

    current_time = fetcher._get_current_time_et()
    target_interval = _floor_4h_et(target_4h or current_time)

    slug_market = _find_4h_market_by_slug(fetcher, crypto_symbol, target_interval, logger)
    if slug_market:
        return slug_market

    if not include_upcoming:
        return None

    hour_12 = target_interval.hour % 12 or 12
    am_pm = "AM" if target_interval.hour < 12 else "PM"
    end_interval = target_interval + timedelta(hours=4)
    end_hour_12 = end_interval.hour % 12 or 12
    end_am_pm = "AM" if end_interval.hour < 12 else "PM"
    date_str = target_interval.strftime("%B %d")
    specific_query = (
        f"{crypto_name} Up or Down - {date_str}, "
        f"{hour_12}:{target_interval.strftime('%M')}{am_pm}-"
        f"{end_hour_12}:{end_interval.strftime('%M')}{end_am_pm} ET"
    )
    search_queries = list(search_terms) + [specific_query, f"{crypto_name} up down 4 hour"]
    all_markets_found = []

    for query in search_queries:
        events = fetcher.search_markets(query, limit=50)
        for event in events:
            for market_data in event.get("markets", []):
                question = market_data.get("question", "") or market_data.get("title", "")
                if not question:
                    continue

                crypto = fetcher._extract_crypto_from_question(question)
                if crypto != crypto_symbol:
                    continue

                start_time, end_time = fetcher._extract_times_from_market(market_data)
                timeframe = fetcher._extract_timeframe_from_question(question, start_time, end_time)
                if timeframe != "4H":
                    continue

                if end_time and end_time < current_time:
                    continue

                yes_token_id, no_token_id = fetcher._extract_token_ids(market_data)
                if not yes_token_id:
                    continue

                yes_price, no_price = fetcher._extract_prices(market_data)
                volume = market_data.get("volume") or market_data.get("volumeNum")
                if volume:
                    try:
                        volume = float(volume)
                    except (ValueError, TypeError):
                        volume = None

                liquidity = market_data.get("liquidity") or market_data.get("liquidityNum")
                if liquidity:
                    try:
                        liquidity = float(liquidity)
                    except (ValueError, TypeError):
                        liquidity = None

                crypto_market = CryptoMarket(
                    market_id=market_data.get("id", ""),
                    question=question,
                    crypto=crypto_symbol,
                    timeframe="4H",
                    outcome="Up/Down",
                    start_time=start_time,
                    end_time=end_time,
                    yes_token_id=yes_token_id,
                    no_token_id=no_token_id,
                    yes_price=yes_price,
                    no_price=no_price,
                    volume=volume,
                    liquidity=liquidity,
                    condition_id=market_data.get("conditionId"),
                    slug=market_data.get("slug"),
                )

                if crypto_market.market_id not in [m.market_id for m in all_markets_found]:
                    all_markets_found.append(crypto_market)

    if all_markets_found:
        matching = [m for m in all_markets_found if _market_matches_4h(m, target_interval)]
        if matching:
            matching.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return matching[0]
        if target_4h is None:
            all_markets_found.sort(key=lambda m: m.end_time if m.end_time else datetime.max)
            return all_markets_found[0]

    return None


def find_btc_daily_market(include_upcoming: bool = True, target_date=None) -> Optional[CryptoMarket]:
    """Find the current or upcoming BTC daily up/down market (resolves at noon ET)."""
    return _find_daily_market_generic(
        "BTC", "Bitcoin",
        ["Bitcoin up down", "BTC up down", "Bitcoin daily"],
        include_upcoming=include_upcoming,
        target_date=target_date,
    )


def find_eth_daily_market(include_upcoming: bool = True, target_date=None) -> Optional[CryptoMarket]:
    """Find the current or upcoming ETH daily up/down market (resolves at noon ET)."""
    return _find_daily_market_generic(
        "ETH", "Ethereum",
        ["Ethereum up down", "ETH up down", "Ethereum daily"],
        include_upcoming=include_upcoming,
        target_date=target_date,
    )


def find_sol_daily_market(include_upcoming: bool = True, target_date=None) -> Optional[CryptoMarket]:
    """Find the current or upcoming SOL daily up/down market (resolves at noon ET)."""
    return _find_daily_market_generic(
        "SOL", "Solana",
        ["Solana up down", "SOL up down", "Solana daily"],
        include_upcoming=include_upcoming,
        target_date=target_date,
    )


def find_xrp_daily_market(include_upcoming: bool = True, target_date=None) -> Optional[CryptoMarket]:
    """Find the current or upcoming XRP daily up/down market (resolves at noon ET)."""
    return _find_daily_market_generic(
        "XRP", "XRP",
        ["XRP up down", "Ripple up down", "XRP daily"],
        include_upcoming=include_upcoming,
        target_date=target_date,
    )


def find_doge_daily_market(include_upcoming: bool = True, target_date=None) -> Optional[CryptoMarket]:
    """Find the current or upcoming DOGE daily up/down market (resolves at noon ET)."""
    return _find_daily_market_generic(
        "DOGE", "Dogecoin",
        ["Dogecoin up down", "DOGE up down", "Dogecoin daily"],
        include_upcoming=include_upcoming,
        target_date=target_date,
    )


def find_btc_4h_market(include_upcoming: bool = True, target_4h: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming BTC 4H up/down market."""
    return _find_4h_market_generic(
        "BTC", "Bitcoin",
        ["Bitcoin up down", "BTC up down", "Bitcoin 4 hour"],
        include_upcoming=include_upcoming,
        target_4h=target_4h,
    )


def find_eth_4h_market(include_upcoming: bool = True, target_4h: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming ETH 4H up/down market."""
    return _find_4h_market_generic(
        "ETH", "Ethereum",
        ["Ethereum up down", "ETH up down", "Ethereum 4 hour"],
        include_upcoming=include_upcoming,
        target_4h=target_4h,
    )


def find_sol_4h_market(include_upcoming: bool = True, target_4h: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming SOL 4H up/down market."""
    return _find_4h_market_generic(
        "SOL", "Solana",
        ["Solana up down", "SOL up down", "Solana 4 hour"],
        include_upcoming=include_upcoming,
        target_4h=target_4h,
    )


def find_xrp_4h_market(include_upcoming: bool = True, target_4h: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming XRP 4H up/down market."""
    return _find_4h_market_generic(
        "XRP", "XRP",
        ["XRP up down", "Ripple up down", "XRP 4 hour"],
        include_upcoming=include_upcoming,
        target_4h=target_4h,
    )


def find_doge_4h_market(include_upcoming: bool = True, target_4h: Optional[datetime] = None) -> Optional[CryptoMarket]:
    """Find the current or upcoming DOGE 4H up/down market."""
    return _find_4h_market_generic(
        "DOGE", "Dogecoin",
        ["Dogecoin up down", "DOGE up down", "Dogecoin 4 hour"],
        include_upcoming=include_upcoming,
        target_4h=target_4h,
    )


if __name__ == "__main__":
    import time
    
    start_time = time.time()
    
    # Fetch tradeable markets (already filtered for resolving soon)
    result = get_active_crypto_markets()
    
    fetch_time = time.time() - start_time
    
    # Print summary
    print_market_summary(result)
    
    # Get token data for trading (compact output)
    token_data = get_token_ids_only(result)
    
    # Only print non-empty data
    print("\n" + "="*60)
    print("TRADING DATA (JSON)")
    print("="*60)
    
    compact_data = {}
    for crypto, tfs in token_data.items():
        for tf, markets in tfs.items():
            if markets:
                if crypto not in compact_data:
                    compact_data[crypto] = {}
                compact_data[crypto][tf] = markets
    
    if compact_data:
        print(json.dumps(compact_data, indent=2, default=str))
    else:
        print("No tradeable markets found.")
    
    print(f"\nFetch completed in {fetch_time:.2f}s")
