"""Trailing profit engine, tier resolution, and exit decision rules.

STRICT INVARIANTS:
1. NO STOP-LOSS. Normal market dips NEVER trigger a sell.
2. Trailing locks are measured from actual peak profit: floor = peak - drop.
3. Gap-down policy: if price drops into negative territory after hitting a tier,
   the peak is NEVER erased; state becomes RECOVERY_WATCH, exiting on net breakeven.
4. EMERGENCY exits are safety events, not stop-losses.
"""

from typing import List, Tuple, Optional
from onchain_bot.models.types import TokenState, ExitReason
from onchain_bot.config.settings import DEFAULT_TRAILING_TIERS


def find_trailing_tier(
    peak_profit_pct: float,
    tiers: Optional[List[Tuple[float, float]]] = None
) -> Optional[Tuple[float, float, str]]:
    """Returns (tier_threshold, allowed_drop, tier_label) for the highest reached tier."""
    active_tiers = tiers if tiers is not None else DEFAULT_TRAILING_TIERS
    best_tier = None
    for threshold, drop in sorted(active_tiers, key=lambda x: x[0]):
        if peak_profit_pct >= threshold:
            label = f"TIER_{int(threshold)}PCT_DROP_{int(drop)}PCT"
            best_tier = (threshold, drop, label)
    return best_tier


def calculate_trailing_floor(
    peak_profit_pct: float,
    entry_price_usd: float,
    tiers: Optional[List[Tuple[float, float]]] = None
) -> Tuple[float, float, Optional[str]]:
    """Calculates the floor profit percentage and floor price in USD.
    
    Returns:
        (floor_profit_pct, floor_price_usd, tier_label)
    """
    tier = find_trailing_tier(peak_profit_pct, tiers)
    if tier is None:
        return 0.0, entry_price_usd, None
    
    _, drop, label = tier
    floor_profit_pct = peak_profit_pct - drop
    floor_price_usd = entry_price_usd * (1.0 + floor_profit_pct / 100.0)
    return floor_profit_pct, floor_price_usd, label


def evaluate_exit(
    entry_price_usd: float,
    current_price_usd: float,
    peak_price_usd: float,
    current_state: TokenState,
    tiers: Optional[List[Tuple[float, float]]] = None,
    total_cost_percent: float = 1.0  # Gas + DEX fees + Taxes
) -> Tuple[bool, Optional[ExitReason], TokenState, float, str]:
    """Evaluates whether an exit should occur according to trailing-profit and gap-down rules.
    
    Returns:
        (should_exit, exit_reason, next_state, floor_price_usd, message)
    """
    if entry_price_usd <= 0:
        return False, None, current_state, 0.0, "Invalid entry price"

    current_profit_pct = ((current_price_usd - entry_price_usd) / entry_price_usd) * 100.0
    effective_peak_price = max(peak_price_usd, current_price_usd)
    peak_profit_pct = ((effective_peak_price - entry_price_usd) / entry_price_usd) * 100.0

    floor_profit_pct, floor_price_usd, tier_label = calculate_trailing_floor(
        peak_profit_pct, entry_price_usd, tiers
    )

    # If no tier has been reached yet (< 20%)
    if tier_label is None:
        if current_profit_pct < 0:
            # NO STOP-LOSS RULE: Hold through drawdown
            return False, None, TokenState.HOLDING, 0.0, f"Holding: {current_profit_pct:.2f}% (no tier reached)"
        return False, None, TokenState.PROFIT_MONITORING, 0.0, f"Monitoring: +{current_profit_pct:.2f}%"

    # Handle RECOVERY_WATCH state explicitly
    if current_state == TokenState.RECOVERY_WATCH:
        if current_profit_pct >= total_cost_percent:
            return (
                True,
                ExitReason.BREAKEVEN_RECOVERY,
                TokenState.EXIT_CANDIDATE,
                entry_price_usd * (1.0 + total_cost_percent / 100.0),
                f"Breakeven recovery exit executed at +{current_profit_pct:.2f}%"
            )
        return (
            False,
            None,
            TokenState.RECOVERY_WATCH,
            floor_price_usd,
            f"Recovery watch active: price {current_price_usd:.6f}, peak preserved at +{peak_profit_pct:.2f}%"
        )

    # A trailing tier was unlocked
    # Gap-Down check: price fell through floor into net negative
    if current_price_usd < entry_price_usd:
        return (
            False,
            None,
            TokenState.RECOVERY_WATCH,
            floor_price_usd,
            f"Gap-down detected: dropped into loss after reaching {tier_label}. Moving to RECOVERY_WATCH."
        )

    # Normal trailing check in profit
    if current_price_usd <= floor_price_usd:
        return (
            True,
            ExitReason.TRAILING_PROFIT,
            TokenState.EXIT_CANDIDATE,
            floor_price_usd,
            f"Trailing profit floor triggered at +{current_profit_pct:.2f}% (Peak: +{peak_profit_pct:.2f}%, Floor: +{floor_profit_pct:.2f}%)"
        )

    return (
        False,
        None,
        TokenState.PROFIT_MONITORING,
        floor_price_usd,
        f"Protected by {tier_label}: Floor +{floor_profit_pct:.2f}%, Current +{current_profit_pct:.2f}%"
    )
