"""Configuration and settings manager for On-Chain SPOT Bot v2."""

import os
import json
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Tuple, Any, Optional

CHAIN_ALIASES = {
    "sol": "solana",
    "solona": "solana",
    "solana": "solana",
    "eth": "ethereum",
    "etherium": "ethereum",
    "ethereum": "ethereum",
    "bnb": "bsc",
    "binance": "bsc",
    "bsc": "bsc",
    "base": "base",
    "arb": "arbitrum",
    "arbitrum": "arbitrum",
    "poly": "polygon",
    "matic": "polygon",
    "polygon": "polygon",
    "avax": "avalanche",
    "avalanche": "avalanche",
    "op": "optimism",
    "optimism": "optimism",
}

SUPPORTED_CHAINS = [
    "solana",
    "ethereum",
    "bsc",
    "base",
    "arbitrum",
    "polygon",
    "avalanche",
    "optimism",
]

DEFAULT_TRAILING_TIERS: List[Tuple[float, float]] = [
    (20.0, 1.0),
    (40.0, 2.0),
    (60.0, 3.0),
    (80.0, 4.0),
    (100.0, 5.0),
    (150.0, 8.0),
    (200.0, 10.0),
    (300.0, 15.0),
    (400.0, 20.0),
    (500.0, 25.0),
    (700.0, 30.0),
    (1000.0, 40.0),
]


def normalize_chain(name: str) -> str:
    """Shared single normalize function for chain names and aliases."""
    if not name or not isinstance(name, str):
        raise ValueError(f"Invalid chain name: {name}")
    cleaned = name.strip().lower()
    if cleaned in CHAIN_ALIASES:
        return CHAIN_ALIASES[cleaned]
    if cleaned in SUPPORTED_CHAINS:
        return cleaned
    raise ValueError(f"Unsupported blockchain: {name}. Supported: {', '.join(SUPPORTED_CHAINS)}")


@dataclass
class BotConfig:
    APP_NAME: str = "On-Chain SPOT Bot v2"
    DEFAULT_CHAIN: str = "solana"
    EXECUTION_MODE: str = "paper"  # paper | testnet | mainnet
    TOTAL_CAPITAL_USD: float = 1000.0
    MAX_POSITIONS: int = 5
    MAX_POSITION_SIZE_USD: float = 100.0
    SELL_COOLDOWN_MINUTES: int = 60
    MIN_PRICE_USD: float = 0.00000001
    MAX_PRICE_USD: float = 100000.0
    WATCH_NEW_PAIRS: bool = True
    ENABLE_LIVE_MARKET_DATA: bool = True
    MIN_LIQUIDITY_USD: float = 5000.0
    MIN_24H_VOLUME_USD: float = 2000.0
    MAX_BUY_TAX_PERCENT: float = 3.0
    MAX_SELL_TAX_PERCENT: float = 3.0
    MIN_QUALITY_SCORE: float = 75.0
    MIN_TRADE_SCORE: float = 70.0
    THEME: str = "dark"  # dark | light
    TRAILING_TIERS: List[Tuple[float, float]] = field(default_factory=lambda: list(DEFAULT_TRAILING_TIERS))
    RPC_URLS: Dict[str, str] = field(default_factory=lambda: {
        "solana": "https://api.mainnet-beta.solana.com",
        "ethereum": "https://cloudflare-eth.com",
        "bsc": "https://binance.llamarpc.com",
        "base": "https://mainnet.base.org",
        "arbitrum": "https://arb1.arbitrum.io/rpc",
        "polygon": "https://polygon-rpc.com",
        "avalanche": "https://api.avax.network/ext/bc/C/rpc",
        "optimism": "https://mainnet.optimism.io",
    })

    def validate(self) -> None:
        """Atomic validation of all configuration parameters."""
        if not self.APP_NAME or not isinstance(self.APP_NAME, str):
            raise ValueError("APP_NAME must be a non-empty string")
        
        self.DEFAULT_CHAIN = normalize_chain(self.DEFAULT_CHAIN)

        if self.EXECUTION_MODE not in ["paper", "testnet", "mainnet"]:
            raise ValueError(f"Invalid EXECUTION_MODE: {self.EXECUTION_MODE}")

        if not isinstance(self.TOTAL_CAPITAL_USD, (int, float)) or self.TOTAL_CAPITAL_USD <= 0:
            raise ValueError("TOTAL_CAPITAL_USD must be positive")

        if not isinstance(self.MAX_POSITIONS, int) or self.MAX_POSITIONS < 1 or self.MAX_POSITIONS > 100:
            raise ValueError("MAX_POSITIONS must be an integer between 1 and 100")

        if not isinstance(self.MAX_POSITION_SIZE_USD, (int, float)) or self.MAX_POSITION_SIZE_USD <= 0:
            raise ValueError("MAX_POSITION_SIZE_USD must be positive")

        if self.MAX_POSITION_SIZE_USD > self.TOTAL_CAPITAL_USD:
            raise ValueError("MAX_POSITION_SIZE_USD cannot exceed TOTAL_CAPITAL_USD")

        if not isinstance(self.SELL_COOLDOWN_MINUTES, int) or self.SELL_COOLDOWN_MINUTES < 0:
            raise ValueError("SELL_COOLDOWN_MINUTES must be >= 0")

        if self.MIN_PRICE_USD <= 0 or self.MAX_PRICE_USD <= self.MIN_PRICE_USD:
            raise ValueError("Invalid price bounds: MIN_PRICE_USD must be > 0 and < MAX_PRICE_USD")

        if not self.TRAILING_TIERS or len(self.TRAILING_TIERS) == 0:
            raise ValueError("TRAILING_TIERS cannot be empty")

        for peak, drop in self.TRAILING_TIERS:
            if drop >= peak:
                raise ValueError(f"Invalid trailing tier: drop ({drop}%) cannot exceed peak ({peak}%)")


class ConfigManager:
    """Manages loading, validation, and atomic saving of bot configuration."""

    def __init__(self, config_path: str = "config.json"):
        self.config_path = config_path
        self.config = BotConfig()
        self.load()

    def load(self) -> BotConfig:
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                # Never overwrite a valid setting with empty string
                clean_data = {}
                for k, v in data.items():
                    if v is not None and v != "":
                        clean_data[k] = v

                # Convert trailing tiers if list of lists
                if "TRAILING_TIERS" in clean_data:
                    clean_data["TRAILING_TIERS"] = [
                        (float(item[0]), float(item[1])) for item in clean_data["TRAILING_TIERS"]
                    ]

                test_config = BotConfig(**{k: v for k, v in clean_data.items() if hasattr(self.config, k)})
                test_config.validate()
                self.config = test_config
            except Exception as e:
                # Do not silently fall back to bad config; log or re-raise if fatal
                print(f"[ConfigManager] Warning loading {self.config_path}: {e}. Retaining validated defaults.")
        
        # Check env overrides
        self._load_env_overrides()
        self.config.validate()
        return self.config

    def _load_env_overrides(self) -> None:
        if os.getenv("EXECUTION_MODE"):
            self.config.EXECUTION_MODE = os.environ["EXECUTION_MODE"].lower()
        if os.getenv("DEFAULT_CHAIN"):
            self.config.DEFAULT_CHAIN = normalize_chain(os.environ["DEFAULT_CHAIN"])
        if os.getenv("TOTAL_CAPITAL_USD"):
            try:
                self.config.TOTAL_CAPITAL_USD = float(os.environ["TOTAL_CAPITAL_USD"])
            except ValueError:
                pass

    def save_atomic(self, new_settings: Dict[str, Any]) -> bool:
        """Atomic save: only writes to disk if entire payload validates."""
        current_dict = asdict(self.config)
        # Apply updates carefully without empty string overrides
        candidate_dict = dict(current_dict)
        for k, v in new_settings.items():
            if hasattr(self.config, k) and v is not None and v != "":
                candidate_dict[k] = v

        if "TRAILING_TIERS" in candidate_dict:
            candidate_dict["TRAILING_TIERS"] = [
                (float(item[0]), float(item[1])) for item in candidate_dict["TRAILING_TIERS"]
            ]

        candidate = BotConfig(**candidate_dict)
        candidate.validate()  # raises ValueError if invalid

        temp_path = f"{self.config_path}.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(asdict(candidate), f, indent=2)
        os.replace(temp_path, self.config_path)
        self.config = candidate
        return True
