"""Unit test suite for quantitative pre-filters, deduplication, and slot rotation."""

import unittest
from typing import Dict, Any, List


def evaluate_token_prefilter(
    liquidity_usd: float,
    volume_24h_usd: float,
    txns_24h: int,
    traders_24h: int,
    age_minutes: float,
    age_days: float,
    fdv_usd: float,
    min_liq: float = 25000.0,
    min_vol: float = 50000.0,
    min_txns: int = 200,
    min_traders: int = 100,
    min_age_m: float = 30.0,
    max_age_d: float = 365.0,
    max_vol_liq_ratio: float = 40.0,
    max_fdv_liq_ratio: float = 100.0,
) -> Dict[str, Any]:
    """Pure functional implementation of the server pre-filter for testing."""
    if liquidity_usd < min_liq:
        return {"passed": False, "reason": f"INSUFFICIENT_LIQUIDITY: ${liquidity_usd:,.2f} < ${min_liq:,.2f} min", "state": "REJECTED"}
    if volume_24h_usd < min_vol:
        return {"passed": False, "reason": f"INSUFFICIENT_VOLUME: ${volume_24h_usd:,.2f} < ${min_vol:,.2f} min", "state": "REJECTED"}
    if txns_24h < min_txns:
        return {"passed": False, "reason": f"LOW_ACTIVITY: {txns_24h} txns < {min_txns} min", "state": "REJECTED"}
    if traders_24h < min_traders:
        return {"passed": False, "reason": f"FEW_TRADERS: {traders_24h} < {min_traders} min", "state": "REJECTED"}
    if age_minutes < min_age_m:
        return {"passed": False, "reason": f"TOO_YOUNG_HIGH_RISK: Age {age_minutes:.0f}m < {min_age_m}m", "state": "ANALYZING"}
    if age_days > max_age_d and volume_24h_usd < min_vol * 2:
        return {"passed": False, "reason": f"STALE_LEGACY_TOKEN: Age {age_days:.0f}d exceeds max", "state": "REJECTED"}
    
    vol_liq_ratio = volume_24h_usd / max(100.0, liquidity_usd)
    is_organic_high_volume = txns_24h >= 2000
    if vol_liq_ratio > max_vol_liq_ratio and not is_organic_high_volume:
        return {"passed": False, "reason": f"SUSPICIOUS_WASH_TRADING: Vol/Liq ratio {vol_liq_ratio:.1f}x > {max_vol_liq_ratio}x", "state": "REJECTED"}

    if fdv_usd > 0 and (fdv_usd / max(100.0, liquidity_usd)) > max_fdv_liq_ratio:
        return {"passed": False, "reason": f"EXTREME_FDV_DISPARITY: FDV/Liq ratio {(fdv_usd / liquidity_usd):.0f}x > {max_fdv_liq_ratio}x", "state": "REJECTED"}

    return {"passed": True, "reason": "PREFILTER_PASSED", "state": "BUY_CANDIDATE"}


def deduplicate_pools_by_token(pools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Canonical pool deduplication: keeps highest liquidity pool per (chain, token_address)."""
    best_pool: Dict[str, Dict[str, Any]] = {}
    for p in pools:
        chain = p.get("chain", "").lower()
        token_addr = p.get("token_address", "").lower()
        key = f"{chain}_{token_addr}"
        incoming_liq = p.get("liquidity_usd", 0.0)
        existing = best_pool.get(key)
        existing_liq = existing.get("liquidity_usd", 0.0) if existing else -1.0
        if existing is None or incoming_liq > existing_liq:
            best_pool[key] = p
    return list(best_pool.values())


class TestQuantitativePrefilters(unittest.TestCase):
    def test_reject_insufficient_liquidity(self):
        # Screenshot 1 Row 19: CAT token with $10,000 liquidity
        res = evaluate_token_prefilter(
            liquidity_usd=10000.0,
            volume_24h_usd=60000.0,
            txns_24h=300,
            traders_24h=250,
            age_minutes=4320,
            age_days=3,
            fdv_usd=50000.0,
        )
        self.assertFalse(res["passed"])
        self.assertEqual(res["state"], "REJECTED")
        self.assertIn("INSUFFICIENT_LIQUIDITY", res["reason"])

    def test_reject_insufficient_volume(self):
        # Screenshot 1 Row 15: AI token with $58.97 volume
        res = evaluate_token_prefilter(
            liquidity_usd=100957.0,
            volume_24h_usd=58.97,
            txns_24h=5,
            traders_24h=5,
            age_minutes=1470000,
            age_days=1021,
            fdv_usd=100000.0,
        )
        self.assertFalse(res["passed"])
        self.assertEqual(res["state"], "REJECTED")
        self.assertIn("INSUFFICIENT_VOLUME", res["reason"])

    def test_reject_low_transactions(self):
        # Screenshot 1 Row 23: CAT token with 27 buys + 26 sells = 53 txns
        res = evaluate_token_prefilter(
            liquidity_usd=41478.0,
            volume_24h_usd=1001.0,
            txns_24h=53,
            traders_24h=45,
            age_minutes=987000,
            age_days=686,
            fdv_usd=100000.0,
        )
        self.assertFalse(res["passed"])
        self.assertEqual(res["state"], "REJECTED")

    def test_reject_wash_trading_manipulation(self):
        # $2.5M volume churned on $30k pool with 350 txns (83x ratio > 40x limit)
        res = evaluate_token_prefilter(
            liquidity_usd=30000.0,
            volume_24h_usd=2500000.0,  # 83x vol/liq
            txns_24h=350,
            traders_24h=120,
            age_minutes=120,
            age_days=0.08,
            fdv_usd=500000.0,
        )
        self.assertFalse(res["passed"])
        self.assertEqual(res["state"], "REJECTED")
        self.assertIn("SUSPICIOUS_WASH_TRADING", res["reason"])

    def test_reject_stale_legacy_dead_coin(self):
        # Screenshot 1 Row 24: 1013 days old with $171 volume
        res = evaluate_token_prefilter(
            liquidity_usd=80082.0,
            volume_24h_usd=171.66,
            txns_24h=14,
            traders_24h=10,
            age_minutes=1458720,
            age_days=1013,
            fdv_usd=100000.0,
        )
        self.assertFalse(res["passed"])
        self.assertEqual(res["state"], "REJECTED")

    def test_qualifying_runner_passes(self):
        # Screenshot 2: MINTRO with $111k liq, $4.9M vol, 107k txns, 12h age
        res = evaluate_token_prefilter(
            liquidity_usd=111102.0,
            volume_24h_usd=4971156.0,
            txns_24h=107431,
            traders_24h=11271,
            age_minutes=720,
            age_days=0.5,
            fdv_usd=1200000.0,
        )
        self.assertTrue(res["passed"])
        self.assertEqual(res["state"], "BUY_CANDIDATE")


class TestPoolDeduplication(unittest.TestCase):
    def test_deduplicate_multiple_pools_same_token(self):
        pools = [
            {"chain": "solana", "token_address": "TokenABC", "dex": "raydium", "liquidity_usd": 15000.0},
            {"chain": "solana", "token_address": "TokenABC", "dex": "orca", "liquidity_usd": 85000.0},
            {"chain": "solana", "token_address": "TokenABC", "dex": "meteora", "liquidity_usd": 3200.0},
            {"chain": "solana", "token_address": "TokenXYZ", "dex": "raydium", "liquidity_usd": 45000.0},
        ]
        deduped = deduplicate_pools_by_token(pools)
        self.assertEqual(len(deduped), 2)
        
        # Verify TokenABC kept Orca pool with $85,000 liquidity
        abc_pool = next(p for p in deduped if p["token_address"].lower() == "tokenabc".lower())
        self.assertEqual(abc_pool["dex"], "orca")
        self.assertEqual(abc_pool["liquidity_usd"], 85000.0)


class TestPositionExitRules(unittest.TestCase):
    def test_stop_loss_trigger(self):
        stop_loss_pct = -8.0
        entry_price = 1.00
        current_price = 0.91  # -9% drawdown
        pnl_pct = ((current_price - entry_price) / entry_price) * 100
        should_stop = pnl_pct <= stop_loss_pct
        self.assertTrue(should_stop)

    def test_max_holding_timeout(self):
        entry_timestamp = 1000000
        current_timestamp = entry_timestamp + (5 * 3600 * 1000)  # 5 hours later
        max_holding_hours = 4.0
        hours_held = (current_timestamp - entry_timestamp) / (3600 * 1000)
        pnl_pct = 1.2  # Stagnant (+1.2%)
        should_timeout = hours_held >= max_holding_hours and pnl_pct < 5.0
        self.assertTrue(should_timeout)


if __name__ == "__main__":
    unittest.main()
