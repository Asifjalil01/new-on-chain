"""SQLite Repository and database manager with WAL mode and thread safety."""

import sqlite3
import json
import os
from typing import List, Dict, Optional, Any, Tuple
from onchain_bot.models.types import (
    Position, TradeRecord, SecurityReport, TokenMetadata,
    TokenState, ExitReason, SecurityVerdict
)


class DatabaseRepository:
    def __init__(self, db_path: str = "data/onchain_bot.db"):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self.init_schema()

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn

    def init_schema(self) -> None:
        schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
        if os.path.exists(schema_path):
            with open(schema_path, "r", encoding="utf-8") as f:
                schema_sql = f.read()
            with self.get_connection() as conn:
                conn.executescript(schema_sql)

    # ---------------- Universe ----------------
    def upsert_universe(self, token: TokenMetadata) -> None:
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO universe (
                    chain, token_address, pair_address, symbol, name, dex,
                    tier, state, first_seen_at, last_seen_at, last_scanned_at, next_scan_due
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(chain, token_address, pair_address) DO UPDATE SET
                    symbol = excluded.symbol,
                    name = excluded.name,
                    dex = excluded.dex,
                    tier = excluded.tier,
                    state = excluded.state,
                    last_seen_at = excluded.last_seen_at,
                    last_scanned_at = excluded.last_scanned_at,
                    next_scan_due = excluded.next_scan_due;
            """, (
                token.chain, token.token_address, token.pair_address, token.symbol, token.name,
                token.dex_id, token.tier, token.state.value, token.first_seen_at,
                token.last_scanned_at, token.last_scanned_at, token.last_scanned_at + 60
            ))

    def get_universe_paged(
        self,
        offset: int = 0,
        limit: int = 100,
        chain: Optional[str] = None,
        state: Optional[str] = None,
        search: Optional[str] = None
    ) -> Tuple[List[Dict[str, Any]], int]:
        query = "SELECT * FROM universe WHERE 1=1"
        count_query = "SELECT COUNT(*) as total FROM universe WHERE 1=1"
        params: List[Any] = []

        if chain and chain.lower() != "all":
            query += " AND chain = ?"
            count_query += " AND chain = ?"
            params.append(chain.lower())

        if state and state.upper() != "ALL":
            query += " AND state = ?"
            count_query += " AND state = ?"
            params.append(state.upper())

        if search:
            query += " AND (symbol LIKE ? OR token_address LIKE ?)"
            count_query += " AND (symbol LIKE ? OR token_address LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%"])

        query += " ORDER BY priority ASC, last_scanned_at DESC LIMIT ? OFFSET ?"
        
        with self.get_connection() as conn:
            total = conn.execute(count_query, params).fetchone()["total"]
            rows = conn.execute(query, params + [limit, offset]).fetchall()
            return [dict(r) for r in rows], total

    def get_universe_category_counts(self) -> Dict[str, int]:
        with self.get_connection() as conn:
            rows = conn.execute("SELECT state, COUNT(*) as cnt FROM universe GROUP BY state").fetchall()
            counts = {
                "ALL": 0, "BUY": 0, "WATCH": 0, "WAIT": 0, "REJECT": 0,
                "RUG RISK": 0, "HONEYPOT": 0, "POSITION": 0, "COOLDOWN": 0
            }
            total = 0
            for r in rows:
                st = r["state"]
                cnt = r["cnt"]
                total += cnt
                if st in ["BUY_CANDIDATE", "BUY_APPROVED"]:
                    counts["BUY"] += cnt
                elif st in ["WATCHLIST"]:
                    counts["WATCH"] += cnt
                elif st in ["ANALYZING", "SECURITY_CHECK"]:
                    counts["WAIT"] += cnt
                elif st in ["REJECTED", "INSUFFICIENT_LIQUIDITY"]:
                    counts["REJECT"] += cnt
                elif st in ["RUG_RISK"]:
                    counts["RUG RISK"] += cnt
                elif st in ["HONEYPOT"]:
                    counts["HONEYPOT"] += cnt
                elif st in ["POSITION_OPEN", "PROFIT_MONITORING", "RECOVERY_WATCH", "EXIT_CANDIDATE"]:
                    counts["POSITION"] += cnt
                elif st in ["COOLDOWN"]:
                    counts["COOLDOWN"] += cnt
            counts["ALL"] = total
            return counts

    # ---------------- Positions ----------------
    def save_position(self, pos: Position) -> None:
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO positions (
                    position_id, chain, token_address, pair_address, symbol, name, dex,
                    entry_price_usd, current_price_usd, peak_price_usd, quantity,
                    cost_basis_usd, current_value_usd, peak_profit_percent,
                    current_profit_percent, trailing_tier_label, trailing_floor_price_usd,
                    state, gas_spent_usd, fees_spent_usd, entry_timestamp, last_update_timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(position_id) DO UPDATE SET
                    current_price_usd = excluded.current_price_usd,
                    peak_price_usd = excluded.peak_price_usd,
                    current_value_usd = excluded.current_value_usd,
                    peak_profit_percent = excluded.peak_profit_percent,
                    current_profit_percent = excluded.current_profit_percent,
                    trailing_tier_label = excluded.trailing_tier_label,
                    trailing_floor_price_usd = excluded.trailing_floor_price_usd,
                    state = excluded.state,
                    last_update_timestamp = excluded.last_update_timestamp;
            """, (
                pos.position_id, pos.chain, pos.token_address, pos.pair_address, pos.symbol,
                pos.name, pos.dex, pos.entry_price_usd, pos.current_price_usd, pos.peak_price_usd,
                pos.quantity, pos.cost_basis_usd, pos.current_value_usd, pos.peak_profit_percent,
                pos.current_profit_percent, pos.trailing_tier_label, pos.trailing_floor_price_usd,
                pos.state.value, pos.gas_spent_usd, pos.fees_spent_usd, pos.entry_timestamp,
                pos.last_update_timestamp
            ))

    def get_open_positions(self) -> List[Position]:
        with self.get_connection() as conn:
            rows = conn.execute("SELECT * FROM positions WHERE state NOT IN ('SOLD')").fetchall()
            result = []
            for r in rows:
                result.append(Position(
                    position_id=r["position_id"],
                    chain=r["chain"],
                    token_address=r["token_address"],
                    pair_address=r["pair_address"],
                    symbol=r["symbol"],
                    name=r["name"],
                    dex=r["dex"],
                    entry_price_usd=r["entry_price_usd"],
                    current_price_usd=r["current_price_usd"],
                    peak_price_usd=r["peak_price_usd"],
                    quantity=r["quantity"],
                    cost_basis_usd=r["cost_basis_usd"],
                    current_value_usd=r["current_value_usd"],
                    entry_timestamp=r["entry_timestamp"],
                    peak_profit_percent=r["peak_profit_percent"],
                    current_profit_percent=r["current_profit_percent"],
                    trailing_tier_label=r["trailing_tier_label"] or "TIER_0",
                    trailing_floor_price_usd=r["trailing_floor_price_usd"],
                    state=TokenState(r["state"]),
                    gas_spent_usd=r["gas_spent_usd"],
                    fees_spent_usd=r["fees_spent_usd"],
                    last_update_timestamp=r["last_update_timestamp"]
                ))
            return result

    def close_position(self, position_id: str) -> None:
        with self.get_connection() as conn:
            conn.execute("UPDATE positions SET state = 'SOLD' WHERE position_id = ?", (position_id,))

    # ---------------- Trades ----------------
    def record_trade(self, trade: TradeRecord) -> None:
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO trades (
                    trade_id, chain, token_address, pair_address, symbol, dex,
                    entry_timestamp, exit_timestamp, entry_price_usd, exit_price_usd,
                    quantity, cost_basis_usd, gross_proceeds_usd, gas_cost_usd,
                    dex_fees_usd, token_taxes_usd, net_pnl_usd, net_pnl_percent,
                    peak_profit_percent, exit_reason, holding_seconds, tx_hash_buy, tx_hash_sell
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                trade.trade_id, trade.chain, trade.token_address, trade.pair_address, trade.symbol,
                trade.dex, trade.entry_timestamp, trade.exit_timestamp, trade.entry_price_usd,
                trade.exit_price_usd, trade.quantity, trade.cost_basis_usd, trade.gross_proceeds_usd,
                trade.gas_cost_usd, trade.dex_fees_usd, trade.token_taxes_usd, trade.net_pnl_usd,
                trade.net_pnl_percent, trade.peak_profit_percent, trade.exit_reason.value,
                trade.holding_seconds, trade.tx_hash_buy, trade.tx_hash_sell
            ))

    def get_trades(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            rows = conn.execute("SELECT * FROM trades ORDER BY exit_timestamp DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    # ---------------- Events & Logging ----------------
    def log_event(self, event_type: str, severity: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        import time
        with self.get_connection() as conn:
            conn.execute("""
                INSERT INTO events (event_type, severity, message, details_json, timestamp)
                VALUES (?, ?, ?, ?, ?)
            """, (event_type, severity, message, json.dumps(details or {}), time.time()))

    def get_recent_events(self, limit: int = 40) -> List[Dict[str, Any]]:
        with self.get_connection() as conn:
            rows = conn.execute("SELECT * FROM events ORDER BY timestamp DESC LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]
