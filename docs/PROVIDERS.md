# OFFICIAL API PROVIDERS DIRECTORY & SPECIFICATION

This document details verified official endpoints, authentication requirements, rate limits, supported chains, and cost tiers for all external data and execution providers used by On-Chain SPOT Bot v2.

---

## 1. DexScreener Public API (Primary Market Data)

- **Base URL**: `https://api.dexscreener.com`
- **Documentation**: `https://docs.dexscreener.com/api/reference`
- **Authentication**: None required (public open API)
- **Cost**: Free tier
- **Global Rate Limit**: Up to 300 requests/minute (varies by endpoint tier)

### Endpoints
| Endpoint | Method | Rate Limit | Purpose & Limitations |
|---|---|---|---|
| `/token-profiles/latest/v1` | GET | 60 req/min | Returns the latest paid/updated token profiles across chains. |
| `/token-boosts/latest/v1` | GET | 60 req/min | Returns recently boosted token pairs. |
| `/token-boosts/top/v1` | GET | 60 req/min | Returns pairs with the highest active boost count. |
| `/latest/dex/pairs/{chainId}/{pairId}` | GET | 300 req/min | Full pair statistics (price, liquidity, volume, txns, age) by chain and pair address. |
| `/tokens/v1/{chainId}/{tokenAddresses}` | GET | 300 req/min | Batch token lookup: up to 30 comma-separated token addresses per request. |
| `/token-pairs/v1/{chainId}/{tokenAddress}` | GET | 300 req/min | Enumerates all liquidity pools for a specific token. |
| `/latest/dex/search?q={query}` | GET | 300 req/min | Full-text search across pairs, tokens, and symbols (~30 results per call). |

### Implementation Constraints
- DexScreener provides no global "list all pairs" or OHLC candlestick history endpoint.
- Discovery requires layered seed expansion + rotating batch queries (`/tokens/v1/` with 30 tokens/request).
- Rate budget: The bot restricts background discovery to 70% of capacity (~210 req/min) to reserve headroom for high-priority position monitoring.

---

## 2. GeckoTerminal Public API (Secondary Bulk Enumeration)

- **Base URL**: `https://api.geckoterminal.com/api/v2`
- **Documentation**: `https://www.geckoterminal.com/dex-api`
- **Authentication**: None for public tier; Bearer token for GeckoTerminal PRO.
- **Cost**: Free tier (30 requests/minute)
- **Supported Chains**: Ethereum, BSC, Solana, Base, Arbitrum, Polygon, Avalanche, Optimism, and 100+ others.

### Endpoints
| Endpoint | Method | Purpose |
|---|---|---|
| `/networks/{network}/new_pools?page={p}` | GET | Paginated feed of newly created liquidity pools. |
| `/networks/{network}/trending_pools?page={p}` | GET | Top trending pools by short-term volume. |
| `/networks/{network}/dexes/{dex}/pools?page={p}` | GET | Pools partitioned by DEX identifier. |
| `/networks/{network}/tokens/{address}/info` | GET | Token metadata, total supply, social links. |

---

## 3. GoPlus Security API (Contract & Token Security)

- **Base URL**: `https://api.gopluslabs.io/api/v1`
- **Documentation**: `https://docs.gopluslabs.io`
- **Authentication**: Optional API key (public free tier available)
- **Cost**: Free tier (30 req/sec with burst protection)
- **Supported Chains**: Ethereum (1), BSC (56), Arbitrum (42161), Polygon (137), Avalanche (43114), Base (8453), Optimism (10), Solana.

### Key Fields Evaluated
- `is_honeypot`: Boolean flag.
- `buy_tax`, `sell_tax`: String percentages. Flagged if > 5% or dynamic.
- `is_mintable`: Arbitrary mint authority.
- `owner_change_balance`: Owner ability to alter holder balances.
- `is_blacklisted`: Transfer blacklist presence.
- `trading_cooldown`: Hidden transfer locks.
- `cannot_sell_all`: Partial sell locks.
- `lp_holder_count`, `lp_total_supply`: Liquidity distribution.

---

## 4. Honeypot.is API (EVM Simulation Verification)

- **Base URL**: `https://api.honeypot.is/v2`
- **Documentation**: `https://honeypot.is`
- **Authentication**: None required for public tier
- **Cost**: Free tier
- **Supported Chains**: Ethereum, BSC, Base, Arbitrum, Polygon, Optimism.

### Purpose
Provides on-chain simulated buy and sell transaction traces in a sandbox environment to detect hidden re-entrancy traps, transfer reverts, and dynamic sell tax spikes.

---

## 5. RugCheck API (Solana Token & Authority Verification)

- **Base URL**: `https://api.rugcheck.xyz/v1`
- **Documentation**: `https://rugcheck.xyz`
- **Authentication**: Optional JWT / API Key
- **Cost**: Free tier (60 req/min)
- **Supported Chain**: Solana

### Key Checks
- Mint Authority (must be disabled/revoked)
- Freeze Authority (must be disabled/revoked)
- Top 10 Holder Concentration (flagged if > 30% excluding LP and lockers)
- LP Locked / Burned status & Raydium/Orca burn accounts
- Token-2022 extension validation (permanent delegate, transfer fee hook)

---

## 6. On-Chain RPC Providers & Blockchains

- **Standard RPC Methods**:
  - EVM: `eth_call`, `eth_getBalance`, `eth_estimateGas`, `eth_getTransactionReceipt`, `eth_getLogs`.
  - Solana: `getAccountInfo`, `getTokenLargestAccounts`, `getMultipleAccounts`, `simulateTransaction`.
- **Supported Chains & Chain IDs**:
  - Solana (`solana`, mainnet-beta)
  - Ethereum (`ethereum`, Chain ID 1)
  - BSC (`bsc`, Chain ID 56)
  - Base (`base`, Chain ID 8453)
  - Arbitrum One (`arbitrum`, Chain ID 42161)
  - Polygon (`polygon`, Chain ID 137)
  - Avalanche C-Chain (`avalanche`, Chain ID 43114)
  - Optimism (`optimism`, Chain ID 10)

---

## 7. DEX & Aggregator Execution Routing

- **Solana**: Jupiter V6 Swap API (`https://quote-api.jup.ag/v6`) for optimal split routing across Raydium, Orca, and Meteora.
- **EVM Aggregators**: 
  - 1inch Aggregation Protocol API (`https://api.1inch.dev/swap/v6.0`)
  - 0x Swap API (`https://api.0x.org/swap/v1`)
  - Odos SOR API (`https://api.odos.xyz/sor`)
- **Direct Router Contracts**:
  - Uniswap V2/V3 (Ethereum, Base, Arbitrum, Polygon, Optimism)
  - PancakeSwap V2/V3 (BSC, Ethereum, Base)
  - Aerodrome (Base)
  - Trader Joe (Avalanche)
