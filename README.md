# ◈ ON-CHAIN SPOT BOT v2.3.1

Professional Multi-Chain On-Chain SPOT Trading Bot with Real Solana Mainnet Swap Execution, Server-Side Keypair Signer, Jupiter Router, Dynamic Priority Fee System, Fee-Aware Trailing Profitability, Sub-Second Market Price Streaming, Rug & Honeypot Defense, Multi-Source Universe Scanner, Multi-Wallet Integration, Real On-Chain RPC Auditing, and Automated `trades_log.csv` Accounting.

[![Version](https://img.shields.io/badge/version-v2.3.1-teal.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10%2B-brightgreen.svg)]()
[![Node.js](https://img.shields.io/badge/node-18%2B-green.svg)]()

---

## 📋 What's New in v2.3.1

- **Expanded Multi-Pool DexScreener Discovery Scanner**:
  - Expanded search query engine across 28+ rotating discovery keyword pools covering top DEXes (`raydium`, `pump`, `meteora`, `orca`), categories, and trending tokens.
  - Automatically scales universe discovery capacity to hundreds of active tokens across cycles.
  - Eliminated event log rate limit spam with intelligent silent domain backoff for 429 responses.
- **Anti-Dumping & Green Momentum Filter (Zero Red Token Buys)**:
  - Strict green momentum requirement for `BUY_APPROVED` status: requires positive 1-hour price action (`p1h >= 0.5%`), healthy 24-hour baseline (`p24h >= -2.0%`), and buyer dominance (`buyRatio >= 0.50`).
  - Tokens experiencing dumps or heavy sell pressure are retained in `WATCHLIST` or `ANALYZING` until buyers return.
- **User-Configurable Stop Loss & Max Holding Time Toggles**:
  - Interactive checkboxes for **Enable Stop Loss** and **Enable Max Holding Time** in Settings.
  - Stop loss drawdown and max holding time stagnation exits are applied only when checked; unchecking disables them completely.
- **Multi-Wallet Isolated Fee Schedules (Zero Conflict)**:
  - Dedicated fee profiles for **Phantom** (0.85% swap fee, ~$0.05 gas, $0.31 ATA rent), **Solflare** (0.50% swap fee, ~$0.04 gas, $0.31 ATA rent), **MetaMask** (0.875% protocol fee, ~$0.15 EVM gas), **Trust Wallet** (1.00%), **Coinbase Wallet** (1.00%), **Ledger** (0% hardware markup), and **Paper Vault** (0.30% simulated fee).
  - Trades and positions automatically adopt the active connected wallet's fee schedule, avoiding cross-wallet conflicts.
  - Added visual fee schedule matrix in the Wallets tab and fee badges in the Wallet Connect modal.
- **Fee-Aware Trailing Profitability & Break-Even System**:
  - Trailing exit tiers activate only after a position clears 100% of roundtrip execution costs (entry DEX fee, entry gas/priority fee, exit DEX fee, and estimated exit network costs).
  - Original capital is strictly preserved and never treated as profit.
  - Computes and displays exact **Break-Even Price** on every open position card.
  - Recovery watch mode exits automatically once a position recovers to break-even (+0.5% safety buffer).
- **Sub-Second Live Price Streaming & Dashboard Optimization**:
  - Sub-second price telemetry streamed via SSE (`positions_batch_update`) updating only changed price points without full dashboard re-renders or screen flicker.
  - Optimized DexScreener price queries with non-blocking 3,500 ms timeouts.
  - Real-time data age calculation (`data_age_seconds`) with dynamic `LIVE (<=1s)` and `STALE (Xs)` price status badges.
- **Dual Gross vs. Net Profit Telemetry**:
  - Position headers display both Gross P&L % and Net P&L % (net of all entry, exit, and on-chain network costs).

---

## 📋 What's New in v2.3.0

- **Real Solana Mainnet BUY & SELL Execution Engine**:
  - Full server-side autonomous keypair signing (`src/trading/SolanaLiveTrader.ts`) with encrypted memory isolation.
  - Live Jupiter v6 Swap Aggregator (`/v6/quote` & `/v6/swap`) routing across PumpSwap, Raydium (CPMM, AMM v4, CLMM), Meteora (DLMM & Dynamic Pools), and Orca.
  - Multi-endpoint Solana RPC failover cluster (`api.mainnet-beta.solana.com`, `rpc.ankr.com/solana`, `solana-rpc.publicnode.com`).
  - Parsed transaction receipt auditing (`getParsedTransaction`) for exact fill quantities and on-chain balance deltas.
- **Dynamic Priority Fee & Safety System**:
  - Supports dynamic compute unit pricing (microLamports) and explicit SOL priority fee configuration (`0`, `0.002`, `0.005`, `0.01`, `0.015`, `0.02` SOL).
  - Safety cap (`0.01` SOL max priority fee limit) to prevent fee overspending during high network congestion.
  - Clear itemized accounting separating Solana Base Fee (5,000 lamports), Priority Fee, Jupiter/DEX fees, and ATA rent costs with zero double-counting.
- **High-Frequency Real-Time Live Price Streaming (<= 1 Second)**:
  - High-frequency 1-second price monitoring ticker querying on-chain pools directly by exact `pair_address` and `token_address`.
  - Stale market data detection (marks data stale if no tick received within 3s).
  - Real-time price velocity streaming feeds directly into the unchanged trailing profit and rug-defense engines without full page reloads.
- **Autonomous Signer API & Settings**:
  - Secure `/api/trading-signer` endpoints for loading server keypairs from env vars (`SOLANA_PRIVATE_KEY` / `SOLANA_SECRET_KEY`) or encrypted input.
  - Phantom treated strictly as a wallet/signer interface without phantom swap fee markups.

- **Real On-Chain Wallet Integration (Zero Mock Balances)**:
  - Removed all hardcoded balances (`4.825 SOL`, `0.842 ETH`, `2.15 BNB`, etc.). Real live balances are queried directly from Solana Mainnet JSON-RPC (`https://api.mainnet-beta.solana.com`).
  - Fetches real account lamports (`getBalance`) and computes live USD balance using real-time DexScreener asset pricing.
  - Dedicated `/api/wallets/balance` and `/api/wallets/diagnostics` endpoints.
- **Synchronized Phantom & Browser Wallet State**:
  - Automatically synchronizes connected browser public addresses (`window.solana.publicKey`) with the backend trading engine.
  - Detects wallet account switches and disconnections via native event listeners (`accountChanged`, `disconnect`).
  - Displays shortened addresses (`7xK...9Ab`) with 1-click full address copy across the header and wallets views.
- **Strict Separation of Capital & Live Mode Financial Integrity**:
  - Paper simulated funds (`$1,600.00`) are isolated to Paper mode only.
  - In Live mode, Total Capital and Available Cash are computed exclusively from the verified on-chain wallet balance.
  - Startup pre-flight validation verifies: Real wallet connected, Solana Mainnet network, actual on-chain SOL balance >= Trade Allocation + Safety Gas Reserve, and valid signing capability.
- **Wallet Diagnostics Dashboard**:
  - Real-time diagnostics dashboard in the Wallets tab showing Provider, Network, Public Address, Blockchain Balance, Backend Synchronization State, Signing Capability, Live Readiness, and 1-click **REFRESH BALANCE** button.
  - Watch-Only mode allows auditing any public address on-chain live.

---

## 📋 What's New in v2.2.0

- **Multi-Source Real-Time Token Discovery Pipeline**:
  - Live discovery across **DexScreener** (Top Boosts, Latest Boosts, Profiles, Community Takeovers) and **GeckoTerminal** (New Pools, Trending Pools, Top Volume Pools) across Solana, Base, Ethereum, and BSC.
  - Slices discovered token addresses into batches of 30 for high-throughput batch enrichment via DexScreener `/tokens/v1/{chain}/{addresses}` with concurrency and rate limiting.
  - Evaluates hundreds to thousands of fresh candidates per cycle instead of obsolete single keywords.
- **Two-Stage Quantitative Filtering Architecture**:
  - **Stage 1 (Hard Reject Pre-Filter)**: Enforces hard quantitative safety rules:
    - Min Liquidity: `$25,000` (rejects thin pools prone to slippage and rugs).
    - Min 24h Volume: `$50,000` (rejects dead contracts and stale pools).
    - Min 24h Transactions: `200` combined buys/sells.
    - Min Traders: `100` (filters out single-actor bot manipulation).
    - Min Maturity: `30 minutes` anti-sniper gate.
    - Max Age: `365 days` (filters out multi-year dead contracts).
    - Wash Trading Protection: Vol/Liq ratio `> 40x` without high trader breadth rejected.
    - Dilution Cliff Protection: FDV/Liq ratio `> 100x` rejected.
  - **Stage 2 (Deep Survivor Audit)**:
    - 9-Layer Rug Defense Engine with contract verification, mint/freeze authority checks, LP burn verification, top-10 concentration audit, and tax simulations.
    - Momentum scoring across 5m, 1h, 6h, and 24h price action with vertical pump damping (+500% gain damping to prevent top-ticking).
  - Every rejected token now stores its exact rejection reason, actively populating the `REJECT` filter in the UI with full explainability.
- **Dynamic Slot Rotation & Position Lifecycle**:
  - Hard Stop Loss: `-8.0%` drawdown triggers exit (`STOP_LOSS_HIT`).
  - Stagnation Timeout: Positions held `> 4.0 hours` with `< 5.0%` gain trigger exit (`MAX_HOLDING_TIMEOUT`).
  - Stepped Trailing Profit Ladder: Captures early gains starting at +5% (drop 1%), +10% (drop 1.5%), +15% (drop 2%), +20% (drop 1%), etc.
  - Slot Rotation: Automatically rotates the weakest stagnant slot (held > 15m, gain < 2%, score < 70) when a top runner with score `>= 85` is discovered.
- **Seen Tokens Database & Discovery Telemetry**:
  - Persistent registry tracking `first_seen_at`, `last_scanned_at`, `last_score`, `times_evaluated`, and `source`.
  - Live intake funnel stats banner in the Scanner tab with 1-click **RESET SEEN CACHE** capability.
- **Discovery Coverage Panel**:
  - Added new unique tokens per hour, repeated vs. new ratio, provider health meters, and per-chain discovery breakdown.

---

## 📋 What's New in v2.1.1

- **Automated `trades_log.csv` Ledger**:
  - Automatically created and maintained on disk in the project root (`./trades_log.csv`).
  - Records full buy details when entered (`status: OPEN`) and full sell details when exited (`status: CLOSED`).
  - Computes exact realized net P&L after all applicable fees (DEX, network gas, priority tips, ATA rent, taxes).
  - Tracks holding times (seconds & human-readable), trailing exit reasons, peak profit percentages, and balances.
  - Direct 1-click download in the History tab and via `/api/export/trades_log.csv`.
- **Broad Multi-Source Coin Discovery**:
  - Replaced the previous limited coin query list with a multi-source discovery engine querying DexScreener Top Boosts, Latest Boosts, Token Profiles, GeckoTerminal Trending Pools, and a rotating 60+ keyword catalog.
  - Strict token deduplication: multiple liquidity pools of the same coin are consolidated into a single canonical entry using the highest-liquidity primary pool.
  - Candidate selection sorts across the entire market and prioritizes newly discovered opportunities while strictly excluding coins already held in open positions.

---

## 📋 What's New in v2.1.0

- **Multi-Wallet Support (`WalletManager.ts`)**: Modular support for **Phantom**, **MetaMask**, **Trust Wallet**, **Coinbase Wallet**, **Solflare**, and internal **Hot Vaults**. One-click connect, switch, and balance inspection.
- **Configurable Per-Trade Capital Allocation**: Set exact trade sizes (e.g. `0.005 SOL`, `0.01 SOL`, `10 USDT`, `25 USDC`). The bot strictly adheres to this limit and **never intentionally exceeds the configured trading amount**.
- **Transparent Multi-Chain Fee Engine (`FeeCalculator.ts`)**:
  - Calculates and accounts for **all applicable fees** before execution:
    - Blockchain network/gas fees (Solana base lamports & EVM gas * gwei).
    - Congestion-responsive priority fees / compute unit tips.
    - DEX execution fees (Raydium, Orca, Uniswap, Aerodrome, PancakeSwap).
    - Associated Token Account (ATA) rent-exempt creation fees on Solana (~0.00203928 SOL).
    - Token contract taxes (buy/sell tax inspection).
    - Explicit confirmation: DEX Screener charges **$0.00** trading fee (data indexer only).
  - Pre-trade safety check: Aborts trades if wallet balance cannot cover trade amount + all required fees + minimum safety gas reserve.
  - Post-trade actual fee recording: Confirms actual gas and DEX fees paid with transaction receipts for exact P&L accounting.
- **Exact Dollar Display Consistency**: All financial values (Total Capital, Available Cash, Invested, P&L, Balances, Position costs) displayed in exact un-abbreviated dollars (e.g. `$1,600.00`, `$850.50`, `+$35.25`, `$120.00`) without `$1.6K` or `$850K` truncation.
- **GitHub Release & SemVer Tracking**: Full `CHANGELOG.md` maintaining version histories, tag guides, and release archives.

---

## 🚀 Quick Start (Running Locally with the Exact Same GUI)

This package contains the complete full-stack application (backend proxy + React GUI + Python core engine).

### Prerequisites
- **Node.js**: v18.0.0 or higher ([Download from nodejs.org](https://nodejs.org/))
- **Python**: 3.10+ (for standalone CLI engine and unit test runner)

---

### Method A: One-Click Startup (Easiest)

- **On Windows**: Double-click `start.bat`.
- **On macOS / Linux**: Open your terminal in this directory and run:
  ```bash
  chmod +x start.sh
  ./start.sh
  ```

Your browser will automatically open to **`http://localhost:3000`** displaying the exact same dark-mode terminal GUI.

---

### Method B: Manual Command Line

1. Open a terminal in this directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server & engine:
   ```bash
   npm run dev
   ```
4. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## 👛 Multi-Wallet Architecture

The wallet system is designed with a pluggable adapter pattern in `src/wallets/WalletManager.ts`:
- **Solana Wallets**: Phantom, Solflare, Injected Solana Provider.
- **EVM Wallets**: MetaMask, Trust Wallet, Coinbase Wallet, Injected `window.ethereum`.
- **Hot / Paper Vault**: Built-in deterministic testnet/paper execution vault.

To connect or switch wallets in the UI:
1. Click the **`SELECT WALLET`** button in the top-right header or in the **`WALLETS`** tab.
2. Select your preferred provider (Phantom, MetaMask, Trust Wallet, etc.).
3. The dashboard and status strip will automatically reflect the connected address, native token balance, and safety gas reserves.

---

## 💰 Capital Allocation & Fee Calculation Protocol

### Example Trade Configuration
- **Trade Allocation**: `0.005 SOL`
- **Safety Gas Reserve**: `0.020 SOL` (minimum SOL that must remain in wallet for future transactions)

Before any trade is dispatched, the fee engine executes the following verification pipeline:

$$\text{Total Required Outlay} = \text{Trade Amount} + \text{DEX Fee} + \text{Network Base Gas} + \text{Priority Tip} + \text{ATA Rent (Solana)} + \text{Token Tax}$$

$$\text{Wallet Balance} - \text{Total Required Outlay} \ge \text{Safety Gas Reserve}$$

If this inequality is not satisfied, the trade is fail-closed and rejected with a detailed log, ensuring the wallet is **never drained into an out-of-gas failure**.

---

## 📦 GitHub Versioning & Release Workflow

When pushing updates to GitHub, follow the established release cadence:

```bash
# 1. Stage changes including CHANGELOG.md
git add .

# 2. Commit with conventional commit message
git commit -m "chore(release): bump version to v2.1.0"

# 3. Create an annotated git tag
git tag -a v2.1.0 -m "Release v2.1.0: Multi-Wallet Support, Per-Trade Allocation, Full Fee Engine, Exact Dollar Display"

# 4. Push branch and tag to GitHub
git push origin main
git push origin v2.1.0
```

Release notes for all versions are archived in [`CHANGELOG.md`](CHANGELOG.md).

---

## 🧪 Unit Tests

Run the complete test suite:

```bash
python3 -m unittest discover tests
```

Tests cover:
- Trailing floor calculations and tier resolution.
- NO STOP-LOSS invariant and gap-down `RECOVERY_WATCH` handling.
- 9-Layer fail-closed Rug Defense checks.
- Per-trade capital allocation and fee balance sufficiency verification.
