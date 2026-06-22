"""
Polymarket **taker BUY** fee schedule and helpers.

Primary source: Polymarket fee curve (USDC fee for 100 shares at each price).
Values below match the published schedule (trade value = 100 × price).
"""

from __future__ import annotations

# (price, fee USDC for 100 shares at that price)
TAKER_FEE_CURVE: tuple[tuple[float, float], ...] = (
    (0.01, 0.07),
    (0.05, 0.33),
    (0.10, 0.63),
    (0.15, 0.89),
    (0.20, 1.12),
    (0.25, 1.31),
    (0.30, 1.47),
    (0.35, 1.59),
    (0.40, 1.68),
    (0.45, 1.73),
    (0.50, 1.75),
    (0.55, 1.73),
    (0.60, 1.68),
    (0.65, 1.59),
    (0.70, 1.47),
    (0.75, 1.31),
    (0.80, 1.12),
    (0.85, 0.89),
    (0.90, 0.63),
    (0.95, 0.33),
    (0.99, 0.07),
)

PAPER_FEE_RATE_AT_MID = 0.035  # legacy approx: fee/notional at p=0.5 (~3.5%)


def _interpolate_fee_for_100_shares(price: float) -> float:
    """Linear interpolation on TAKER_FEE_CURVE; fee USDC for 100 shares."""
    p = max(TAKER_FEE_CURVE[0][0], min(TAKER_FEE_CURVE[-1][0], float(price)))
    if p <= TAKER_FEE_CURVE[0][0]:
        return TAKER_FEE_CURVE[0][1]
    if p >= TAKER_FEE_CURVE[-1][0]:
        return TAKER_FEE_CURVE[-1][1]
    for i in range(1, len(TAKER_FEE_CURVE)):
        p0, f0 = TAKER_FEE_CURVE[i - 1]
        p1, f1 = TAKER_FEE_CURVE[i]
        if p <= p1:
            if p1 <= p0:
                return f1
            w = (p - p0) / (p1 - p0)
            return f0 + (f1 - f0) * w
    return 0.0


def taker_fee_usdc(price: float, shares: float) -> float:
    """Taker fee (USDC) from the Polymarket schedule; scales linearly with shares."""
    if shares <= 0 or price <= 0 or price >= 1:
        return 0.0
    fee_100 = _interpolate_fee_for_100_shares(price)
    return fee_100 * (float(shares) / 100.0)


def taker_fee_per_share(price: float) -> float:
    """Fee USDC for 1 share at price — parabolic; equal at p and (1−p) extremes."""
    return taker_fee_usdc(price, 1.0)


def taker_fee_on_notional(price: float, notional_usd: float = 1.0) -> float:
    """Taker fee (USDC) for a buy with given USDC notional at price."""
    if notional_usd <= 0 or price <= 0 or price >= 1:
        return 0.0
    return taker_fee_usdc(price, notional_usd / price)


def polymarket_fee(price: float, shares: float) -> float:
    """Taker-side fee from the Polymarket fee curve."""
    return taker_fee_usdc(price, shares)
