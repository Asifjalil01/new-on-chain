# AUDIT REPORT: ON-CHAIN SPOT BOT v1 DEFECT CONFIRMATION & v2 RESOLUTIONS

This audit compares the defect points identified in Section 2 of the specification against the v1 implementation and establishes the exact architectural fixes in v2.

---

## 1. Security Engine Defect
- **v1 Defect**: Security checks relied on `MockSecurityProvider` combining address hashes with `random()`. As a result, 100% of malicious tokens (honeypots, unrenounced mints, unlocked LP, blacklists) passed silently into trade consideration.
- **v2 Fix**: 
  - Implemented multi-layered **Rug Defense Engine** (Layers L1 through L9).
  - Integrates GoPlus, Honeypot.is, RugCheck, and on-chain RPC reads.
  - Fail-closed design: missing or conflicting data returns `UNAVAILABLE` or `BLOCK`, never a passing score.
  - Mandatory local buy AND sell simulation (`eth_call` / simulateTransaction) checking real transfer restrictions, dynamic taxes, and revert conditions.
  - Two-source rule: any PASS requires confirmation by two independent providers or one provider plus verified on-chain simulation.

---

## 2. Metric Hardcoding and Free Points for Missing Data
- **v1 Defect**: Crucial fields such as `holders`, `token_age_hours`, `volatility`, and `social_score` were hardcoded to `0`. The scoring engine awarded positive default points for zero/missing values.
- **v2 Fix**:
  - Absolute rule: **No fake or defaulted data**.
  - Missing data is stored as `None` / `null` and displayed as `DATA UNAVAILABLE`.
  - Quality score is forced to `0` whenever critical security or liquidity fields are absent.
  - Real calculations for token age from pool creation timestamps (`pairCreatedAt`), holder distribution from block explorer/RPC endpoints, and price volatility from multi-point historical snapshots.

---

## 3. Decision Pipeline Bypass
- **v1 Defect**: The bot bought tokens whenever `item["tradeable"]` was true, completely bypassing the safety checks in `build_decision`.
- **v2 Fix**:
  - Enforced strict linear pipeline:
    `DISCOVERY -> DATA VALIDATION -> SECURITY ENGINE -> RISK ENGINE -> STRATEGY ENGINE -> TRADE APPROVAL -> EXECUTION SIMULATION -> EXECUTION -> POSITION MANAGEMENT -> EXIT ENGINE`.
  - Strategy signals cannot directly place orders; they can only produce a trade proposal that must pass the Risk and Execution Simulation gates.

---

## 4. Discovery Feeds and Arbitrary Truncation
- **v1 Defect**: Discovery used only 4 DexScreener promo feeds (profiles, boosts), one chain at a time, truncated to a hard limit (`scan_limit=1200`). This resulted in near-zero universe coverage and high exposure to paid promotional tokens.
- **v2 Fix**:
  - Multi-tier discovery funnel combining DexScreener profile/boost feeds, rotating search sweeps (quote pairs, DEX names, common stems), pool expansion (`/token-pairs/v1`), GeckoTerminal paginated pool lists, and on-chain factory events (`PairCreated`/`PoolCreated`).
  - No top-N truncation. The entire universe is stored in the `universe` SQLite registry and prioritized via a 4-tier scheduling funnel.

---

## 5. UI Thread Blocking & Responsiveness
- **v1 Defect**: Blocking HTTP requests were executed on the Tkinter main event thread during scans and the 1-second price refresh loop, causing severe UI freezing and lag.
- **v2 Fix**:
  - Python engine runs all I/O asynchronously via `asyncio` in a dedicated background daemon thread.
  - Thread-safe event queue feeds the UI via `root.after()` polling.
  - Web UI uses responsive asynchronous API polling and optimistic UI updates without blocking rendering.

---

## 6. Race Conditions, Stacking Loops & PAUSE Failure
- **v1 Defect**: PAUSE button was a no-op; clicking START or PAPER TEST multiple times spawned concurrent, un-cancellable scan loops; STOP did not cancel pending tasks.
- **v2 Fix**:
  - Idempotent state machine: `START` checks current runner state before spawning; `PAUSE` halts new order execution while keeping position monitoring active (`BUYING PAUSED`); `STOP` gracefully cancels all active scheduler tasks via task handles.

---

## 7. Trailing Profit Gap-Down and Loss Handling
- **v1 Defect**: If a token gapped down through the trailing profit floor into negative territory, the exit logic failed to trigger, and the stored peak was erased or corrupted. Positions under +20% had undefined states.
- **v2 Fix**:
  - Defined explicit lifecycle states: `HOLDING`, `PROFIT_MONITORING`, `RECOVERY_WATCH`, `EXIT_CANDIDATE`, `SOLD`, `EMERGENCY_*`.
  - Gap-Down Policy: If price falls through the floor into a loss after a tier was reached, the peak profit is permanently preserved, the token transitions to `RECOVERY_WATCH`, and exits on the first net breakeven return.
  - Absolute ban on stop-losses: normal market fluctuations are never sold at a loss; only profits, manual sells, or verified emergency safety events trigger exits.

---

## 8. Ephemeral State & Key Collisions
- **v1 Defect**: Re-buy cooldown was stored only in a session memory dictionary and lost on restart. Positions were keyed only by `token_address`, causing collisions across multi-chain deployments.
- **v2 Fix**:
  - Compound primary key `(chain, token_address, pair_address)` across database, memory cache, and logs.
  - SQLite WAL persistence for positions, cooldown timers, trade history, and universe registry.
  - Strict re-buy protection requiring full re-qualification after cooldown expiration.

---

## 9. Chain Adapter Inconsistencies & Typo Bugs
- **v1 Defect**: Chain adapters were incomplete stubs; `arbitrum` was visible in the GUI but absent in the factory; `avalanche` was missing; class name typo `BNBBChainAdapter`.
- **v2 Fix**:
  - Clean `ChainAdapter` base class and concrete implementations for all 8 supported chains: Solana, Ethereum, BSC, Base, Arbitrum, Polygon, Avalanche, Optimism.
  - Normalized chain aliases (`sol, solona -> solana`, `bnb, binance -> bsc`) via a centralized validation function.

---

## 10. Paper Fill Realism
- **v1 Defect**: Paper trading simulated instant zero-cost fills at quoted midpoint price, completely ignoring slippage, price impact, DEX fees, gas costs, and token buy/sell taxes.
- **v2 Fix**:
  - Realistic mathematical execution simulator: computes price impact from pool liquidity depth ($x \cdot y = k$ and concentrated liquidity models), standard DEX fee (0.3% / tier), token buy/sell tax, and network gas fee.
  - Net P&L accounts for every cost item; gross and net values are tracked separately.
