"""Portfolio Manager: Balances, exposure, win rates, and P&L calculations."""

from typing import List, Dict, Any
from onchain_bot.models.types import Position, TradeRecord


class PortfolioManager:
    def __init__(self, initial_capital_usd: float = 1000.0):
        self.initial_capital_usd = initial_capital_usd
        self.cash_balance_usd = initial_capital_usd
        self.trades: List[TradeRecord] = []

    def get_portfolio_summary(self, open_positions: List[Position]) -> Dict[str, Any]:
        invested_capital = sum(p.cost_basis_usd for p in open_positions)
        current_position_value = sum(p.current_value_usd for p in open_positions)
        unrealized_pnl = current_position_value - invested_capital
        unrealized_pnl_pct = (unrealized_pnl / invested_capital * 100.0) if invested_capital > 0 else 0.0

        realized_pnl = sum(t.net_pnl_usd for t in self.trades)
        total_portfolio_value = self.cash_balance_usd + current_position_value

        wins = [t for t in self.trades if t.net_pnl_usd > 0]
        losses = [t for t in self.trades if t.net_pnl_usd <= 0]
        total_trades = len(self.trades)
        win_rate = (len(wins) / total_trades * 100.0) if total_trades > 0 else 0.0

        gross_profits = sum(t.net_pnl_usd for t in wins)
        gross_losses = abs(sum(t.net_pnl_usd for t in losses))
        profit_factor = (gross_profits / gross_losses) if gross_losses > 0 else (99.0 if gross_profits > 0 else 0.0)

        return {
            "total_portfolio_value_usd": round(total_portfolio_value, 2),
            "cash_balance_usd": round(self.cash_balance_usd, 2),
            "invested_capital_usd": round(invested_capital, 2),
            "unrealized_pnl_usd": round(unrealized_pnl, 2),
            "unrealized_pnl_pct": round(unrealized_pnl_pct, 2),
            "realized_pnl_usd": round(realized_pnl, 2),
            "total_pnl_usd": round(realized_pnl + unrealized_pnl, 2),
            "open_positions_count": len(open_positions),
            "total_trades": total_trades,
            "wins_count": len(wins),
            "losses_count": len(losses),
            "win_rate_pct": round(win_rate, 1),
            "profit_factor": round(profit_factor, 2)
        }

    def on_buy_executed(self, cost_basis_usd: float) -> None:
        self.cash_balance_usd = max(0.0, self.cash_balance_usd - cost_basis_usd)

    def on_sell_executed(self, trade: TradeRecord) -> None:
        self.trades.append(trade)
        proceeds = trade.cost_basis_usd + trade.net_pnl_usd
        self.cash_balance_usd += proceeds
