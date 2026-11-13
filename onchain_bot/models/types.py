"""Core data types, enums, and data models for On-Chain SPOT Bot v2."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Any


class ExecutionMode(str, Enum):
    PAPER = "paper"
    TESTNET = "testnet"
    MAINNET = "mainnet"


class TokenState(str, Enum):
    DISCOVERED = "DISCOVERED"
    ANALYZING = "ANALYZING"
    SECURITY_CHECK = "SECURITY_CHECK"
    WATCHLIST = "WATCHLIST"
    BUY_CANDIDATE = "BUY_CANDIDATE"
    BUY_APPROVED = "BUY_APPROVED"
    POSITION_OPEN = "POSITION_OPEN"
    HOLDING = "HOLDING"
    PROFIT_MONITORING = "PROFIT_MONITORING"
    RECOVERY_WATCH = "RECOVERY_WATCH"
    EXIT_CANDIDATE = "EXIT_CANDIDATE"
    SOLD = "SOLD"
    COOLDOWN = "COOLDOWN"
    REJECTED = "REJECTED"
    RUG_RISK = "RUG_RISK"
    HONEYPOT = "HONEYPOT"
    INSUFFICIENT_LIQUIDITY = "INSUFFICIENT_LIQUIDITY"
    DUST = "DUST"
    STALE = "STALE"
    DATA_UNAVAILABLE = "DATA_UNAVAILABLE"


class SecurityVerdict(str, Enum):
    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    UNAVAILABLE = "UNAVAILABLE"


class ExitReason(str, Enum):
    TRAILING_PROFIT = "TRAILING_PROFIT"
    MARKET_STRUCTURE = "MARKET_STRUCTURE"
    MANUAL_SELL = "MANUAL_SELL"
    BREAKEVEN_RECOVERY = "BREAKEVEN_RECOVERY"
    EMERGENCY_RUG = "EMERGENCY_RUG"
    EMERGENCY_HONEYPOT = "EMERGENCY_HONEYPOT"
    EMERGENCY_LIQUIDITY_DRAIN = "EMERGENCY_LIQUIDITY_DRAIN"
    EMERGENCY_TRADING_DISABLED = "EMERGENCY_TRADING_DISABLED"
    EMERGENCY_OWNER_TAKEOVER = "EMERGENCY_OWNER_TAKEOVER"


class TokenClassifier(str, Enum):
    ESTABLISHED_BLUECHIP = "ESTABLISHED_BLUECHIP"
    MID_CAP_GROWTH = "MID_CAP_GROWTH"
    EARLY_STAGE_INNOVATION = "EARLY_STAGE_INNOVATION"
    MEME_COMMUNITY = "MEME_COMMUNITY"
    HIGH_RISK_MICRO = "HIGH_RISK_MICRO"


@dataclass
class LayerResult:
    layer_id: str
    verdict: SecurityVerdict
    score: float  # 0 to 100
    reason_code: str
    details: str
    timestamp: float = field(default_factory=lambda: datetime.utcnow().timestamp())


@dataclass
class SecurityReport:
    chain: str
    token_address: str
    pair_address: str
    overall_verdict: SecurityVerdict
    security_score: float  # 0 to 100, 0 if any critical flag
    buy_tax_percent: Optional[float] = None
    sell_tax_percent: Optional[float] = None
    is_honeypot: Optional[bool] = None
    mint_authority_revoked: Optional[bool] = None
    freeze_authority_revoked: Optional[bool] = None
    lp_locked_or_burned: Optional[bool] = None
    lp_lock_duration_days: Optional[float] = None
    lp_burned_percent: Optional[float] = None
    top10_holder_percent: Optional[float] = None
    deployer_address: Optional[str] = None
    deployer_risk_score: float = 0.0
    layer_results: Dict[str, LayerResult] = field(default_factory=dict)
    rejection_reasons: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    timestamp: float = field(default_factory=lambda: datetime.utcnow().timestamp())


@dataclass
class TokenMetadata:
    chain: str
    token_address: str
    pair_address: str
    symbol: str
    name: str
    decimals: int = 18
    dex_id: str = "dex"
    base_symbol: Optional[str] = None
    quote_symbol: Optional[str] = None
    price_usd: Optional[float] = None
    liquidity_usd: Optional[float] = None
    fdv_usd: Optional[float] = None
    market_cap_usd: Optional[float] = None
    volume_24h_usd: Optional[float] = None
    txns_24h_buys: Optional[int] = None
    txns_24h_sells: Optional[int] = None
    price_change_1h: Optional[float] = None
    price_change_24h: Optional[float] = None
    pair_created_at_ms: Optional[int] = None
    holders_count: Optional[int] = None
    first_seen_at: float = field(default_factory=lambda: datetime.utcnow().timestamp())
    last_scanned_at: float = field(default_factory=lambda: datetime.utcnow().timestamp())
    tier: int = 0
    state: TokenState = TokenState.DISCOVERED


@dataclass
class StrategyEvaluation:
    chain: str
    token_address: str
    pair_address: str
    quality_score: float  # 0 to 100
    trade_score: float    # 0 to 100
    classifier: TokenClassifier
    is_buy_approved: bool
    reasons: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    recommended_size_usd: float = 0.0
    timestamp: float = field(default_factory=lambda: datetime.utcnow().timestamp())


@dataclass
class Position:
    position_id: str
    chain: str
    token_address: str
    pair_address: str
    symbol: str
    name: str
    dex: str
    entry_price_usd: float
    current_price_usd: float
    peak_price_usd: float
    quantity: float
    cost_basis_usd: float
    current_value_usd: float
    entry_timestamp: float
    peak_profit_percent: float = 0.0
    current_profit_percent: float = 0.0
    trailing_tier_label: str = "TIER_0_ENTRY"
    trailing_floor_price_usd: float = 0.0
    state: TokenState = TokenState.POSITION_OPEN
    gas_spent_usd: float = 0.0
    fees_spent_usd: float = 0.0
    last_update_timestamp: float = field(default_factory=lambda: datetime.utcnow().timestamp())


@dataclass
class TradeRecord:
    trade_id: str
    chain: str
    token_address: str
    pair_address: str
    symbol: str
    dex: str
    entry_timestamp: float
    exit_timestamp: float
    entry_price_usd: float
    exit_price_usd: float
    quantity: float
    cost_basis_usd: float
    gross_proceeds_usd: float
    gas_cost_usd: float
    dex_fees_usd: float
    token_taxes_usd: float
    net_pnl_usd: float
    net_pnl_percent: float
    peak_profit_percent: float
    exit_reason: ExitReason
    holding_seconds: float
    tx_hash_buy: Optional[str] = None
    tx_hash_sell: Optional[str] = None
