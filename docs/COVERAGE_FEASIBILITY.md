# COVERAGE FEASIBILITY REPORT: MULTI-CHAIN UNIVERSE ENUMERATION

This report presents mathematical modeling and operational realities for tracking extensive on-chain token universes across all 8 supported chains using public and hybrid provider tiers.

---

## 1. The On-Chain Universe Scale

On-chain DEX activity produces tens of thousands of new liquidity pools daily, primarily concentrated on Solana (via Raydium, Pump.fun migrations, Meteora) and BNB Smart Chain (PancakeSwap).

| Chain | Est. Active Pairs | New Pools / Day | Feasible Free Coverage | Primary Bottleneck |
|---|---|---|---|---|
| Solana | 180,000+ | 15,000–35,000 | ~15,000 tracked | Free RPC rate limits & high slot churn |
| BSC | 120,000+ | 8,000–18,000 | ~12,000 tracked | Archive node log limits |
| Base | 65,000+ | 4,000–10,000 | ~8,000 tracked | Free RPC request quotas |
| Ethereum | 55,000+ | 500–1,500 | ~10,000 tracked | High gas barrier (less spam pools) |
| Arbitrum | 35,000+ | 800–2,000 | ~6,000 tracked | Public RPC batch throttling |
| Polygon | 28,000+ | 500–1,200 | ~5,000 tracked | Chain reorg depth handling |
| Avalanche | 18,000+ | 200–800 | ~4,000 tracked | Public C-chain RPC limits |
| Optimism | 15,000+ | 200–600 | ~3,500 tracked | Rate limits on OP Bedrock public RPC |

---

## 2. API Request Budget Analysis

DexScreener operates at up to 300 requests/minute.
- **Batching Power**: `/tokens/v1/{chainId}/{addresses}` accepts up to 30 tokens in a single request.
- **Throughput Calculation**:
  $$\text{Capacity} = 300 \text{ req/min} \times 30 \text{ tokens/req} = 9,000 \text{ tokens/minute}$$
- **Safety Margin**: Dedicating 70% of rate allowance to Tier 0 sweeps leaves:
  $$210 \text{ req/min} \times 30 \text{ tokens/req} = 6,300 \text{ tokens/minute}$$
  $$6,300 \times 60 = 378,000 \text{ token refreshes/hour}$$
- **Cycle Time for 50,000 Tracked Tokens**:
  $$\text{Cycle Duration} = \frac{50,000}{6,300} \approx 7.9 \text{ minutes}$$
Thus, every active token in a 50,000-token universe can receive a fresh price, liquidity, and volume audit every 8 minutes on free DexScreener endpoints without violating rate limits.

---

## 3. Tiered Funnel Strategy

To prevent overloading security APIs (GoPlus, Honeypot.is, RugCheck) which enforce tighter constraints (~30–60 req/min):

1. **Tier 0 (Universe Sweep, 100% of tokens)**:
   - Uses batch DexScreener queries only.
   - Evaluates: Price presence, Liquidity $\ge \$2,500$, 24h Volume $\ge \$1,000$, Age $\ge 1\text{h}$, Non-zero transaction count.
   - Rejection Rate: ~82% of raw meme/spam pools fail Tier 0 filters.

2. **Tier 1 (Fast Screening, ~18% of universe)**:
   - Evaluates liquidity depth vs order size, volume-to-liquidity ratios, buy/sell txn count balance.
   - Cache TTL: 5 minutes.

3. **Tier 2 (Full Security & Market Structure, ~4% of universe)**:
   - Triggers deep multi-layer Rug Defense (GoPlus, RugCheck, Honeypot.is, deployer wallet graph, holder concentration).
   - Only evaluated for tokens showing viable liquidity, organic volume, and safe contract signatures.

4. **Tier 3 (Execution Readiness, <1% of universe)**:
   - Route simulation, slippage modeling, real-time gas quote comparison, immediate buy-candidate approval.

---

## 4. Free vs Production Tier Recommendations

| Component | Free Public Tier | Recommended Production Setup |
|---|---|---|
| RPC Provider | Public free nodes (Cloudflare, Ankr, LlamaNodes) | Dedicated paid RPC (QuickNode, Alchemy, Helius for Solana) |
| Pool Discovery | DexScreener search sweeps + GeckoTerminal pagination | Direct EVM `PairCreated` block listening + Solana WebSocket log subscriptions |
| Security APIs | Public free endpoints with circuit breakers | GoPlus Enterprise / RugCheck Pro keys |
| Database | SQLite in WAL mode with indexed compound keys | SQLite WAL (local NVMe SSD) or TimescaleDB for multi-instance |
| Latency | 500ms – 1,500ms | 80ms – 250ms |
