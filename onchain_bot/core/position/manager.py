"""Position Manager: Lifecycle, live price refreshes, trailing stops, and cooldowns."""

import time
from typing import Dict, List, Optional, Tuple
from onchain_bot.models.types import (
    Position, TradeRecord, TokenMetadata, TokenState, ExitReason
)
from onchain_bot.core.position.trailing import evaluate_exit, calculate_trailing_floor
from onchain_bot.core.execution.paper import PaperExecutor


class PositionManager:
    def __init__(self, cooldown_minutes: int = 60, executor: Optional[PaperExecutor] = None):
        self.cooldown_minutes = cooldown_minutes
        self.executor = executor or PaperExecutor()
        self.open_positions: Dict[str, Position] = {}
        # Keyed by (chain, token_address, pair_address)
        self.cooldowns: Dict[Tuple[str, str, str], float] = {}

    def is_in_cooldown(self, chain: str, token_address: str, pair_address: str) -> bool:
        key = (chain.lower(), token_address.lower(), pair_address.lower())
        if key in self.cooldowns:
            expire_time = self.cooldowns[key]
            if time.time() < expire_time:
                return True
            else:
                del self.cooldowns[key]
        return False

    def add_cooldown(self, chain: str, token_address: str, pair_address: str) -> None:
        key = (chain.lower(), token_address.lower(), pair_address.lower())
        self.cooldowns[key] = time.time() + (self.cooldown_minutes * 60.0)

    def add_position(self, pos: Position) -> None:
        self.open_positions[pos.position_id] = pos

    def update_position_price(
        self,
        position_id: str,
        new_price_usd: float,
        trailing_tiers=None
    ) -> Tuple[Optional[TradeRecord], str]:
        """Updates position with fresh price and evaluates trailing exit.
        
        Returns:
            (trade_record_if_exited, status_message)
        """
        if position_id not in self.open_positions:
            return None, "Position not found"

        pos = self.open_positions[position_id]
        if new_price_usd <= 0:
            return None, "Invalid price refresh"

        now = time.time()
        pos.current_price_usd = new_price_usd
        pos.last_update_timestamp = now
        pos.current_value_usd = pos.quantity * new_price_usd

        # Update peak price and peak profit
        if new_price_usd > pos.peak_price_usd:
            pos.peak_price_usd = new_price_usd

        pos.current_profit_percent = ((new_price_usd - pos.entry_price_usd) / pos.entry_price_usd) * 100.0
        pos.peak_profit_percent = ((pos.peak_price_usd - pos.entry_price_usd) / pos.entry_price_usd) * 100.0

        # Update trailing floor label & price
        _, floor_price, label = calculate_trailing_floor(
            pos.peak_profit_percent, pos.entry_price_usd, trailing_tiers
        )
        pos.trailing_floor_price_usd = floor_price
        if label:
            pos.trailing_tier_label = label

        # Check for dust state
        if pos.current_value_usd < 1.0:
            pos.state = TokenState.DUST
            return None, f"Marked as DUST: current value ${pos.current_value_usd:.2f} < $1.00"

        # Evaluate exit
        should_exit, exit_reason, next_state, _, message = evaluate_exit(
            entry_price_usd=pos.entry_price_usd,
            current_price_usd=pos.current_price_usd,
            peak_price_usd=pos.peak_price_usd,
            current_state=pos.state,
            tiers=trailing_tiers
        )

        pos.state = next_state

        if should_exit and exit_reason:
            trade = self.executor.execute_sell(pos, new_price_usd, exit_reason)
            pos.state = TokenState.SOLD
            # Remove from open positions
            del self.open_positions[position_id]
            # Add cooldown to prevent BUY -> SELL -> BUY loops
            self.add_cooldown(pos.chain, pos.token_address, pos.pair_address)
            return trade, f"Sold position ({exit_reason.value}): {message}"

        return None, message

    def emergency_exit(self, position_id: str, reason: ExitReason) -> Optional[TradeRecord]:
        """Forces an immediate EMERGENCY SAFETY EXIT (e.g. rug, honeypot, liquidity drain)."""
        if position_id not in self.open_positions:
            return None
        pos = self.open_positions[position_id]
        trade = self.executor.execute_sell(pos, pos.current_price_usd, reason)
        pos.state = TokenState.SOLD
        del self.open_positions[position_id]
        self.add_cooldown(pos.chain, pos.token_address, pos.pair_address)
        return trade
