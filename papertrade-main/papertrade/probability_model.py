"""
Daily BTC up/down probability model.

Estimates P(Up) for Polymarket daily markets (resolve at noon ET) using a
Geometric Brownian Motion (GBM) formula:

    P(S_T > K) = Phi((ln(S/K) + (mu - sigma^2/2) * tau) / (sigma * sqrt(tau)))

where:
    S   = current BTC price
    K   = strike (previous noon ET close / price-to-beat)
    tau = time remaining until resolution (hours)
    mu  = drift per hour (default 0)
    sigma = volatility per hour (estimated from recent Binance 1h returns)

Volatility is estimated from hourly log returns (sample std or EWMA).
"""

from __future__ import annotations

import argparse
import math
import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional, Sequence, Tuple

import pytz
import requests

ET = pytz.timezone("America/New_York")
BINANCE_KLINES = "https://api.binance.com/api/v3/klines"

# Fallback ~47% annualized -> per-hour sigma
DEFAULT_SIGMA_HOURLY = 0.0048
DEFAULT_MU_HOURLY = 0.0


def norm_cdf(x: float) -> float:
    """Standard normal CDF without scipy."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def gbm_prob_above(
    spot: float,
    strike: float,
    tau_hours: float,
    mu_hourly: float = 0.0,
    sigma_hourly: float = DEFAULT_SIGMA_HOURLY,
) -> float:
    """
    P(S_{t+tau} > strike) under GBM.

    Args:
        spot: Current price S
        strike: Strike / price-to-beat K
        tau_hours: Time to resolution in hours
        mu_hourly: Drift per hour
        sigma_hourly: Volatility per hour (log-return std)
    """
    if strike <= 0 or spot <= 0:
        raise ValueError("spot and strike must be positive")

    if tau_hours <= 0:
        return 1.0 if spot > strike else 0.0

    sigma = max(sigma_hourly, 1e-10)
    log_m = math.log(spot / strike)
    drift = (mu_hourly - 0.5 * sigma * sigma) * tau_hours
    d = (log_m + drift) / (sigma * math.sqrt(tau_hours))
    return norm_cdf(d)


def log_returns(closes: Sequence[float]) -> List[float]:
    """Hourly (or uniform interval) log returns."""
    out: List[float] = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            out.append(math.log(closes[i] / closes[i - 1]))
    return out


def estimate_sigma_hourly(
    closes: Sequence[float],
    use_ewma: bool = True,
    ewma_span: int = 72,
) -> Tuple[float, float]:
    """
    Estimate (mu_hourly, sigma_hourly) from a close price series.

    Args:
        closes: Oldest-first close prices (e.g. 1h candles)
        use_ewma: If True, EWMA variance on log returns; else sample std
        ewma_span: EWMA span in bars (default 72h ~ 3 days)
    """
    rets = log_returns(closes)
    if len(rets) < 2:
        return DEFAULT_MU_HOURLY, DEFAULT_SIGMA_HOURLY

    mu = statistics.fmean(rets)

    if use_ewma:
        alpha = 2.0 / (ewma_span + 1.0)
        var = rets[0] * rets[0]
        for r in rets[1:]:
            var = alpha * (r * r) + (1.0 - alpha) * var
        sigma = math.sqrt(max(var, 0.0))
    else:
        sigma = statistics.pstdev(rets) if len(rets) > 1 else DEFAULT_SIGMA_HOURLY

    return mu, max(sigma, 1e-10)


def fetch_binance_hourly_closes(
    symbol: str = "BTCUSDT",
    limit: int = 168,
    timeout: float = 15.0,
) -> List[float]:
    """Fetch recent 1h candle closes from Binance (oldest first)."""
    resp = requests.get(
        BINANCE_KLINES,
        params={"symbol": symbol.upper(), "interval": "1h", "limit": limit},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    return [float(row[4]) for row in data]


def hours_until_noon_et(now_et: Optional[datetime] = None) -> Tuple[float, datetime]:
    """
    Hours until next noon ET resolution and that noon datetime.

    Before noon today -> resolves today at noon.
    At/after noon today -> resolves tomorrow at noon.
    """
    now_et = now_et or datetime.now(ET)
    if now_et.tzinfo is None:
        now_et = ET.localize(now_et)
    else:
        now_et = now_et.astimezone(ET)

    noon_today = now_et.replace(hour=12, minute=0, second=0, microsecond=0)
    if now_et < noon_today:
        resolution = noon_today
    else:
        resolution = noon_today + timedelta(days=1)

    tau_hours = max(0.0, (resolution - now_et).total_seconds() / 3600.0)
    return tau_hours, resolution


@dataclass
class VolEstimate:
    mu_hourly: float
    sigma_hourly: float
    sigma_annualized: float
    n_returns: int
    source: str = "binance_1h"


@dataclass
class DailyProbResult:
    prob_up: float
    prob_down: float
    spot: float
    strike: float
    time_left_hours: float
    resolution_et: datetime
    mu_hourly: float
    sigma_hourly: float
    moneyness_pct: float  # (spot/strike - 1) * 100

    def summary(self) -> str:
        return (
            f"P(Up)={self.prob_up:.1%}  spot=${self.spot:,.2f}  "
            f"strike=${self.strike:,.2f}  ({self.moneyness_pct:+.2f}%)  "
            f"tau={self.time_left_hours:.2f}h  sigma={self.sigma_annualized_pct():.1f}%/yr"
        )

    def sigma_annualized_pct(self) -> float:
        return self.sigma_hourly * math.sqrt(24 * 365) * 100


class DailyBtcProbabilityModel:
    """
    Probability model for BTC daily up/down markets.

    Example:
        model = DailyBtcProbabilityModel()
        model.refresh_volatility()
        r = model.prob_up_now(strike=62_500.0, spot=63_100.0)
        print(r.summary())
    """

    def __init__(
        self,
        symbol: str = "BTCUSDT",
        mu_hourly: Optional[float] = None,
        sigma_hourly: Optional[float] = None,
        ewma_span: int = 72,
        vol_lookback_hours: int = 168,
    ):
        self.symbol = symbol.upper()
        self.mu_hourly = DEFAULT_MU_HOURLY if mu_hourly is None else mu_hourly
        self.sigma_hourly = DEFAULT_SIGMA_HOURLY if sigma_hourly is None else sigma_hourly
        self.ewma_span = ewma_span
        self.vol_lookback_hours = vol_lookback_hours
        self._vol: Optional[VolEstimate] = None
        self._vol_fetched_at: float = 0.0

    def refresh_volatility(self, force: bool = False, cache_sec: float = 300.0) -> VolEstimate:
        """Pull recent 1h Binance closes and update mu/sigma."""
        now = time.time()
        if (
            not force
            and self._vol is not None
            and (now - self._vol_fetched_at) < cache_sec
        ):
            return self._vol

        try:
            closes = fetch_binance_hourly_closes(
                self.symbol, limit=self.vol_lookback_hours
            )
            mu, sigma = estimate_sigma_hourly(
                closes, use_ewma=True, ewma_span=self.ewma_span
            )
            self.mu_hourly = mu
            self.sigma_hourly = sigma
            n = len(log_returns(closes))
            self._vol = VolEstimate(
                mu_hourly=mu,
                sigma_hourly=sigma,
                sigma_annualized=sigma * math.sqrt(24 * 365),
                n_returns=n,
            )
        except Exception:
            if self._vol is None:
                self._vol = VolEstimate(
                    mu_hourly=DEFAULT_MU_HOURLY,
                    sigma_hourly=DEFAULT_SIGMA_HOURLY,
                    sigma_annualized=DEFAULT_SIGMA_HOURLY * math.sqrt(24 * 365),
                    n_returns=0,
                    source="default",
                )

        self._vol_fetched_at = now
        return self._vol

    def prob_up(
        self,
        spot: float,
        strike: float,
        time_left_hours: float,
        mu_hourly: Optional[float] = None,
        sigma_hourly: Optional[float] = None,
    ) -> float:
        """P(resolution price > strike) given spot, strike, and time left."""
        mu = self.mu_hourly if mu_hourly is None else mu_hourly
        sigma = self.sigma_hourly if sigma_hourly is None else sigma_hourly
        return gbm_prob_above(spot, strike, time_left_hours, mu, sigma)

    def prob_up_now(
        self,
        strike: float,
        spot: Optional[float] = None,
        now_et: Optional[datetime] = None,
        refresh_vol: bool = False,
    ) -> DailyProbResult:
        """
        Full snapshot: P(Up) to next noon ET using current or supplied spot.

        Args:
            strike: Price-to-beat (previous noon ET Binance close)
            spot: Current BTC price; fetched from Binance if omitted
            now_et: Reference clock (default: now in ET)
            refresh_vol: Re-fetch volatility from Binance
        """
        if refresh_vol:
            self.refresh_volatility(force=True)
        elif self._vol is None:
            self.refresh_volatility()

        if spot is None:
            closes = fetch_binance_hourly_closes(self.symbol, limit=1)
            spot = closes[-1] if closes else strike

        tau_hours, resolution = hours_until_noon_et(now_et)
        p_up = self.prob_up(spot, strike, tau_hours)
        moneyness = (spot / strike - 1.0) * 100.0 if strike > 0 else 0.0

        return DailyProbResult(
            prob_up=p_up,
            prob_down=1.0 - p_up,
            spot=spot,
            strike=strike,
            time_left_hours=tau_hours,
            resolution_et=resolution,
            mu_hourly=self.mu_hourly,
            sigma_hourly=self.sigma_hourly,
            moneyness_pct=moneyness,
        )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Daily BTC up probability from spot, strike, and time to noon ET"
    )
    p.add_argument("--strike", type=float, required=True, help="Price-to-beat (K)")
    p.add_argument("--spot", type=float, default=None, help="Current BTC price (default: Binance)")
    p.add_argument("--hours-left", type=float, default=None, help="Override time to resolution (hours)")
    p.add_argument("--sigma", type=float, default=None, help="Override hourly sigma")
    p.add_argument("--mu", type=float, default=None, help="Override hourly drift")
    p.add_argument("--no-vol-fetch", action="store_true", help="Skip Binance vol estimation")
    return p


def main() -> None:
    args = _build_parser().parse_args()
    model = DailyBtcProbabilityModel(
        sigma_hourly=args.sigma or DEFAULT_SIGMA_HOURLY,
        mu_hourly=args.mu if args.mu is not None else DEFAULT_MU_HOURLY,
    )
    if not args.no_vol_fetch and args.sigma is None:
        vol = model.refresh_volatility(force=True)
        print(
            f"Vol: mu={vol.mu_hourly:.6f}/h  sigma={vol.sigma_hourly:.6f}/h  "
            f"({vol.sigma_annualized * 100:.1f}% ann)  n={vol.n_returns}"
        )

    if args.hours_left is not None:
        spot = args.spot
        if spot is None:
            spot = fetch_binance_hourly_closes(limit=1)[-1]
        p_up = model.prob_up(spot, args.strike, args.hours_left)
        print(f"P(Up)={p_up:.4f}  spot=${spot:,.2f}  strike=${args.strike:,.2f}  tau={args.hours_left:.2f}h")
    else:
        result = model.prob_up_now(strike=args.strike, spot=args.spot)
        print(result.summary())
        print(f"  resolves {result.resolution_et.strftime('%Y-%m-%d %H:%M %Z')}")


if __name__ == "__main__":
    main()
