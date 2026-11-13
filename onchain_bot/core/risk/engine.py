"""Risk Engine: Sizing, Slippage, Gas, and Portfolio Constraints."""

from typing import Tuple, Optional
from onchain_bot.models.types import TokenMetadata, StrategyEvaluation, TokenClassifier


class RiskEngine:
    def __init__(
        self,
        total_capital_usd: float = 1000.0,
        max_positions: int = 5,
        max_position_size_usd: float = 100.0,
        max_price_impact_percent: float = 1.5
    ):
        self.total_capital_usd = total_capital_usd
        self.max_positions = max_positions
        self.max_position_size_usd = max_position_size_usd
        self.max_price_impact_percent = max_price_impact_percent

    def calculate_price_impact(self, order_size_usd: float, liquidity_usd: float) -> float:
        """Estimates slippage/price impact from pool depth."""
        if liquidity_usd <= 0:
            return 100.0
        # For standard AMM x*y=k, impact approx = size / (liquidity / 2)
        half_liq = liquidity_usd / 2.0
        return min(100.0, (order_size_usd / half_liq) * 100.0)

    def calculate_position_size(
        self,
        token: TokenMetadata,
        evaluation: StrategyEvaluation,
        current_open_positions_count: int,
        available_capital_usd: float
    ) -> Tuple[bool, float, str]:
        """Calculates risk-adjusted position size.
        
        Returns:
            (is_valid, size_usd, reason_message)
        """
        # 1. Capacity check
        if current_open_positions_count >= self.max_positions:
            return False, 0.0, f"Max positions reached ({current_open_positions_count}/{self.max_positions})"

        if available_capital_usd <= 10.0:
            return False, 0.0, "Insufficient available capital (< $10)"

        # 2. Classifier sizing multipliers
        multipliers = {
            TokenClassifier.ESTABLISHED_BLUECHIP: 1.0,
            TokenClassifier.MID_CAP_GROWTH: 0.8,
            TokenClassifier.EARLY_STAGE_INNOVATION: 0.4,
            TokenClassifier.MEME_COMMUNITY: 0.25,
            TokenClassifier.HIGH_RISK_MICRO: 0.0,
        }
        mult = multipliers.get(evaluation.classifier, 0.25)
        base_size = self.max_position_size_usd * mult
        target_size = min(base_size, available_capital_usd)

        # 3. Liquidity cap: never exceed 2% of total pool liquidity
        liq = token.liquidity_usd or 0.0
        if liq < 2500.0:
            return False, 0.0, "Pool liquidity below minimum threshold ($2,500)"

        liq_cap = liq * 0.02
        target_size = min(target_size, liq_cap)

        # 4. Price impact check
        impact = self.calculate_price_impact(target_size, liq)
        if impact > self.max_price_impact_percent:
            # Reduce size to fit impact
            reduced_size = (self.max_price_impact_percent / 100.0) * (liq / 2.0)
            if reduced_size < 15.0:
                return False, 0.0, f"Trade blocked: Price impact {impact:.2f}% exceeds {self.max_price_impact_percent}%"
            target_size = reduced_size

        if target_size < 10.0:
            return False, 0.0, f"Calculated size ${target_size:.2f} is below minimum trade threshold ($10)"

        return True, round(target_size, 2), f"Approved size: ${target_size:.2f} (Impact: {impact:.2f}%)"
