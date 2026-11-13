-- SQLite Database Schema for On-Chain SPOT Bot v2

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Universe registry: all discovered tokens/pairs across chains
CREATE TABLE IF NOT EXISTS universe (
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    dex TEXT,
    tier INTEGER DEFAULT 0,
    state TEXT DEFAULT 'DISCOVERED',
    source TEXT DEFAULT 'dexscreener',
    priority INTEGER DEFAULT 10,
    first_seen_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    last_scanned_at REAL,
    next_scan_due REAL,
    reason_code TEXT,
    PRIMARY KEY (chain, token_address, pair_address)
);

CREATE INDEX IF NOT EXISTS idx_universe_scan ON universe(chain, state, next_scan_due, priority);
CREATE INDEX IF NOT EXISTS idx_universe_token ON universe(chain, token_address);

-- Token details
CREATE TABLE IF NOT EXISTS tokens (
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    decimals INTEGER DEFAULT 18,
    deployer_address TEXT,
    first_seen_at REAL NOT NULL,
    is_whitelisted INTEGER DEFAULT 0,
    is_blacklisted INTEGER DEFAULT 0,
    PRIMARY KEY (chain, token_address)
);

-- Liquidity Pools
CREATE TABLE IF NOT EXISTS pools (
    chain TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    base_token TEXT NOT NULL,
    quote_token TEXT NOT NULL,
    dex_id TEXT,
    liquidity_usd REAL,
    created_at_ms INTEGER,
    last_updated_at REAL,
    PRIMARY KEY (chain, pair_address)
);

-- Market Snapshots (historical record for multi-timeframe analysis)
CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    price_usd REAL NOT NULL,
    liquidity_usd REAL,
    volume_24h_usd REAL,
    buy_txns INTEGER,
    sell_txns INTEGER,
    price_change_1h REAL,
    price_change_24h REAL,
    timestamp REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_token ON market_snapshots(chain, token_address, timestamp);

-- Security Results (audit trail of all Rug Defense L1-L9 checks)
CREATE TABLE IF NOT EXISTS security_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    overall_verdict TEXT NOT NULL,
    security_score REAL NOT NULL,
    buy_tax_percent REAL,
    sell_tax_percent REAL,
    is_honeypot INTEGER,
    mint_authority_revoked INTEGER,
    freeze_authority_revoked INTEGER,
    lp_locked_or_burned INTEGER,
    top10_holder_percent REAL,
    deployer_risk_score REAL,
    details_json TEXT,
    timestamp REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_token ON security_results(chain, token_address);

-- Strategy Signals
CREATE TABLE IF NOT EXISTS strategy_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    quality_score REAL NOT NULL,
    trade_score REAL NOT NULL,
    classifier TEXT,
    is_buy_approved INTEGER,
    reasons_json TEXT,
    timestamp REAL NOT NULL
);

-- Active Positions
CREATE TABLE IF NOT EXISTS positions (
    position_id TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    dex TEXT,
    entry_price_usd REAL NOT NULL,
    current_price_usd REAL NOT NULL,
    peak_price_usd REAL NOT NULL,
    quantity REAL NOT NULL,
    cost_basis_usd REAL NOT NULL,
    current_value_usd REAL NOT NULL,
    peak_profit_percent REAL DEFAULT 0.0,
    current_profit_percent REAL DEFAULT 0.0,
    trailing_tier_label TEXT,
    trailing_floor_price_usd REAL DEFAULT 0.0,
    state TEXT DEFAULT 'POSITION_OPEN',
    gas_spent_usd REAL DEFAULT 0.0,
    fees_spent_usd REAL DEFAULT 0.0,
    entry_timestamp REAL NOT NULL,
    last_update_timestamp REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_token ON positions(chain, token_address, pair_address);

-- Closed Trades (history)
CREATE TABLE IF NOT EXISTS trades (
    trade_id TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    symbol TEXT NOT NULL,
    dex TEXT,
    entry_timestamp REAL NOT NULL,
    exit_timestamp REAL NOT NULL,
    entry_price_usd REAL NOT NULL,
    exit_price_usd REAL NOT NULL,
    quantity REAL NOT NULL,
    cost_basis_usd REAL NOT NULL,
    gross_proceeds_usd REAL NOT NULL,
    gas_cost_usd REAL NOT NULL,
    dex_fees_usd REAL NOT NULL,
    token_taxes_usd REAL NOT NULL,
    net_pnl_usd REAL NOT NULL,
    net_pnl_percent REAL NOT NULL,
    peak_profit_percent REAL NOT NULL,
    exit_reason TEXT NOT NULL,
    holding_seconds REAL NOT NULL,
    tx_hash_buy TEXT,
    tx_hash_sell TEXT
);

-- Transactions Log
CREATE TABLE IF NOT EXISTS transactions (
    tx_hash TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    token_address TEXT,
    tx_type TEXT NOT NULL, -- BUY, SELL, CANARY_BUY, CANARY_SELL, APPROVE
    status TEXT NOT NULL,  -- PENDING, CONFIRMED, FAILED
    amount_usd REAL,
    gas_used REAL,
    gas_cost_usd REAL,
    timestamp REAL NOT NULL
);

-- Wallet Balances
CREATE TABLE IF NOT EXISTS wallet_balances (
    chain TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    native_balance REAL NOT NULL,
    native_symbol TEXT NOT NULL,
    usd_value REAL,
    last_updated_at REAL NOT NULL,
    PRIMARY KEY (chain, wallet_address)
);

-- System & Audit Events
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL, -- INFO, WARNING, ERROR, CRITICAL
    message TEXT NOT NULL,
    details_json TEXT,
    timestamp REAL NOT NULL
);

-- Blacklist and Whitelist
CREATE TABLE IF NOT EXISTS blacklist (
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    reason TEXT,
    added_at REAL NOT NULL,
    PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS whitelist (
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    note TEXT,
    added_at REAL NOT NULL,
    PRIMARY KEY (chain, address)
);

-- Scan Checkpoints (for resumable discovery)
CREATE TABLE IF NOT EXISTS scan_checkpoints (
    chain TEXT NOT NULL,
    source TEXT NOT NULL,
    cursor_value TEXT,
    last_block INTEGER,
    updated_at REAL NOT NULL,
    PRIMARY KEY (chain, source)
);

-- Rug Defense Outcomes (Tracks post-screening rug events to measure accuracy)
CREATE TABLE IF NOT EXISTS rug_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT,
    screening_verdict TEXT NOT NULL,
    screening_timestamp REAL NOT NULL,
    did_rug INTEGER DEFAULT 0,
    rug_type TEXT,
    detected_at REAL,
    post_mortem_notes TEXT
);
