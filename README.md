# Solana Launch Sniper

Node.js / TypeScript + Express + React / Vite Solana token monitor and swap executor with Jupiter swap routing, fail-closed RugCheck & on-chain holder concentration screening, server-side keypair signing, encrypted local signer storage, per-position exit snapshots, and CSV/ledger accounting.

> **Important**: Automated token trading carries high risk of total loss. No filter or safety check guarantees profit. Live execution is **disabled by default** (`EXECUTION_MODE = "paper"`) on every startup.

---

## Core Architecture

- **Backend Engine (`server.ts`)**: Express server binding `127.0.0.1:3000` by default (`HOST` / `PORT` configurable), candidate scanner, fail-closed rug & liquidity screener, position monitor, live exit manager, and persistent JSON/CSV state.
- **Solana Live Trader (`src/trading/SolanaLiveTrader.ts`)**: Jupiter swap/quote execution, multi-endpoint RPC failover (`SOLANA_RPC_URL` comma-separated or public endpoints), on-chain mint decimal lookups, parsed transaction verification splitting base fees, priority fees, and token-account rent, and signature polling for pending confirmations.
- **React Frontend (`src/`)**: Paper/Testnet/Live mode switcher with SL/TP re-confirmation, Open Positions dashboard with per-position snapshotted TP/SL rules and `NEEDS REVIEW` flags, Trade History with combined fees/rent & `est.` labels, Settings validation, and Wallets/Signer management.
- **Note**: The legacy `onchain_bot/` Python directory is separate and unused by the Node/React application.

---

## Safety & Accounting Controls

1. **Maturity & Liquidity Gates**:
   - Rejects coins outside `[min_age_minutes, max_age_minutes]` (defaults: `30` to `720` minutes).
   - Enforces `min_liquidity_usd` (default `$25,000`) and volume/buy-count minimums across all ages (`ultra_early_grace_sec` is forced to `0`).
2. **Fail-Closed Rug & Exit-Route Screening**:
   - Missing or failed RugCheck responses reject the candidate (10-second negative cache for retry) instead of passing.
   - Applies `rugcheck_max_score` and danger risk checks at every token age.
   - Queries on-chain `getTokenSupply` + `getTokenLargestAccounts` + `getMultipleAccounts` and rejects if any single non-pool holder exceeds **10%** or top-10 non-pool holders exceed `max_top10_holder_pct` (default **35%**), or if RPC data is unavailable.
   - Requests a pre-buy Jupiter sell quote back to SOL and rejects if no route exists or price impact exceeds **5%**.
3. **Risk & Reward Limits**:
   - Caps `stop_loss_pct` at **20%**.
   - Rejects settings where `take_profit_pct < stop_loss_pct * 1.5` (when `stop_loss_pct > 0`).
   - Displays SL/TP prominently in the Live confirmation modal and requires re-confirmation if SL or TP changes.
4. **Per-Position Exit Snapshots**:
   - `take_profit_pct`, `stop_loss_pct`, `trailing_stop_pct`, `rug_exit_drop_pct`, and `max_hold_minutes` are snapshotted onto each position at entry. Setting edits apply to new positions only and are logged with old and new values.
5. **Pending Confirmation & Anti-Rebuy Tracking**:
   - Persists `attempted_mints` when a buy transaction is submitted and polls timed-out transactions for up to 120 seconds as `PENDING` instead of treating timeouts as failures.
   - Checks on-chain token balance before buying so untracked holdings are recovered rather than rebought.
6. **External Sell Proof & Multi-RPC Checks**:
   - Requires **3 consecutive zero balance reads across 2 different RPC endpoints** plus a confirmed on-chain sell transaction (`findExternalSellOnChain`) before clearing a position as `sold_externally`. Otherwise keeps the position open flagged `NEEDS REVIEW` with a manual Clear action.
7. **Conservative Dead-Token Write-Offs**:
   - Writes off an unsellable position (`WRITE_OFF_UNSELLABLE`, `estimated: true`, never counted as a win) only after `>= 5` sell attempts spanning `>= 10` minutes AND `< $50` liquidity confirmed by two independent market sources.
8. **Honest Net P&L, Fee, and Rent Accounting**:
   - Entry price derived from actual SOL spent (parsed from confirmed transaction) × SOL/USD price at execution.
   - Records `trade_id`, `sol_spent`, `sol_received`, `base_fee_sol`, `priority_fee_sol`, `rent_paid_sol`, net P&L (SOL & USD), and `estimated` flag in both ledger JSON and `trades_log.csv`.
   - Paper account reset preserves Live ledger history and Live CSV rows.
9. **Server-Side Signer & Kill Switch**:
   - Live Start and `scan_once` require a server-side trading signer (browser Phantom popups cannot automate stop-loss or rug exits; popup-only wallets are restricted to Paper mode).
   - Enforces `max_wallet_exposure_sol` (default `0.1 SOL`) and daily loss limits.
   - `POST /api/kill` (and header Kill Switch button) stops the bot immediately and attempts to exit all open positions.
10. **Local Security & Secret Handling**:
    - Never writes plaintext private keys to disk (any legacy plaintext `.sniper_signer.key` is deleted on startup with a security warning).
    - Optional passphrase encrypts `.sniper_signer.key` using AES-256-GCM + `scryptSync`; unlock via `POST /api/trading-signer/unlock`.
    - Mutating `/api/*` endpoints and `/api/trading-signer*` require the `x-api-token` header (`API_TOKEN` auto-generated in `.env` with `0o600` if missing).
    - Server binds `127.0.0.1` by default (`HOST=127.0.0.1`).

---

## Quick Start

### Prerequisites
- **Node.js**: v18+

### Configuration
Copy `.env.example` to `.env` if needed and optionally configure:
- `SOLANA_RPC_URL` — Single or comma-separated private/custom Solana RPC endpoints
- `HOST` — Defaults to `127.0.0.1`
- `API_TOKEN` — Auto-generated on first boot if unset
- `SOLANA_PRIVATE_KEY` — Optional server-side signer keypair kept in memory

### Run & Verify

```bash
npm install
npm run lint     # TypeScript type-check (tsc --noEmit)
npm test         # Automated safety & accounting test suite
npm run dev      # Start Express + Vite dev server on 127.0.0.1:3000
```
