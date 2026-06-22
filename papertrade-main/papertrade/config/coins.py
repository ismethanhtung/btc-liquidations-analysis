"""
Coin Configuration for Live Trading System

Defines supported coins and their Binance/Polymarket symbols.
"""

from dataclasses import dataclass
from typing import Dict


@dataclass
class CoinConfig:
    """Configuration for a single coin."""
    name: str  # Display name (e.g., "BTC")
    symbol: str  # Binance symbol (e.g., "BTCUSDT")
    polymarket_search: str  # Search term for Polymarket (e.g., "BTC")
    min_price: float  # Minimum expected price (for validation)
    max_price: float  # Maximum expected price (for validation)


# Supported coins configuration
COINS: Dict[str, CoinConfig] = {
    'btc': CoinConfig(
        name='BTC',
        symbol='BTCUSDT',
        polymarket_search='BTC',
        min_price=10000,
        max_price=200000
    ),
    'eth': CoinConfig(
        name='ETH',
        symbol='ETHUSDT',
        polymarket_search='ETH',
        min_price=1000,
        max_price=10000
    ),
    'sol': CoinConfig(
        name='SOL',
        symbol='SOLUSDT',
        polymarket_search='SOL',
        min_price=10,
        max_price=500
    ),
    'xrp': CoinConfig(
        name='XRP',
        symbol='XRPUSDT',
        polymarket_search='XRP',
        min_price=0.1,
        max_price=10
    ),
}


def get_coin_config(coin_id: str) -> CoinConfig:
    """Get configuration for a coin."""
    coin_id = coin_id.lower()
    if coin_id not in COINS:
        raise ValueError(f"Unsupported coin: {coin_id}. Supported: {list(COINS.keys())}")
    return COINS[coin_id]


def list_supported_coins() -> list:
    """List all supported coin IDs."""
    return list(COINS.keys())




