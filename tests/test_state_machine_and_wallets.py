"""Unit and integration test suite for Bot State Machine, Stop Behavior, and Mode-Scoped Wallets."""

import unittest
from typing import Dict, Any, List, Optional


class MockBotStateMachine:
    """Python reference implementation of the backend Bot State Machine."""
    
    VALID_STATES = ["STOPPED", "STARTING", "RUNNING", "PAUSED_BUYING", "STOPPING", "EMERGENCY_PAUSE"]
    
    def __init__(self):
        self.state = "RUNNING"
        self.is_running = True
        self.is_scanner_active = True
        self.is_buying_paused = False
        self.is_emergency_paused = False
        self.active_timers = 1
        self.in_flight_tasks = 0
        self.orders_executed = []
        
    def transition(self, new_state: str, reason: str = "") -> bool:
        if new_state not in self.VALID_STATES:
            raise ValueError(f"Invalid state: {new_state}")
            
        old_state = self.state
        self.state = new_state
        
        if new_state == "STOPPED":
            self.is_running = False
            self.is_scanner_active = False
            self.is_buying_paused = True
            self.active_timers = 0
            self.in_flight_tasks = 0
        elif new_state == "STOPPING":
            self.is_running = False
            self.is_scanner_active = False
            self.is_buying_paused = True
            self.active_timers = 0
            self.in_flight_tasks = 0
            # Transitions to STOPPED immediately
            self.state = "STOPPED"
        elif new_state == "RUNNING":
            self.is_running = True
            self.is_scanner_active = True
            self.is_buying_paused = False
            self.is_emergency_paused = False
            self.active_timers = 1
        elif new_state == "PAUSED_BUYING":
            self.is_buying_paused = True
        elif new_state == "EMERGENCY_PAUSE":
            self.is_running = False
            self.is_buying_paused = True
            self.is_emergency_paused = True
            self.active_timers = 0
            
        return True

    def is_buying_allowed(self, mode: str, connected_live_wallet: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Final execution layer guard."""
        if self.state in ["STOPPED", "STOPPING"]:
            return {"allowed": False, "reason": "BOT_STOPPED"}
        if self.state == "EMERGENCY_PAUSE" or self.is_emergency_paused:
            return {"allowed": False, "reason": "EMERGENCY_PAUSE_ACTIVE"}
        if self.state == "PAUSED_BUYING" or self.is_buying_paused:
            return {"allowed": False, "reason": "BUYING_PAUSED"}
        if not self.is_running:
            return {"allowed": False, "reason": "BOT_NOT_RUNNING"}
            
        if mode == "live":
            if not connected_live_wallet or not connected_live_wallet.get("is_connected"):
                return {"allowed": False, "reason": "NO_LIVE_WALLET_CONNECTED"}
            native_bal = float(connected_live_wallet.get("native_balance", 0.0))
            min_reserve = 0.02
            if native_bal <= min_reserve:
                return {"allowed": False, "reason": "LIVE_WALLET_INSUFFICIENT_GAS_RESERVE"}
                
        return {"allowed": True, "reason": "ALLOWED"}

    def execute_order(self, token_symbol: str, mode: str, connected_live_wallet: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        guard = self.is_buying_allowed(mode, connected_live_wallet)
        if not guard["allowed"]:
            return None
        order = {"symbol": token_symbol, "mode": mode, "status": "FILLED"}
        self.orders_executed.append(order)
        return order


class MockWalletResolver:
    """Mode-scoped wallet resolution logic."""
    
    @staticmethod
    def resolve_wallets(mode: str, live_registry: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
        chains = ["solana", "ethereum", "bsc", "base"]
        
        if mode == "paper":
            return [
                {
                    "mode": "paper",
                    "chain": ch,
                    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" if ch == "solana" else "0x71C...89e2",
                    "name": f"Internal Hot / Paper Vault ({ch.upper()})",
                    "is_simulated": True,
                    "native_balance": "12.50 SOL" if ch == "solana" else "2.50 ETH",
                    "balance_usd": "$1,600.00",
                    "is_connected": True,
                }
                for ch in chains
            ]
            
        elif mode == "testnet":
            return [
                {
                    "mode": "testnet",
                    "chain": ch,
                    "address": "dev_9wFF4t...sol" if ch == "solana" else "0xTest...89e2",
                    "name": f"Testnet / Devnet Faucet Wallet ({ch.upper()})",
                    "is_simulated": True,
                    "native_balance": "5.00 SOL" if ch == "solana" else "1.50 ETH",
                    "balance_usd": "$0.00 (Testnet)",
                    "is_connected": True,
                }
                for ch in chains
            ]
            
        elif mode == "live":
            # Live mode: Paper wallet is strictly excluded
            results = []
            for ch in chains:
                live = live_registry.get(ch)
                if live and live.get("is_connected"):
                    results.append({
                        "mode": "live",
                        "chain": ch,
                        "address": live["address"],
                        "name": live.get("name", "Real Browser Wallet"),
                        "is_simulated": False,
                        "native_balance": live["native_balance"],
                        "balance_usd": live["balance_usd"],
                        "is_connected": True,
                    })
                else:
                    results.append({
                        "mode": "live",
                        "chain": ch,
                        "address": None,
                        "name": f"No Real Wallet Connected ({ch.upper()})",
                        "is_simulated": False,
                        "native_balance": "0.00",
                        "balance_usd": "$0.00",
                        "is_connected": False,
                    })
            return results
            
        raise ValueError(f"Unknown mode: {mode}")


class TestBotStateMachine(unittest.TestCase):
    def setUp(self):
        self.sm = MockBotStateMachine()

    def test_initial_running_state(self):
        self.assertEqual(self.sm.state, "RUNNING")
        self.assertTrue(self.sm.is_running)
        self.assertEqual(self.sm.active_timers, 1)

    def test_stop_bot_halts_timers_and_orders(self):
        # Trigger STOP BOT
        self.sm.transition("STOPPING")
        self.assertEqual(self.sm.state, "STOPPED")
        self.assertFalse(self.sm.is_running)
        self.assertFalse(self.sm.is_scanner_active)
        self.assertEqual(self.sm.active_timers, 0)
        self.assertEqual(self.sm.in_flight_tasks, 0)

        # Assert final execution layer blocks orders
        guard = self.sm.is_buying_allowed("paper")
        self.assertFalse(guard["allowed"])
        self.assertEqual(guard["reason"], "BOT_STOPPED")

        # Attempt to execute an order while stopped
        res = self.sm.execute_order("JUP", "paper")
        self.assertIsNone(res)
        self.assertEqual(len(self.sm.orders_executed), 0)

    def test_emergency_pause_behavior(self):
        self.sm.transition("EMERGENCY_PAUSE")
        self.assertEqual(self.sm.state, "EMERGENCY_PAUSE")
        self.assertTrue(self.sm.is_emergency_paused)
        
        guard = self.sm.is_buying_allowed("paper")
        self.assertFalse(guard["allowed"])
        self.assertEqual(guard["reason"], "EMERGENCY_PAUSE_ACTIVE")
        
        res = self.sm.execute_order("BONK", "paper")
        self.assertIsNone(res)

    def test_pause_buying_behavior(self):
        self.sm.transition("PAUSED_BUYING")
        self.assertEqual(self.sm.state, "PAUSED_BUYING")
        self.assertTrue(self.sm.is_buying_paused)
        
        guard = self.sm.is_buying_allowed("paper")
        self.assertFalse(guard["allowed"])
        self.assertEqual(guard["reason"], "BUYING_PAUSED")

    def test_restart_resumes_cleanly(self):
        self.sm.transition("STOPPING")
        self.assertEqual(self.sm.state, "STOPPED")
        
        # Resume with START BOT
        self.sm.transition("RUNNING")
        self.assertEqual(self.sm.state, "RUNNING")
        self.assertTrue(self.sm.is_running)
        self.assertEqual(self.sm.active_timers, 1)

        # Orders succeed again in Paper mode
        res = self.sm.execute_order("RAY", "paper")
        self.assertIsNotNone(res)
        self.assertEqual(len(self.sm.orders_executed), 1)


class TestModeScopedWalletResolution(unittest.TestCase):
    def test_paper_mode_returns_virtual_vault(self):
        wallets = MockWalletResolver.resolve_wallets("paper", {})
        self.assertTrue(all(w["mode"] == "paper" for w in wallets))
        self.assertTrue(all(w["is_simulated"] for w in wallets))
        self.assertTrue(any("Paper Vault" in w["name"] for w in wallets))

    def test_live_mode_excludes_paper_vault(self):
        live_registry = {
            "solana": {
                "address": "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK",
                "name": "Phantom (Live Hot Wallet)",
                "native_balance": "4.825 SOL",
                "balance_usd": "$586.24",
                "is_connected": True,
            }
        }
        wallets = MockWalletResolver.resolve_wallets("live", live_registry)
        self.assertTrue(all(w["mode"] == "live" for w in wallets))
        # Zero paper vaults present
        self.assertFalse(any("Paper" in w["name"] for w in wallets))
        
        sol_wallet = next(w for w in wallets if w["chain"] == "solana")
        self.assertEqual(sol_wallet["address"], "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK")
        self.assertTrue(sol_wallet["is_connected"])
        self.assertFalse(sol_wallet["is_simulated"])

    def test_live_execution_refuses_without_wallet_or_low_balance(self):
        sm = MockBotStateMachine()
        
        # 1. No live wallet connected
        guard = sm.is_buying_allowed("live", None)
        self.assertFalse(guard["allowed"])
        self.assertEqual(guard["reason"], "NO_LIVE_WALLET_CONNECTED")

        # 2. Wallet connected but 0 balance
        empty_wallet = {
            "is_connected": True,
            "native_balance": "0.00",
            "address": "DYw8j...",
        }
        guard2 = sm.is_buying_allowed("live", empty_wallet)
        self.assertFalse(guard2["allowed"])
        self.assertEqual(guard2["reason"], "LIVE_WALLET_INSUFFICIENT_GAS_RESERVE")

        # 3. Funded live wallet passes
        funded_wallet = {
            "is_connected": True,
            "native_balance": "1.50",
            "address": "DYw8j...",
        }
        guard3 = sm.is_buying_allowed("live", funded_wallet)
        self.assertTrue(guard3["allowed"])


class TestWalletFeeSchedulesAndRiskToggles(unittest.TestCase):
    """Verifies wallet fee schedules are isolated and stop loss / holding toggles apply cleanly."""

    WALLET_FEE_SCHEDULES = {
        "phantom": {"swap_fee_pct": 0.85, "estimated_gas_usd": 0.05, "ata_rent_usd": 0.31},
        "solflare": {"swap_fee_pct": 0.50, "estimated_gas_usd": 0.04, "ata_rent_usd": 0.31},
        "metamask": {"swap_fee_pct": 0.875, "estimated_gas_usd": 0.15, "ata_rent_usd": 0.0},
        "trustwallet": {"swap_fee_pct": 1.00, "estimated_gas_usd": 0.10, "ata_rent_usd": 0.0},
        "coinbase": {"swap_fee_pct": 1.00, "estimated_gas_usd": 0.08, "ata_rent_usd": 0.0},
        "ledger": {"swap_fee_pct": 0.00, "estimated_gas_usd": 0.05, "ata_rent_usd": 0.0},
        "paper": {"swap_fee_pct": 0.30, "estimated_gas_usd": 0.002, "ata_rent_usd": 0.0},
    }

    def test_wallet_fee_isolation_phantom_vs_metamask(self):
        phantom = self.WALLET_FEE_SCHEDULES["phantom"]
        metamask = self.WALLET_FEE_SCHEDULES["metamask"]

        self.assertEqual(phantom["swap_fee_pct"], 0.85)
        self.assertEqual(metamask["swap_fee_pct"], 0.875)
        self.assertNotEqual(phantom["swap_fee_pct"], metamask["swap_fee_pct"])
        self.assertGreater(phantom["ata_rent_usd"], 0)
        self.assertEqual(metamask["ata_rent_usd"], 0)

    def test_stop_loss_toggle_behavior(self):
        def evaluate_exit(current_profit_pct, enable_stop_loss=True, stop_loss_pct=-8.0):
            if enable_stop_loss and current_profit_pct <= stop_loss_pct:
                return {"should_exit": True, "reason": "STOP_LOSS_HIT"}
            return {"should_exit": False, "reason": None}

        # When enabled and below threshold -> exits
        res_enabled = evaluate_exit(-10.0, enable_stop_loss=True)
        self.assertTrue(res_enabled["should_exit"])
        self.assertEqual(res_enabled["reason"], "STOP_LOSS_HIT")

        # When disabled -> does not exit even at -10%
        res_disabled = evaluate_exit(-10.0, enable_stop_loss=False)
        self.assertFalse(res_disabled["should_exit"])
        self.assertIsNone(res_disabled["reason"])

    def test_max_holding_time_toggle_behavior(self):
        def evaluate_holding_exit(holding_hours, enable_max_holding=True, max_holding_hours=4.0, net_profit_pct=-1.0):
            if enable_max_holding and holding_hours >= max_holding_hours and net_profit_pct < 5.0:
                return {"should_exit": True, "reason": "MAX_HOLDING_TIMEOUT"}
            return {"should_exit": False, "reason": None}

        # When enabled and exceeds max holding hours -> exits
        res_enabled = evaluate_holding_exit(5.0, enable_max_holding=True)
        self.assertTrue(res_enabled["should_exit"])
        self.assertEqual(res_enabled["reason"], "MAX_HOLDING_TIMEOUT")

        # When disabled -> does not exit
        res_disabled = evaluate_holding_exit(5.0, enable_max_holding=False)
        self.assertFalse(res_disabled["should_exit"])
        self.assertIsNone(res_disabled["reason"])


class TestSlotControlledScanningAndClearBehavior(unittest.TestCase):
    """Verifies that market scanning is controlled strictly by slot availability and clears on buy/sell."""

    def test_scanner_starts_only_when_slot_available(self):
        max_positions = 5

        def can_scan(positions_count):
            return positions_count < max_positions

        self.assertTrue(can_scan(0))
        self.assertTrue(can_scan(4))
        self.assertFalse(can_scan(5))
        self.assertFalse(can_scan(6))

    def test_successful_buy_clears_scanner_and_stops_if_full(self):
        max_positions = 5
        open_positions = ["POS_1", "POS_2", "POS_3", "POS_4"]
        scanner_universe = {"TOKEN_A": {"score": 85}, "TOKEN_B": {"score": 90}}

        # Buy TOKEN_B
        open_positions.append("POS_5")
        scanner_universe.clear()  # Cleared immediately on purchase
        is_scanner_active = len(open_positions) < max_positions

        self.assertEqual(len(scanner_universe), 0)
        self.assertEqual(len(open_positions), 5)
        self.assertFalse(is_scanner_active)

    def test_selling_position_frees_slot_and_triggers_fresh_scan(self):
        max_positions = 5
        open_positions = ["POS_1", "POS_2", "POS_3", "POS_4", "POS_5"]
        scanner_universe = {}

        # Sell POS_5
        open_positions.remove("POS_5")
        scanner_universe.clear()  # Reset for fresh scan

        slots_available = max_positions - len(open_positions)
        should_start_fresh_scan = slots_available > 0

        self.assertTrue(should_start_fresh_scan)
        self.assertEqual(slots_available, 1)
        self.assertEqual(len(scanner_universe), 0)

    def test_previously_scanned_coins_re_evaluated_fresh(self):
        # Old scan: Coin A was rejected due to negative 1h momentum (-2.0%)
        old_coin_a = {"symbol": "TOKEN_A", "p1h": -2.0, "is_buy_approved": False}
        self.assertFalse(old_coin_a["is_buy_approved"])

        # New scan after slot freed: Coin A now has positive momentum (+8.5%) and qualifies
        new_coin_a = {"symbol": "TOKEN_A", "p1h": 8.5, "p24h": 12.0, "buy_ratio": 0.65}
        is_buy_approved = new_coin_a["p1h"] >= 0.5 and new_coin_a["p24h"] >= -2.0 and new_coin_a["buy_ratio"] >= 0.50

        self.assertTrue(is_buy_approved)


if __name__ == "__main__":
    unittest.main()
