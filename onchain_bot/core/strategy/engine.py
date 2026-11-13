"""Strategy Engine: Quality Scoring, Trade Scoring, and Token Classification."""

import time
from typing import Dict, List, Optional, Tuple, Any
from onchain_bot.models.types import (
    TokenMetadata, SecurityReport, StrategyEvaluation,
    TokenClassifier, SecurityVerdict
)


class StrategyEngine:
    def __init__(self, min_quality_score: float = 75.0, min_trade_score: float = 70.0):
        self.min_quality_score = min_quality_score
        self.min_trade_score = min_trade_score

    def classify_token(self, token: TokenMetadata) -> TokenClassifier:
        now_ms = time.time() * 1000.0
        age_hours = 0.0
        if token.pair_created_at_ms:
            age_hours = max(0.0, (now_ms - token.pair_created_at_ms) / (1000.0 * 3600.0))

        liq = token.liquidity_usd or 0.0
        vol = token.volume_24h_usd or 0.0

        if liq < 5000.0 or age_hours < 0.5:
            return TokenClassifier.HIGH_RISK_MICRO
        if liq > 500000.0 and age_hours > 720:  # > 30 days
            return TokenClassifier.ESTABLISHED_BLUECHIP
        if liq > 100000.0 and age_hours > 168:  # > 7 days
            return TokenClassifier.MID_CAP_GROWTH
        if age_hours < 72:  # < 3 days
            return TokenClassifier.EARLY_STAGE_INNOVATION
        return TokenClassifier.MEME_COMMUNITY

    def compute_quality_score(self, token: TokenMetadata, sec_report: SecurityReport) -> float:
        # Rule: Any critical security verdict forces Quality Score to 0
        if sec_report.overall_verdict in [SecurityVerdict.FAIL, SecurityVerdict.UNAVAILABLE]:
            return 0.0

        # Sub-score components
        s_sec = sec_report.security_score  # 30%
        
        # Liquidity score (25%)
        liq = token.liquidity_usd or 0.0
        s_liq = min(100.0, (liq / 50000.0) * 100.0)

        # Holders score (15%)
        top10 = sec_report.top10_holder_percent or 20.0
        if top10 <= 15.0:
            s_holders = 100.0
        elif top10 <= 30.0:
            s_holders = 75.0
        elif top10 <= 45.0:
            s_holders = 40.0
        else:
            s_holders = 0.0

        # Contract score (15%)
        s_contract = 90.0 if sec_report.mint_authority_revoked is not False else 0.0

        # Age score (15%)
        now_ms = time.time() * 1000.0
        age_hours = 0.0
        if token.pair_created_at_ms:
            age_hours = max(0.0, (now_ms - token.pair_created_at_ms) / (1000.0 * 3600.0))
        if age_hours >= 72.0:
            s_age = 100.0
        elif age_hours >= 24.0:
            s_age = 80.0
        elif age_hours >= 6.0:
            s_age = 50.0
        else:
            s_age = 20.0

        quality = (
            0.30 * s_sec +
            0.25 * s_liq +
            0.15 * s_holders +
            0.15 * s_contract +
            0.15 * s_age
        )
        return round(min(100.0, max(0.0, quality)), 1)

    def compute_trade_score(self, token: TokenMetadata) -> float:
        # Momentum (30%): optimal 1h change between +3% and +30%
        p1h = token.price_change_1h or 0.0
        if 3.0 <= p1h <= 30.0:
            s_mom = 95.0
        elif 0.0 < p1h < 3.0:
            s_mom = 70.0
        elif p1h > 100.0:
            s_mom = 40.0  # Overextended dump risk
        elif p1h < -5.0:
            s_mom = 30.0
        else:
            s_mom = 50.0

        # Volume / Transaction pressure (25%)
        buys = token.txns_24h_buys or 0
        sells = token.txns_24h_sells or 0
        total_tx = buys + sells
        if total_tx > 0:
            buy_ratio = buys / total_tx
            if 0.55 <= buy_ratio <= 0.75:
                s_vol = 95.0
            elif buy_ratio > 0.85:
                s_vol = 60.0  # Sniper cluster suspicion
            else:
                s_vol = 50.0
        else:
            s_vol = 30.0

        # Liquidity depth (20%)
        liq = token.liquidity_usd or 0.0
        s_depth = min(100.0, max(20.0, (liq / 25000.0) * 100.0))

        # Structure / 24h trend (15%)
        p24h = token.price_change_24h or 0.0
        if 10.0 <= p24h <= 60.0:
            s_struct = 90.0
        elif 0.0 <= p24h < 10.0:
            s_struct = 70.0
        else:
            s_struct = 40.0

        # Regime (10%)
        s_regime = 80.0

        trade_score = (
            0.30 * s_mom +
            0.25 * s_vol +
            0.20 * s_depth +
            0.15 * s_struct +
            0.10 * s_regime
        )
        return round(min(100.0, max(0.0, trade_score)), 1)

    def evaluate(self, token: TokenMetadata, sec_report: SecurityReport) -> StrategyEvaluation:
        classifier = self.classify_token(token)
        quality_score = self.compute_quality_score(token, sec_report)
        trade_score = self.compute_trade_score(token)

        reasons: List[str] = []
        warnings: List[str] = list(sec_report.warnings)

        # Check approval condition: both Quality and Trade must pass thresholds
        is_quality_pass = quality_score >= self.min_quality_score
        is_trade_pass = trade_score >= self.min_trade_score
        is_not_high_risk = classifier != TokenClassifier.HIGH_RISK_MICRO

        is_approved = is_quality_pass and is_trade_pass and is_not_high_risk

        if is_approved:
            reasons.append(f"Quality Score {quality_score} >= {self.min_quality_score}")
            reasons.append(f"Trade Score {trade_score} >= {self.min_trade_score}")
            reasons.append(f"Classified as {classifier.value}")
        else:
            if not is_quality_pass:
                reasons.append(f"Quality Score {quality_score} failed minimum threshold {self.min_quality_score}")
            if not is_trade_pass:
                reasons.append(f"Trade Score {trade_score} failed minimum threshold {self.min_trade_score}")
            if not is_not_high_risk:
                reasons.append("Rejected: Classified as HIGH_RISK_MICRO")

        return StrategyEvaluation(
            chain=token.chain,
            token_address=token.token_address,
            pair_address=token.pair_address,
            quality_score=quality_score,
            trade_score=trade_score,
            classifier=classifier,
            is_buy_approved=is_approved,
            reasons=reasons,
            warnings=warnings
        )
