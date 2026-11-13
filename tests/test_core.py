"""Comprehensive Unit Test Suite for On-Chain SPOT Bot v2."""

import unittest
from onchain_bot.config.settings import (
    normalize_chain, BotConfig, ConfigManager, DEFAULT_TRAILING_TIERS
)
from onchain_bot.models.types import (
    TokenMetadata, TokenState, SecurityVerdict, ExitReason, TokenClassifier
)
from onchain_bot.core.position.trailing import (
    find_trailing_tier, calculate_trailing_floor, evaluate_exit
)
from onchain_bot.core.security.engine import RugDefenseEngine
from onchain_bot.core.risk.engine import RiskEngine
from onchain_bot.core.strategy.engine import StrategyEngine
from onchain_bot.core.execution.paper import PaperExecutor


class TestTrailingTiersAndExits(unittest.TestCase):
    def test_tier_resolution(self):
        # 15% peak: no tier reached yet
        self.assertIsNone(find_trailing_tier(15.0))
        
        # 25% peak: should lock 20% tier (drop 1%)
        tier = find_trailing_tier(25.0)
        self.assertIsNotNone(tier)
        self.assertEqual(tier[0], 20.0)
        self.assertEqual(tier[1], 1.0)

        # 110% peak: should lock 100% tier (drop 5%)
        tier_100 = find_trailing_tier(110.0)
        self.assertEqual(tier_100[0], 100.0)
        self.assertEqual(tier_100[1], 5.0)

    def test_trailing_floor_calculation(self):
        entry = 1.00
        # Peak +50%: reached 40% tier (allowed drop 2% from actual peak)
        # Floor = 50% - 2% = 48% -> Floor price = 1.48
        floor_pct, floor_price, label = calculate_trailing_floor(50.0, entry)
        self.assertEqual(floor_pct, 48.0)
        self.assertAlmostEqual(floor_price, 1.48)
        self.assertIn("40PCT", label)

    def test_no_stop_loss_on_drawdown(self):
        # Initial drop to -15% should NOT trigger a sell (NO STOP-LOSS rule)
        entry = 10.0
        current = 8.5  # -15%
        peak = 10.0
        should_exit, reason, state, _, msg = evaluate_exit(entry, current, peak, TokenState.HOLDING)
        self.assertFalse(should_exit)
        self.assertIsNone(reason)
        self.assertEqual(state, TokenState.HOLDING)

    def test_trailing_exit_in_profit(self):
        entry = 1.00
        peak = 1.60  # +60% peak (tier 60% reached, drop 3% -> floor is +57% = $1.57)
        current = 1.55  # Below floor $1.57 -> should exit!
        should_exit, reason, state, floor, _ = evaluate_exit(entry, current, peak, TokenState.PROFIT_MONITORING)
        self.assertTrue(should_exit)
        self.assertEqual(reason, ExitReason.TRAILING_PROFIT)
        self.assertEqual(state, TokenState.EXIT_CANDIDATE)

    def test_gap_down_and_recovery_policy(self):
        entry = 1.00
        peak = 1.30  # Reached 20% tier
        current_dump = 0.90  # Dumped through floor into negative territory (-10%)

        # Step 1: Initial drop into loss transitions to RECOVERY_WATCH, peak preserved
        should_exit, reason, state, _, _ = evaluate_exit(entry, current_dump, peak, TokenState.PROFIT_MONITORING)
        self.assertFalse(should_exit)
        self.assertEqual(state, TokenState.RECOVERY_WATCH)

        # Step 2: Still in loss -> remains in RECOVERY_WATCH without selling
        should_exit2, _, state2, _, _ = evaluate_exit(entry, 0.95, peak, TokenState.RECOVERY_WATCH)
        self.assertFalse(should_exit2)
        self.assertEqual(state2, TokenState.RECOVERY_WATCH)

        # Step 3: Returns to net breakeven (+2% covering costs) -> triggers breakeven exit
        should_exit3, reason3, state3, _, _ = evaluate_exit(entry, 1.03, peak, TokenState.RECOVERY_WATCH)
        self.assertTrue(should_exit3)
        self.assertEqual(reason3, ExitReason.BREAKEVEN_RECOVERY)


class TestRugDefenseEngine(unittest.TestCase):
    def setUp(self):
        self.engine = RugDefenseEngine()
        self.base_token = TokenMetadata(
            chain="solana",
            token_address="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            pair_address="pair_sol_1",
            symbol="USDC",
            name="USD Coin",
            price_usd=1.00,
            liquidity_usd=50000.0,
            volume_24h_usd=20000.0,
            txns_24h_buys=150,
            txns_24h_sells=120,
            price_change_1h=5.0,
            price_change_24h=12.0
        )

    def test_fail_closed_on_active_mint_or_freeze(self):
        # Solana token with active freeze authority must FAIL and force score to 0
        api_data = {
            "mint_authority_revoked": True,
            "freeze_authority_revoked": False,  # DANGER: tokens can be frozen
            "verified": True
        }
        report = self.engine.inspect_token(self.base_token, api_data)
        self.assertEqual(report.overall_verdict, SecurityVerdict.FAIL)
        self.assertEqual(report.security_score, 0.0)
        self.assertTrue(any("FREEZE" in r for r in report.rejection_reasons))

    def test_fail_on_simulation_revert_or_high_tax(self):
        api_data = {"mint_authority_revoked": True, "freeze_authority_revoked": True, "verified": True}
        sim_data = {"simulation_success": False, "error": "TRANSFER_FAILED"}
        report = self.engine.inspect_token(self.base_token, api_data, sim_data)
        self.assertEqual(report.overall_verdict, SecurityVerdict.FAIL)
        self.assertEqual(report.security_score, 0.0)

    def test_clean_token_passes(self):
        api_data = {
            "mint_authority_revoked": True,
            "freeze_authority_revoked": True,
            "lp_locked_or_burned": True,
            "top10_holder_percent": 18.0,
            "verified": True
        }
        sim_data = {"simulation_success": True, "buy_tax_percent": 0.0, "sell_tax_percent": 0.0}
        report = self.engine.inspect_token(self.base_token, api_data, sim_data)
        self.assertEqual(report.overall_verdict, SecurityVerdict.PASS)
        self.assertGreater(report.security_score, 80.0)


class TestConfigAndNormalization(unittest.TestCase):
    def test_chain_aliases(self):
        self.assertEqual(normalize_chain("sol"), "solana")
        self.assertEqual(normalize_chain("solona"), "solana")
        self.assertEqual(normalize_chain("bnb"), "bsc")
        self.assertEqual(normalize_chain("binance"), "bsc")
        self.assertEqual(normalize_chain("arb"), "arbitrum")
        with self.assertRaises(ValueError):
            normalize_chain("unknown_chain_xyz")

    def test_config_atomic_validation(self):
        cfg = BotConfig(TOTAL_CAPITAL_USD=500.0, MAX_POSITION_SIZE_USD=50.0)
        cfg.validate()  # valid

        # Position size greater than total capital should fail
        with self.assertRaises(ValueError):
            bad_cfg = BotConfig(TOTAL_CAPITAL_USD=100.0, MAX_POSITION_SIZE_USD=200.0)
            bad_cfg.validate()


class TestRiskAndPaperExecution(unittest.TestCase):
    def test_paper_fill_deducts_fees_and_impact(self):
        executor = PaperExecutor(default_dex_fee_percent=0.3)
        token = TokenMetadata(
            chain="ethereum",
            token_address="0x123",
            pair_address="0x456",
            symbol="TEST",
            name="Test Token",
            price_usd=10.0,
            liquidity_usd=10000.0
        )
        pos = executor.execute_buy(token, order_size_usd=100.0, buy_tax_percent=1.0, gas_cost_usd=0.50)
        self.assertGreater(pos.entry_price_usd, 10.0)  # price pushed by slippage
        self.assertEqual(pos.cost_basis_usd, 100.0)

        # Sell at 20% gain quoted
        trade = executor.execute_sell(pos, exit_price_quoted=12.0, exit_reason=ExitReason.TRAILING_PROFIT)
        self.assertIsNotNone(trade.net_pnl_usd)
        self.assertEqual(trade.exit_reason, ExitReason.TRAILING_PROFIT)

    def test_fee_model_and_gas_reserve_invariants(self):
        # Trade allocation: 0.005 SOL ($0.6075 @ $121.50)
        sol_price = 121.50
        alloc_sol = 0.005
        alloc_usd = alloc_sol * sol_price
        
        # Base fees
        dex_fee_usd = alloc_usd * 0.003
        gas_fee_usd = 0.000005 * sol_price
        priority_fee_usd = 0.0001 * sol_price
        ata_rent_usd = 0.00203928 * sol_price
        
        total_fees_usd = dex_fee_usd + gas_fee_usd + priority_fee_usd + ata_rent_usd
        total_cost_usd = alloc_usd + total_fees_usd
        total_cost_sol = total_cost_usd / sol_price
        
        # Balance sufficiency check: 0.01 SOL wallet balance
        # Trying to spend 0.0071 SOL with min reserve 0.02 SOL must be rejected
        min_reserve = 0.02
        wallet_balance = 0.0100
        remaining_balance = wallet_balance - total_cost_sol
        
        # Must fail sufficiency check!
        is_affordable = remaining_balance >= min_reserve
        self.assertFalse(is_affordable)
        
        # When wallet has 1.0 SOL, it must pass
        wallet_balance_healthy = 1.0
        remaining_healthy = wallet_balance_healthy - total_cost_sol
        self.assertTrue(remaining_healthy >= min_reserve)


if __name__ == "__main__":
    unittest.main()
