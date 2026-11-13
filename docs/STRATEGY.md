# ON-CHAIN SPOT STRATEGY, SCORING & EXPLAINABILITY ENGINE

This document specifies the quantitative scoring algorithms, market regime filters, token classifiers, and explainability rules governing trade signals in On-Chain SPOT Bot v2.

---

## 1. Core Paradigm: Separation of Quality and Trade Opportunity

A safe token is not necessarily a profitable trade, and an explosive price pump is often a fatal honeypot.
Therefore, the bot enforces two completely decoupled scores:

1. **QUALITY SCORE ($Q \in [0, 100]$)**: Measures inherent safety, liquidity depth, contract decentralization, and exit survivability.
2. **TRADE SCORE ($T \in [0, 100]$)**: Measures current momentum, volume pressure, order flow imbalance, and entry risk-reward.

**Rule**: A buy order is approved **only** if:
$$Q \ge Q_{\text{min}} \quad (default: 75) \quad \text{AND} \quad T \ge T_{\text{min}} \quad (default: 70)$$
and zero critical security flags are raised.

---

## 2. Quality Score Formula & Weight Breakdown

If any critical security violation occurs (honeypot, active mint, freeze capability, unlocked deployer LP, sell tax > 5%), $Q = 0$ immediately.

Otherwise, $Q$ is computed as the weighted sum of normalized component sub-scores:

$$Q = 0.30 \cdot S_{\text{security}} + 0.25 \cdot S_{\text{liquidity}} + 0.15 \cdot S_{\text{holders}} + 0.15 \cdot S_{\text{contract}} + 0.15 \cdot S_{\text{age}}$$

### Sub-Score Definitions
- $S_{\text{security}}$ (30%): Clean reports from two independent security engines (GoPlus + RugCheck/Honeypot.is) with zero blacklists or balance modification capabilities.
- $S_{\text{liquidity}}$ (25%): Measured from pool USD depth and LP lock duration:
  $$S_{\text{liquidity}} = \min\left(100, \frac{\text{Liquidity USD}}{50,000} \times 70 + \text{LockScore}\right)$$
- $S_{\text{holders}}$ (15%): Top 10 non-LP non-burn concentration:
  - If Top 10 $\le 15\% \implies 100$
  - If Top 10 between $15\% - 30\% \implies 70$
  - If Top 10 between $30\% - 50\% \implies 30$
  - If Top 10 $> 50\% \implies 0$
- $S_{\text{contract}}$ (15%): Source code verified, ownership renounced or locked in multi-sig, standard ERC20/SPL implementation, zero hidden transfer hooks.
- $S_{\text{age}}$ (15%): Pool age $\ge 72\text{h} \implies 100$, $24\text{h}-72\text{h} \implies 80$, $6\text{h}-24\text{h} \implies 50$, $< 6\text{h} \implies 20$.

---

## 3. Trade Score Formula & Weight Breakdown

The Trade Score models entry suitability on spot decentralized liquidity pools:

$$T = 0.30 \cdot M_{\text{momentum}} + 0.25 \cdot V_{\text{pressure}} + 0.20 \cdot L_{\text{depth}} + 0.15 \cdot S_{\text{structure}} + 0.10 \cdot R_{\text{regime}}$$

### Sub-Score Definitions
- $M_{\text{momentum}}$ (30%): Positive price change across 1h and 6h windows without parabolic over-extension:
  - Sweet spot: $+3\%$ to $+25\%$ on 1h, $+10\%$ to $+60\%$ on 24h.
  - Penalized if 1h change $> 150\%$ (dump risk).
- $V_{\text{pressure}}$ (25%): Buy-to-sell transaction volume ratio:
  $$\text{Ratio} = \frac{\text{Buy Transactions}}{\text{Buy Transactions} + \text{Sell Transactions}}$$
  Optimal range: $0.55 \le \text{Ratio} \le 0.75$. Values $> 0.85$ indicate bot-driven sniper clusters.
- $L_{\text{depth}}$ (20%): Capacity for trade size at $< 1.0\%$ price impact.
- $S_{\text{structure}}$ (15%): Sustained higher lows across stored snapshot intervals; absence of single-whale sell cliff.
- $R_{\text{regime}}$ (10%): Chain ecosystem benchmark (SOL, ETH, BNB trend over 24h).

---

## 4. Token Classifier Taxonomy

Each discovered token is classified into an operational archetype:

1. **ESTABLISHED_BLUECHIP**: Age $> 30$ days, Liquidity $> \$500\text{k}$, Volume $> \$1\text{M}$. Max position allowed: 100% of standard size.
2. **MID_CAP_GROWTH**: Age $> 7$ days, Liquidity $\$100\text{k} - \$500\text{k}$. Max position: 80% of standard size.
3. **EARLY_STAGE_INNOVATION**: Age $1 - 7$ days, Liquidity $\$25\text{k} - \$100\text{k}$. Max position: 40% of standard size.
4. **MEME_COMMUNITY**: Volatility $> 80\%$, high social velocity, LP burned. Max position: 25% of standard size.
5. **HIGH_RISK_MICRO**: Liquidity $<\$10\text{k}$ or age $< 6$ hours. **Auto-rejected by Risk Engine.**

---

## 5. Explainability Framework

Every token evaluation produces an explicit human-readable audit record:
```json
{
  "decision": "BUY_APPROVED",
  "quality_score": 88,
  "trade_score": 79,
  "risk_level": "LOW",
  "reasons": [
    "LP 100% burned on Raydium",
    "Mint authority revoked, freeze authority revoked",
    "1h momentum +8.4% with 62% buy-side volume",
    "Top 10 non-pool holders possess 11.2% total supply"
  ],
  "warnings": [
    "Pool age is 38 hours (< 72h preferred benchmark)"
  ]
}
```
If rejected:
```json
{
  "decision": "REJECTED",
  "quality_score": 0,
  "trade_score": 0,
  "risk_level": "CRITICAL",
  "reasons": [
    "FAIL_CLOSED: Sell tax dynamic or unverified (GoPlus returned 12% sell fee)",
    "Active mint authority detected on contract deployer"
  ],
  "warnings": []
}
```
