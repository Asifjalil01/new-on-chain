"""Paper Execution Engine with realistic slippage, fees, gas, and taxes."""

import time
import uuid
from typing import Tuple, Dict, Any, Optional
from onchain_bot.models.types import Position, TokenMetadata, TradeRecord, ExitReason, TokenState


class PaperExecutor:
    def __init__(self, default_dex_fee_percent: float = 0.3):
        self.default_dex_fee_percent = default_dex_fee_percent

    def execute_buy(
        self,
        token: TokenMetadata,
        order_size_usd: float,
        buy_tax_percent: float = 0.0,
        gas_cost_usd: float = 0.25
    ) -> Position:
        """Executes a realistic paper buy order."""
        quoted_price = token.price_usd or 0.001
        liq = token.liquidity_usd or 10000.0

        # Calculate price impact on entry
        half_liq = liq / 2.0
        impact_pct = min(15.0, (order_size_usd / max(half_liq, 1.0)) * 100.0)
        
        # Effective execution price pushes higher due to price impact
        execution_price = quoted_price * (1.0 + impact_pct / 100.0)

        # DEX fee and token tax deduction
        dex_fee_usd = order_size_usd * (self.default_dex_fee_percent / 100.0)
        net_invested_usd = order_size_usd - dex_fee_usd - gas_cost_usd
        
        # Token tax takes a portion of purchased tokens
        tokens_received = (net_invested_usd / execution_price) * (1.0 - buy_tax_percent / 100.0)

        position_id = f"pos_{uuid.uuid4().hex[:12]}"
        now = time.time()

        return Position(
            position_id=position_id,
            chain=token.chain,
            token_address=token.token_address,
            pair_address=token.pair_address,
            symbol=token.symbol,
            name=token.name,
            dex=token.dex_id,
            entry_price_usd=execution_price,
            current_price_usd=execution_price,
            peak_price_usd=execution_price,
            quantity=tokens_received,
            cost_basis_usd=order_size_usd,
            current_value_usd=tokens_received * execution_price,
            entry_timestamp=now,
            peak_profit_percent=0.0,
            current_profit_percent=0.0,
            trailing_tier_label="TIER_0_ENTRY",
            trailing_floor_price_usd=execution_price,
            state=TokenState.POSITION_OPEN,
            gas_spent_usd=gas_cost_usd,
            fees_spent_usd=dex_fee_usd,
            last_update_timestamp=now
        )

    def execute_sell(
        self,
        position: Position,
        exit_price_quoted: float,
        exit_reason: ExitReason,
        sell_tax_percent: float = 0.0,
        gas_cost_usd: float = 0.25
    ) -> TradeRecord:
        """Executes a realistic paper sell order and computes net P&L."""
        now = time.time()
        gross_value = position.quantity * exit_price_quoted

        # Slippage / price impact on exit
        impact_pct = 0.5  # standard baseline for exit
        actual_exit_price = exit_price_quoted * (1.0 - impact_pct / 100.0)
        realized_gross = position.quantity * actual_exit_price

        # Deduct exit DEX fee and token tax
        dex_fees_usd = realized_gross * (self.default_dex_fee_percent / 100.0)
        token_tax_usd = realized_gross * (sell_tax_percent / 100.0)
        total_gas_usd = position.gas_spent_usd + gas_cost_usd

        net_proceeds = realized_gross - dex_fees_usd - token_tax_usd - gas_cost_usd
        net_pnl_usd = net_proceeds - position.cost_basis_usd
        net_pnl_percent = (net_pnl_usd / position.cost_basis_usd) * 100.0

        trade_id = f"trd_{uuid.uuid4().hex[:12]}"
        holding_seconds = now - position.entry_timestamp

        return TradeRecord(
            trade_id=trade_id,
            chain=position.chain,
            token_address=position.token_address,
            pair_address=position.pair_address,
            symbol=position.symbol,
            dex=position.dex,
            entry_timestamp=position.entry_timestamp,
            exit_timestamp=now,
            entry_price_usd=position.entry_price_usd,
            exit_price_usd=actual_exit_price,
            quantity=position.quantity,
            cost_basis_usd=position.cost_basis_usd,
            gross_proceeds_usd=realized_gross,
            gas_cost_usd=total_gas_usd,
            dex_fees_usd=position.fees_spent_usd + dex_fees_usd,
            token_taxes_usd=token_tax_usd,
            net_pnl_usd=round(net_pnl_usd, 4),
            net_pnl_percent=round(net_pnl_percent, 2),
            peak_profit_percent=round(position.peak_profit_percent, 2),
            exit_reason=exit_reason,
            holding_seconds=round(holding_seconds, 1),
            tx_hash_buy=f"paper_buy_{position.position_id}",
            tx_hash_sell=f"paper_sell_{trade_id}"
        )
