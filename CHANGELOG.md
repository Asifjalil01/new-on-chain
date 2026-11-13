# Changelog

All notable changes to the **On-Chain SPOT Bot** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.3.1] - 2026-10-07

### Fixed
- Fixed delayed/stale current-price updates by replacing tight fetch timeouts with 3,500 ms non-blocking resilient queries.
- Fixed backend, dashboard, and trailing-engine price synchronization by broadcasting calculated data freshness and price status over SSE `positions_batch_update`.
- Fixed dashboard flickering and unnecessary full refreshes by streaming price deltas directly and memoizing card components.
- Eliminated 429 rate limit spam in event logs with automatic silent domain backoff.
- Fixed premature stop loss triggers on entry fees by evaluating stop losses against asset price drawdown and adding a 15-second entry stabilization window.

### Added
- **Multi-Wallet Isolated Fee Schedules**: Added distinct fee schedules for Phantom (0.85%), Solflare (0.50%), MetaMask (0.875%), Trust Wallet (1.00%), Coinbase Wallet (1.00%), Ledger (0%), and Paper Vault (0.30%) with zero cross-wallet conflicts.
- **Risk Control Toggles**: Added interactive checkboxes for **Enable Stop Loss** and **Enable Max Holding Time** in Settings to allow enabling or disabling these exit rules on demand.
- **Expanded Multi-Pool DexScreener Discovery**: Added 28+ rotating discovery keyword pools across Solana DEXes, memes, and top tokens, expanding universe discovery capacity to hundreds of coins.

### Improved
- **Anti-Dumping Green Momentum Filter**: Tokens are approved for buy only when showing positive 1-hour price action (`p1h >= 0.5%`), positive 24-hour baseline (`p24h >= -2.0%`), and buyer dominance (`buyRatio >= 0.50`), preventing buys into red/dumping tokens.
- **Live Price Freshness Tracking**: Real-time `data_age_seconds` tracking with visual `LIVE (<=1s)` and `STALE (Xs)` price status badges.
- **Fee & Break-Even Accounting**: Precise roundtrip cost accounting and explicit **Break-Even Price** calculation (`break_even_price_usd`) displayed on all position cards.
- **Fee-Aware Trailing Exit**: Trailing exit tiers require positions to clear 100% of execution costs and reach net profitable territory before locking in gains.
- **Dual Telemetry**: Position cards and history display both Gross P&L % and Net P&L % after all on-chain fees.

### Trading / Risk
- Trailing exit considers actual/estimated roundtrip execution costs before determining whether a position has reached profitable territory.
- A position's original capital is strictly preserved and never treated as profit.
- Profit is calculated from the net result after applicable costs.
- Recovery watch mode exits automatically when price safely clears break-even (+0.5% buffer).
- When Stop Loss or Max Holding Time is unchecked in settings, the bot will not enforce those exit triggers.

---

## [2.3.0] - 2026-10-06

### Added
- **Solana Mainnet Real Swap Execution Engine**:
  - Full server-side keypair signer module (`SolanaLiveTrader.ts`) supporting Base58 and JSON secret key loading.
  - Live Jupiter v6 routing integration for executing real-time spot swaps across PumpSwap, Raydium, Meteora, and Orca.
  - Multi-endpoint RPC connection cluster with automatic rotation and failover.
  - Parsed on-chain transaction receipt verification (`getParsedTransaction`) to extract actual filled quantities, gas fees, and SOL deltas.
  - `/api/trading-signer` REST endpoints (`GET`, `POST`, `DELETE`) for autonomous keypair configuration.
- **Dynamic Solana Priority Fee Engine**:
  - Dynamic compute budget unit price calculation with configurable preset levels (`standard`, `high`, `ultra`) and explicit SOL priority fee settings (`0`, `0.002`, `0.005`, `0.01`, `0.015`, `0.02` SOL).
  - Maximum priority fee safety cap (`0.01` SOL limit) to protect against fee overspending during network congestion.
  - Itemized fee accounting separating Base Fee (5,000 lamports), Priority Fee, Jupiter/DEX fees, and ATA rent exemption costs with zero double-counting.
- **High-Frequency Real-Time Live Market Price Streaming (<= 1s)**:
  - 1-second high-frequency price update loop fetching live liquidity pool prices by exact `pair_address`.
  - Stale data detection marking prices STALE if no tick is received within 3 seconds.
  - Real-time price velocity streaming feeding directly into the unchanged trailing profit, breakeven recovery, and rug-defense engines without full page reloads.

### Improved
- **Itemized Execution Accounting**:
  - P&L calculations account for exact on-chain fee deltas returned in confirmed transaction receipts.
  - Phantom treated strictly as a wallet adapter without applying phantom swap fee markups.
- **Documentation & Release Configuration**:
  - Updated README.md and version metadata across all application components.

### Fixed
- Fixed TypeScript type constraints and async/await error handling across live order submission loops.

---

## [2.2.3] - 2026-10-06

### Critical Market Data & Real-Time On-Chain Pricing Engine Overhaul
- **Purged Random Price Walk from Position Monitoring**:
  - Removed artificial random noise updates (`(Math.random() - 0.47) * 0.02`) that previously caused open position prices to drift from real market values over time.
  - Implemented `updateOpenPositionsMarketPrices()`: queries real live on-chain prices via DexScreener verified pair and token endpoints (`/latest/dex/pairs/{chainId}/{pairAddresses}`).
  - Evaluates trailing stops, profit targets, and stop losses strictly against verifiable live DEX liquidity pool prices.
- **Exact Pair, DEX, and Quote Token Binding**:
  - Bound all tokens and open positions to their exact liquidity pool (`pair_address`), exchange (`pumpswap`, `raydium`, `meteora`, `orca`, `uniswap`), quote token (`SOL`, `USDC`, `ETH`), and contract decimals.
  - Position cards and Token Detail view display verified pair names (e.g. `BACKERS/SOL`), quote asset, pair addresses with 1-click DexScreener links, and real-time data ages.
- **Market Data & Price Verification Debug Panel**:
  - Added live Market Data verification panel on Token Detail View showing Token Contract, Pair/Pool Address, Bot Reference Price, DexScreener Live Price, Quantified Difference %, Price Source, Data Age Timestamp, Liquidity, 24h Volume, and Expected Execution Estimate (including estimated price impact and slippage).
  - Added dedicated endpoint `GET /api/market-price` for instant on-demand comparison against DexScreener.
- **Structured Transparent Market Logging**:
  - Structured `[MARKET_DATA]` logging output containing Token Symbol, Address, Pair, Pair Address, Price Source, Exact Live Price, Timestamp, Data Age, and Liquidity.

---

## [2.2.2] - 2026-10-06

### Critical Fixes & Wallet Architecture Overhaul
- **Strict Real-World On-Chain Wallet Balance Integration**:
  - Completely purged hardcoded/mock placeholder balances (`4.825 SOL`, `0.842 ETH`, `2.15 BNB`, etc.) from all client wallet adapters.
  - Implemented direct on-chain JSON-RPC balance fetching (`queryOnChainBalance`) querying official Solana Mainnet RPC nodes (`https://api.mainnet-beta.solana.com`, with fallback to Ankr & PublicNode).
  - Retrieves exact account lamports (`getBalance`) and converts to live SOL balance and real-time USD valuation via DexScreener live pairs.
  - Added dedicated endpoint `GET /api/wallets/balance` and live wallet diagnostics endpoint `GET /api/wallets/diagnostics`.
- **Seamless Phantom / Solflare & Browser Wallet Synchronization**:
  - Bound real browser provider lifecycle events (`window.solana.on('accountChanged')`, `window.solana.on('disconnect')`, `window.solana.on('connect')`) to detect account switches in real time.
  - Synchronizes the connected public key and on-chain balance to the backend engine via `POST /api/wallets/connect`.
  - Display shortened public address (e.g., `7xK...9Ab`) with full 1-click address copy in header and diagnostics panels.
- **Strict Separation of Funds & Live Capital Accounting**:
  - Paper simulation balance (`$1,600.00`) is strictly isolated and never displayed in Live mode.
  - In Live mode, Total Capital and Available Cash reflect the actual USD valuation of the connected on-chain wallet balance minus open position cost basis.
  - Startup pre-flight validation verifies: Real wallet connected, Solana Mainnet network, actual on-chain SOL balance >= Trade Allocation + Safety Gas Reserve, and valid signing capability.
- **Wallet Diagnostics & On-Chain Audit Panel**:
  - Added real-time diagnostics dashboard in the Wallets tab showing Provider, Network, Public Address, Blockchain Balance, Backend Synchronization State, Signing Capability, Live Readiness, and 1-click **REFRESH BALANCE** button.
  - Added Watch-Only public address verification and audit mode for headless and non-extension environments.

---

## [2.2.0] - 2026-10-06

### Added
- **Multi-Source Real-Time Discovery Engine**:
  - Combined DexScreener Top Boosts (`/token-boosts/top/v1`), Latest Boosts (`/token-boosts/latest/v1`), Token Profiles (`/token-profiles/latest/v1`), and Community Takeovers (`/community-takeovers/latest/v1`).
  - Integrated GeckoTerminal New Pools (`/networks/{net}/new_pools?page=1&page=2`), Trending Pools (`/trending_pools?page=1&page=2`), and Top Volume Pools across all supported networks.
  - Rate-limited batch token address enrichment (`/tokens/v1/{chainId}/{addresses}`) slicing up to 30 addresses per call with 429 exponential backoff.
  - Evaluates hundreds to thousands of live market candidates every cycle.
- **Two-Stage Quantitative Filtering Architecture**:
  - **Stage 1 (Hard Reject Pre-Filter)**: Enforces configurable safety floors:
    - Min Liquidity: `$25,000` (rejects thin pools prone to slippage and rug pulls).
    - Min 24h Volume: `$50,000` (rejects dead contracts and inactive pools).
    - Min 24h Transactions: `200` combined buys/sells.
    - Min Estimated Traders: `100` (filters out single-actor bot manipulation).
    - Minimum Maturity: `30 minutes` anti-sniper gate.
    - Maximum Age: `365 days` (filters out multi-year dead contracts).
    - Wash Trading Protection: Vol/Liq ratio `> 40x` without broad trader breadth rejected as circular bot churning.
    - Dilution Cliff Protection: FDV/Liq ratio `> 100x` rejected.
  - **Stage 2 (Survivor Deep Inspection)**:
    - 9-Layer Rug Defense Engine with contract verification, mint/freeze authority checks, LP burn verification, top-10 concentration audit, and tax simulations.
    - Momentum scoring across 5m, 1h, 6h, and 24h price action with vertical pump damping (+500% gain damping to prevent top-ticking).
  - Every rejected token now stores its exact rejection cause (e.g. `INSUFFICIENT_LIQUIDITY: $10,000 < $25,000 min`), making the `REJECT` filter count reflect real filtered coins.
- **Dynamic Slot Rotation & Position Lifecycle**:
  - Hard Stop Loss: `-8.0%` drawdown triggers exit (`STOP_LOSS_HIT`).
  - Stagnation Timeout: Positions held `> 4.0 hours` with `< 5.0%` gain trigger exit (`MAX_HOLDING_TIMEOUT`).
  - Stepped Trailing Profit Ladder: Captures early gains starting at +5% (drop 1%), +10% (drop 1.5%), +15% (drop 2%), +20% (drop 1%), etc.
  - Slot Rotation: When all 5 position slots are occupied, automatically identifies the weakest stagnant position (holding > 15m, gain < 2%, score < 70) and rotates it to capture a newly discovered runner with score `>= 85`.
- **Seen-Tokens Registry & Discovery Telemetry**:
  - Persistent registry tracking `first_seen_at`, `last_scanned_at`, `last_score`, `times_evaluated`, and `source`.
  - Live intake funnel stats banner: Candidates Evaluated, Pre-Filter Passed, Deep Audited, Rejected (with breakdown), and New Discovered.
  - Added "RESET SEEN CACHE" button in the Scanner view and API route `POST /api/control` (`reset_seen_cache`).
- **Discovery Coverage Panel**:
  - Added new unique tokens per hour, repeated vs. new ratio, provider health meters, and per-chain discovery breakdown.
- **Unit Test Suite (`tests/test_filters.py`)**:
  - Comprehensive unit tests covering liquidity rejection, volume rejection, transaction floor, wash trading detection, pool deduplication, and position exit rules.

### Fixed
- **Root Cause A (Hardcoded Placeholder Seed Data)**:
  - Removed static seed tokens with hardcoded `420 / 310` transactions, `2d` age, and 92/92 scores in `initializeData()`.
  - Startup now immediately triggers an active live multi-source discovery sweep without pre-filling slots with fake buys.
- **Root Cause B (Limited & Static Keyword Searching)**:
  - Replaced single-word searches (`pump`, `ai`, `cat`, `dog`, `goat`) that returned dead legacy coins with real-time trending/new-pool discovery across DexScreener and GeckoTerminal.
- **Root Cause C (Persistent In-Memory Stagnation)**:
  - Added Seen Tokens database with TTL, continuous metric updates, and manual cache reset capability.
- **Root Cause D (5/5 Frozen Position Slots)**:
  - Added stop-loss, max holding duration, and slot rotation so open positions exit dynamically and rotate to top-ranking momentum runners.
- **Root Cause E (Zero Rejections & Junk Approvals)**:
  - Fixed security and strategy scoring defaults that previously approved dead coins with $0.10 volume. The `REJECT` status now actively catches and explains hundreds of disqualified coins.

---

## [2.1.1] - 2026-10-06

### Added
- **Automatic `trades_log.csv` Trade Record**:
  - Automatically creates and maintains `trades_log.csv` in the project root and public downloads.
  - Every coin purchase records complete entry details with status `OPEN` (buy price, quantity, cost, order ID, pre-trade fee estimates).
  - Every coin sale records complete exit details with status `CLOSED`, exact exit price, actual realized P&L after all fees, hold time (seconds and human-readable), result (`WIN`/`LOSS`), and trailing exit reason.
  - Complete history is preserved permanently through sequential append operations.
  - Added direct download button in the History tab and API route `GET /api/export/trades_log.csv`.
- **Multi-Source Broad Token Discovery Pipeline**:
  - Combined DexScreener Top Boosts (`/token-boosts/top/v1`), Latest Boosts (`/token-boosts/latest/v1`), and Token Profiles (`/token-profiles/latest/v1`).
  - Integrated GeckoTerminal trending and new liquidity pools (`/networks/{network}/trending_pools`).
  - Implemented dynamic 60+ keyword catalog with automated query rotation (5 rotating keywords per scan cycle) across all 8 supported chains.
  - Automated batch token address enrichment (`/tokens/v1/{chain}/{addrs}`).

### Fixed
- **Repeated Selection of the Same Limited Coins**:
  - Replaced the static 6-ticker query list (`RAY`, `JUP`, `BONK`, `WIF`, `POPCAT`, `SOL`) with the dynamic multi-source rotating discovery engine.
  - Replaced the first-match auto-buy loop with a global candidate ranking engine that evaluates all newly discovered qualifying tokens across the market.
- **Duplicate Liquidity Pool Clutter in Scanner**:
  - Fixed universe indexing from `${chain}_${tokenAddress}_${pairAddress}` to strictly `${chain}_${tokenAddress}`.
  - Multiple pools of the same token (e.g. Raydium, Orca, Meteora) are now automatically consolidated into a single canonical entry based on highest pool liquidity.
  - Every single row in the Scanner table is now a genuinely unique coin/token.
- **Auto-Buy Stagnation**:
  - Enhanced candidate selection to prioritize newly discovered qualifying coins while strictly preventing duplicate open positions for the same token.

### Changed
- Baseline cold-start seeds upgraded to 12 distinct tokens across chains without duplicate pools.
- Enhanced candidate sorting algorithm to boost newly discovered qualifying coins (`trade_score + quality_score + discovery_bonus`).

### Documentation
- Updated `README.md` with `trades_log.csv` specification and release tag `v2.1.1`.

---

## [2.1.0] - 2026-10-05

### Added
- **Multi-Wallet Support (`WalletManager.ts`)**:
  - Modular multi-wallet provider architecture supporting **MetaMask**, **Phantom**, **Trust Wallet**, **Coinbase Wallet**, **Solflare**, and internal **Hot/Paper Vaults**.
  - Interactive Wallet Connect Modal (`WalletConnectModal.tsx`) allowing users to connect, switch active trading wallets, and view native balances.
  - Extensible provider pattern allowing new wallet integrations without altering core bot logic.
- **Per-Trade Capital Allocation & Currency Selection**:
  - Added configurable per-trade allocation amount and currency (e.g. `0.005 SOL`, `0.01 SOL`, `10 USDT`, `25 USDC`).
  - Strict enforcement: The bot **never intentionally exceeds the configured trading amount**.
  - Native Gas Reservation protocol (`minGasReserveSol: 0.02 SOL`, `minGasReserveEth: 0.005 ETH`): prevents trades from executing if the wallet cannot safely maintain gas for future operations.
- **Comprehensive Multi-Chain Fee Engine (`FeeCalculator.ts`)**:
  - Pre-trade cost calculation covering:
    - Blockchain network/gas fees (Solana base lamports & EVM gas * gwei).
    - Priority fees / compute unit tips (congestion-responsive).
    - DEX execution fees (Raydium, Orca, Uniswap, Aerodrome, PancakeSwap).
    - Associated Token Account (ATA) rent-exempt creation fees on Solana (~0.00203928 SOL).
    - Token contract taxes (buy/sell tax inspection).
    - Verified DEX Screener charges $0.00 (read-only market indexer attribution).
  - Pre-trade balance sufficiency validation: aborts trades if wallet balance cannot cover trade amount + all required fees + gas reserve.
  - Post-trade actual fee recording: stores actual gas and DEX fees paid with confirmed transaction receipts.
- **Fee Transparency UI (`FeeBreakdownCard.tsx`)**:
  - Live itemized fee display separating Trade Amount, DEX Fee, Network Fee, Priority Fee, ATA Rent, Total Fees, and Total Cost.
- **GitHub Versioning & Release Infrastructure**:
  - Standardized SemVer release tags (`v2.1.0`, `v2.0.0`).
  - Automated package archive script (`scripts/create_archive.py`) and direct in-app download endpoint.

### Changed
- **Exact Dollar Display Consistency**:
  - Removed all abbreviation formatting (`$1.6K`, `$850K`, `$2.4M`).
  - Consistently displays exact un-abbreviated dollar values across all views:
    - Total Capital: `$1,600.00`
    - Available Cash: `$850.50`
    - Invested Capital: `$749.50`
    - Unrealized P&L: `+$35.25`
    - Realized P&L: `+$120.00`
    - Open Position costs, values, and fees.
- **DEX Scanner Multi-Query Sweeps**:
  - Upgraded Solana search enumerator to rotate through diverse liquid tokens (`RAY`, `JUP`, `BONK`, `WIF`, `POPCAT`, `SOL`).
- **Autonomous Paper Execution**:
  - Enabled active default paper trading loop on startup with live open positions and active event logs.

### Fixed
- Fixed scanner category counts and buy-state transitions.
- Fixed Event Log feed to capture every step of the decision pipeline (`DISCOVERY`, `SECURITY_PASS`, `STRATEGY_SCORE`, `BUY_APPROVED`, `BUY_EXECUTED`).

---

## [2.0.0] - 2026-10-05

### Added
- Complete rewrite from v1 Python prototype to production-grade Node.js/TypeScript and Python dual-engine architecture.
- 9-Layer Fail-Closed Rug Defense Engine (`L1_MARKET_SANITY` through `L9_TWO_SOURCE`).
- Trailing-profit exit engine with absolute ban on stop-loss and gap-down `RECOVERY_WATCH` handling.
- SQLite WAL transaction ledger with automated CSV export.
- Consolas dark/light terminal dashboard with 2-column open position cards, Quick Stats, and bounded Event Log.
