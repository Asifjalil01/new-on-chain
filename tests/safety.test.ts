import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Keypair } from '@solana/web3.js';

// Ensure server auto-start is disabled before importing server.ts
process.env.DISABLE_AUTO_START = '1';

import {
  DEFAULT_CONFIG,
  CSV_HEADER,
  botConfig,
  ledgers,
  logs,
  ensureApiToken,
  passesFilters,
  hardRugCheck,
  checkOnChainHolders,
  checkPreBuySellRoute,
  validateAndApplySettings,
  executeBuy,
  executeSell,
  checkExits,
  checkZeroBalanceAcrossTwoRpcs,
  confirmDeadLiquidityTwoSources,
  evaluateWriteOffEligibility,
  canOpenPosition,
  validateLiveStart,
  resetAccountPreservingLive,
  buildPositionRows,
  createAppServer,
  saveStateToDisk,
  registerLiveWallet,
  disconnectLiveWallet,
} from '../server';
import {
  setTradingKeypair,
  clearTradingKeypair,
  getTradingKeypair,
  parseVerifiedTransactionMetrics,
} from '../src/trading/SolanaLiveTrader';

const ROOT = path.resolve(process.cwd());
const TRACKED_FILES = [
  'sniper_settings.json',
  'sniper_state.json',
  '.sniper_signer.key',
  'trades_log.csv',
  '.env',
];

const snapshots = new Map<string, string | null>();
const origEnvToken = process.env.API_TOKEN;
const origEnvRpc = process.env.SOLANA_RPC_URL;
const origFetch = globalThis.fetch;

function snapshotFiles() {
  for (const rel of TRACKED_FILES) {
    const p = path.join(ROOT, rel);
    snapshots.set(rel, fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
  }
}

function restoreFiles() {
  for (const rel of TRACKED_FILES) {
    const p = path.join(ROOT, rel);
    const prev = snapshots.get(rel);
    if (prev === null || prev === undefined) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, prev, 'utf-8');
    }
  }
  // Remove any backup CSV files generated during test runs
  for (const name of fs.readdirSync(ROOT)) {
    if (/^trades_log\.old-\d+\.csv$/.test(name)) {
      try {
        fs.unlinkSync(path.join(ROOT, name));
      } catch {}
    }
  }
}

function resetInMemoryState() {
  clearTradingKeypair();
  disconnectLiveWallet('solana');
  Object.assign(botConfig, { ...DEFAULT_CONFIG });
  for (const m of ['paper', 'testnet', 'live'] as const) {
    ledgers[m].cash = botConfig.start_balance_usd;
    ledgers[m].positions = {};
    ledgers[m].trades = [];
    ledgers[m].attempted_mints = [];
    ledgers[m].pending_buys = [];
    ledgers[m].day_pnl = 0;
    ledgers[m].total_pnl = 0;
    ledgers[m].closed = 0;
    ledgers[m].wins = 0;
  }
}

before(() => {
  snapshotFiles();
  resetInMemoryState();
});

after(() => {
  globalThis.fetch = origFetch;
  clearTradingKeypair();
  restoreFiles();
  if (origEnvToken === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = origEnvToken;
  if (origEnvRpc === undefined) delete process.env.SOLANA_RPC_URL;
  else process.env.SOLANA_RPC_URL = origEnvRpc;
});

beforeEach(() => {
  globalThis.fetch = origFetch;
  resetInMemoryState();
});

// =========================================================================
// CHECK 1: Stop buying brand-new coins (< min_age_minutes) & min_liquidity_usd
// =========================================================================
test('Check 1: passesFilters enforces min_age_minutes=0, max_age_minutes=720, and min_liquidity_usd=1000', () => {
  assert.equal(DEFAULT_CONFIG.min_age_minutes, 0);
  assert.equal(DEFAULT_CONFIG.max_age_minutes, 720);
  assert.equal(DEFAULT_CONFIG.min_liquidity_usd, 1000);

  const nowMs = 1_700_000_000_000;
  const basePair = {
    dexId: 'raydium',
    baseToken: { address: Keypair.generate().publicKey.toBase58(), symbol: 'TEST' },
    quoteToken: { symbol: 'SOL' },
    priceUsd: '0.01',
    liquidity: { usd: 5_000 },
    txns: { m5: { buys: 20, sells: 5 } },
    volume: { m5: 15_000 },
    priceChange: { m5: 10 },
    holderCount: 250,
  };

  // Brand new coin aged 30 seconds -> passes age filter (min_age = 0)
  const [okNew, codeNew] = passesFilters(
    { ...basePair, pairCreatedAt: nowMs - 30_000 },
    DEFAULT_CONFIG,
    nowMs
  );
  assert.equal(okNew, true);
  assert.equal(codeNew, 'ok');

  // Coin aged 900 minutes -> must be rejected as too old
  const [okOld, codeOld] = passesFilters(
    { ...basePair, pairCreatedAt: nowMs - 900 * 60_000 },
    DEFAULT_CONFIG,
    nowMs
  );
  assert.equal(okOld, false);
  assert.equal(codeOld, 'too old');

  // Coin with $500 liquidity (< $1000) -> rejected as low liquidity
  const [okLowLiq, codeLowLiq] = passesFilters(
    { ...basePair, pairCreatedAt: nowMs - 60_000, liquidity: { usd: 500 } },
    DEFAULT_CONFIG,
    nowMs
  );
  assert.equal(okLowLiq, false);
  assert.equal(codeLowLiq, 'low liquidity');
});

// =========================================================================
// CHECK 2: Fail-closed RugCheck, On-Chain Holders, and Pre-Buy Sell Route
// =========================================================================
test('Check 2a: hardRugCheck fails closed when RugCheck is missing, high-score, or danger regardless of age', async () => {
  const mint = Keypair.generate().publicKey.toBase58();

  // Missing RugCheck report (null) -> rejects even if mint/freeze are revoked
  const [missingOk, missingWhy] = await hardRugCheck(
    mint,
    DEFAULT_CONFIG,
    15,
    {},
    {
      bypassCache: true,
      rpcMintAuthFn: async () => [true, null, null],
      getJsonFn: async () => null,
      holdersFn: async () => [true, 'ok'],
      sellRouteFn: async () => [true, 'ok'],
    }
  );
  assert.equal(missingOk, false);
  assert.match(missingWhy, /fail closed/i);

  // High score at young age (ageS = 10 < 180) -> still rejected (no age exemption)
  const [scoreOk, scoreWhy] = await hardRugCheck(
    mint,
    DEFAULT_CONFIG,
    10,
    {},
    {
      bypassCache: true,
      rpcMintAuthFn: async () => [true, null, null],
      getJsonFn: async () => ({ score_normalised: 65, lpLockedPct: 95, risks: [] }),
      holdersFn: async () => [true, 'ok'],
      sellRouteFn: async () => [true, 'ok'],
    }
  );
  assert.equal(scoreOk, false);
  assert.match(scoreWhy, /score/i);

  // Danger risk at young age (ageS = 10) -> still rejected
  const [dangerOk, dangerWhy] = await hardRugCheck(
    mint,
    DEFAULT_CONFIG,
    10,
    {},
    {
      bypassCache: true,
      rpcMintAuthFn: async () => [true, null, null],
      getJsonFn: async () => ({
        score_normalised: 5,
        lpLockedPct: 100,
        risks: [{ level: 'danger', name: 'Low Liquidity' }],
      }),
      holdersFn: async () => [true, 'ok'],
      sellRouteFn: async () => [true, 'ok'],
    }
  );
  assert.equal(dangerOk, false);
  assert.match(dangerWhy, /danger/i);
});

test('Check 2b: checkOnChainHolders rejects >10% single holder, >35% top-10, and RPC outages', async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const w1 = Keypair.generate().publicKey.toBase58();
  const w2 = Keypair.generate().publicKey.toBase58();
  const w3 = Keypair.generate().publicKey.toBase58();
  const w4 = Keypair.generate().publicKey.toBase58();
  const burnOwner = '11111111111111111111111111111111';

  // RPC outage -> fail closed
  const [rpcFailOk] = await checkOnChainHolders(mint, 35, 10, async () => null);
  assert.equal(rpcFailOk, false);

  // Single non-pool holder > 10% (12%) -> rejected
  const [singleOk, singleWhy] = await checkOnChainHolders(mint, 35, 10, async (method) => {
    if (method === 'getTokenSupply') return { value: { uiAmount: 1000 } };
    if (method === 'getTokenLargestAccounts') {
      return { value: [{ address: 'acc1', uiAmount: 120 }] };
    }
    if (method === 'getMultipleAccounts') {
      return { value: [{ data: { parsed: { info: { owner: w1 } } } }] };
    }
    return null;
  });
  assert.equal(singleOk, false);
  assert.match(singleWhy, /single non-pool holder/i);

  // Top-10 non-pool sum > 35% (4 wallets * 9.5% = 38%) -> rejected
  const [top10Ok, top10Why] = await checkOnChainHolders(mint, 35, 10, async (method) => {
    if (method === 'getTokenSupply') return { value: { uiAmount: 1000 } };
    if (method === 'getTokenLargestAccounts') {
      return {
        value: [
          { address: 'a1', uiAmount: 95 },
          { address: 'a2', uiAmount: 95 },
          { address: 'a3', uiAmount: 95 },
          { address: 'a4', uiAmount: 95 },
        ],
      };
    }
    if (method === 'getMultipleAccounts') {
      return {
        value: [w1, w2, w3, w4].map((o) => ({ data: { parsed: { info: { owner: o } } } })),
      };
    }
    return null;
  });
  assert.equal(top10Ok, false);
  assert.match(top10Why, /top-10/i);

  // Pool/burn owner ignored + healthy distribution (non-pool 8% + 8% = 16%) -> passes
  const [healthyOk] = await checkOnChainHolders(mint, 35, 10, async (method) => {
    if (method === 'getTokenSupply') return { value: { uiAmount: 1000 } };
    if (method === 'getTokenLargestAccounts') {
      return {
        value: [
          { address: 'burn', uiAmount: 500 },
          { address: 'a1', uiAmount: 80 },
          { address: 'a2', uiAmount: 80 },
        ],
      };
    }
    if (method === 'getMultipleAccounts') {
      return {
        value: [burnOwner, w1, w2].map((o) => ({ data: { parsed: { info: { owner: o } } } })),
      };
    }
    return null;
  });
  assert.equal(healthyOk, true);
});

test('Check 2c: checkPreBuySellRoute rejects missing quote or >5% price impact', async () => {
  const mint = Keypair.generate().publicKey.toBase58();

  const [noRouteOk] = await checkPreBuySellRoute(
    mint,
    DEFAULT_CONFIG,
    { decimals: 6, tokenPriceUsd: 0.01 },
    async () => {
      throw new Error('NO_ROUTES_FOUND');
    }
  );
  assert.equal(noRouteOk, false);

  const [highImpactOk, highImpactWhy] = await checkPreBuySellRoute(
    mint,
    DEFAULT_CONFIG,
    { decimals: 6, tokenPriceUsd: 0.01 },
    async () => ({ outAmount: '1000000', priceImpactPct: '0.08' })
  );
  assert.equal(highImpactOk, false);
  assert.match(highImpactWhy, /price impact/i);

  const [goodRouteOk] = await checkPreBuySellRoute(
    mint,
    DEFAULT_CONFIG,
    { decimals: 6, tokenPriceUsd: 0.01 },
    async () => ({ outAmount: '10000000', priceImpactPct: '0.01' })
  );
  assert.equal(goodRouteOk, true);
});

// =========================================================================
// CHECK 3: Stop-loss <= 20% & Take-profit >= 1.5x Stop-loss + change logging
// =========================================================================
test('Check 3: validateAndApplySettings caps SL at 20%, requires TP >= 1.5x SL, and logs changes', () => {
  const resSlOver20 = validateAndApplySettings({ stop_loss_pct: 25, take_profit_pct: 50 });
  assert.equal(resSlOver20.ok, false);
  assert.match(String(resSlOver20.error), /stop_loss_pct/i);

  const resBadRatio = validateAndApplySettings({ stop_loss_pct: 15, take_profit_pct: 20 });
  assert.equal(resBadRatio.ok, false);
  assert.match(String(resBadRatio.error), /1\.5x/);

  const prevLogLen = logs.length;
  const resValid = validateAndApplySettings({ stop_loss_pct: 15, take_profit_pct: 25 });
  assert.equal(resValid.ok, true);
  assert.equal(botConfig.stop_loss_pct, 15);
  assert.equal(botConfig.take_profit_pct, 25);
  assert.ok(logs.length > prevLogLen);
  assert.ok(resValid.changes.some((c) => c.includes('stop_loss_pct')));
});

// =========================================================================
// CHECK 4: Open positions keep their entry exit_params across setting changes
// =========================================================================
test('Check 4: open position exits using its entry snapshot even after settings change', async () => {
  validateAndApplySettings({ stop_loss_pct: 10, take_profit_pct: 30, trailing_stop_pct: 0 });
  const mint = Keypair.generate().publicKey.toBase58();
  const bought = await executeBuy('paper', mint, 'SNAP', 1.0);
  assert.equal(bought, true);

  const pos = ledgers.paper.positions[mint];
  assert.ok(pos);
  assert.equal(pos.exit_params?.stop_loss_pct, 10);
  assert.equal(pos.exit_params?.take_profit_pct, 30);

  // Relax stop_loss_pct in global config to 20% and take_profit_pct to 60%
  validateAndApplySettings({ stop_loss_pct: 20, take_profit_pct: 60 });

  // Price drops -12%: triggers entry snapshot (-10% SL), would NOT trigger new -20% SL
  const fillEntry = pos.entry_price;
  const priceMap = new Map([[mint, fillEntry * 0.88]]);
  const exited = await checkExits('paper', priceMap);
  assert.equal(exited, 1);
  assert.equal(ledgers.paper.positions[mint], undefined);
  assert.equal(ledgers.paper.trades[0].reason, 'stop_loss_10');
});

// =========================================================================
// CHECK 5: Pending buy / pre-buy on-chain balance recovery & anti-rebuy
// =========================================================================
test('Check 5: executeBuy checks on-chain SPL balance and recovers position instead of rebuying', async () => {
  const kp = Keypair.generate();
  setTradingKeypair(JSON.stringify(Array.from(kp.secretKey)));
  const mint = Keypair.generate().publicKey.toBase58();

  // Mock Jupiter price (SOL=$150) + Solana RPC returning existing SPL token balance
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes('api.jup.ag/price/v3') || url.includes('api.dexscreener.com')) {
      return new Response(
        JSON.stringify({
          So11111111111111111111111111111111111111112: { usdPrice: 150 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('solana') || url.includes('mainnet') || url.includes('ankr') || url.includes('publicnode')) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 500, decimals: 6 } } } } } },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  }) as any;

  const didBuyNew = await executeBuy('live', mint, 'REC', 0.01);
  assert.equal(didBuyNew, false);
  assert.ok(ledgers.live.positions[mint], 'Should recover untracked tokens into tracked position');
  assert.equal(ledgers.live.positions[mint].qty, 500);
  assert.equal(ledgers.live.trades[0]?.reason, 'recovered_onchain_balance');

  // Pending buy record blocks rebuy for the same mint
  const mint2 = Keypair.generate().publicKey.toBase58();
  ledgers.live.pending_buys.push({
    mint: mint2,
    symbol: 'PND',
    signature: '5'.repeat(88),
    userPublicKey: kp.publicKey.toBase58(),
    mode: 'live',
    trade_id: 'trd_pending_1',
    startedAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    tradeSol: 0.035,
    tradeUsd: 5,
    solPriceUsd: 150,
    url: 'https://dexscreener.com/solana/' + mint2,
    dex: 'raydium',
    source: 'gecko',
    age_s: 2000,
    exit_params: {
      take_profit_pct: 35,
      stop_loss_pct: 20,
      trailing_stop_pct: 10,
      rug_exit_drop_pct: 75,
      max_hold_minutes: 60,
    },
    status: 'PENDING',
  });
  const reboughtPending = await executeBuy('live', mint2, 'PND', 0.01);
  assert.equal(reboughtPending, false);
});

// =========================================================================
// CHECK 6: Dual-RPC zero check & external sell requires proof or NEEDS REVIEW
// =========================================================================
test('Check 6: checkZeroBalanceAcrossTwoRpcs & sold_externally without on-chain sell keeps position as NEEDS REVIEW', async () => {
  process.env.SOLANA_RPC_URL = 'https://rpc-a.example.com,https://rpc-b.example.com';
  const owner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();

  const nonZero = await checkZeroBalanceAcrossTwoRpcs(owner, mint, async (_o, _m, ep) =>
    ep.includes('rpc-a') ? { ok: true, uiAmount: 0 } : { ok: true, uiAmount: 25 }
  );
  assert.equal(nonZero.status, 'NON_ZERO');

  const inc = await checkZeroBalanceAcrossTwoRpcs(owner, mint, async (_o, _m, ep) =>
    ep.includes('rpc-a') ? { ok: true, uiAmount: 0 } : { ok: false, uiAmount: 0 }
  );
  assert.equal(inc.status, 'INCONCLUSIVE');

  const bothZero = await checkZeroBalanceAcrossTwoRpcs(owner, mint, async () => ({ ok: true, uiAmount: 0 }));
  assert.equal(bothZero.status, 'ZERO');

  // Now verify executeSell('live', mint, ..., 'sold_externally') does NOT clear when findExternalSellOnChain finds nothing
  const kp = Keypair.generate();
  setTradingKeypair(JSON.stringify(Array.from(kp.secretKey)));
  ledgers.live.positions[mint] = {
    trade_id: 'trd_ext_1',
    mint,
    symbol: 'EXT',
    qty: 100,
    entry_price: 0.05,
    cost: 5,
    cost_sol: 0.035,
    exit_params: {
      take_profit_pct: 35,
      stop_loss_pct: 20,
      trailing_stop_pct: 10,
      rug_exit_drop_pct: 75,
      max_hold_minutes: 60,
    },
    opened: Date.now() - 60_000,
    url: '',
    peak_price: 0.05,
    low_price: 0.05,
    dex: 'raydium',
    source: 'gecko',
    age_at_entry: 2000,
    decimals: 6,
    mode: 'live',
  };

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('api.jup.ag/price/v3')) {
      return new Response(
        JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    if (bodyText.includes('getTokenAccountsByOwner')) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (bodyText.includes('getSignaturesForAddress')) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  const cleared = await executeSell('live', mint, 0.05, 'sold_externally');
  assert.equal(cleared, false);
  assert.ok(ledgers.live.positions[mint], 'Position must stay open without on-chain sell proof');
  assert.equal(ledgers.live.positions[mint].needs_review, true);
  const viewRows = buildPositionRows('live', 150);
  assert.equal(viewRows[0].needs_review, true);
});

// =========================================================================
// CHECK 7: Dead-rug write-offs require >=5 attempts, >=10m, & 2-source <$50 liq
// =========================================================================
test('Check 7: write-off gating requires 5 attempts, 10 minutes, and two sources <$50 liquidity', async () => {
  const mint = Keypair.generate().publicKey.toBase58();

  const singleDead = await confirmDeadLiquidityTwoSources(mint, DEFAULT_CONFIG, {
    jupFn: async (_m, _c, liqMap, deadSet) => {
      liqMap?.set(mint, 10);
      deadSet?.add(mint);
      return new Map();
    },
    dexFn: async () => ({ pairs: [{ liquidity: { usd: 250 } }] }),
  });
  assert.equal(singleDead, false);

  const twoDead = await confirmDeadLiquidityTwoSources(mint, DEFAULT_CONFIG, {
    jupFn: async (_m, _c, liqMap, deadSet) => {
      liqMap?.set(mint, 10);
      deadSet?.add(mint);
      return new Map();
    },
    dexFn: async () => ({ pairs: [{ liquidity: { usd: 20 } }] }),
  });
  assert.equal(twoDead, true);

  const now = Date.now();
  const basePos: any = {
    mint,
    failed_sell_attempts: 4,
    first_unsellable_at: now - 15 * 60_000,
  };
  assert.equal(evaluateWriteOffEligibility(basePos, true, now).eligible, false);
  basePos.failed_sell_attempts = 5;
  basePos.first_unsellable_at = now - 5 * 60_000;
  assert.equal(evaluateWriteOffEligibility(basePos, true, now).eligible, false);
  basePos.first_unsellable_at = now - 11 * 60_000;
  assert.equal(evaluateWriteOffEligibility(basePos, false, now).eligible, false);
  assert.equal(evaluateWriteOffEligibility(basePos, true, now).eligible, true);
});

// =========================================================================
// CHECK 8: Honest net P&L, fees/rent split, trade_id linking, & Live preservation on reset
// =========================================================================
test('Check 8: transaction metrics, trade_id pairing, CSV header, and resetAccountPreservingLive', async () => {
  // Check CSV header fields
  for (const col of [
    'trade_id',
    'sol_spent',
    'sol_received',
    'base_fee_sol',
    'priority_fee_sol',
    'rent_paid_sol',
    'net_pnl_sol',
    'net_pnl_usd',
    'estimated',
  ]) {
    assert.ok(CSV_HEADER.includes(col), `CSV_HEADER missing ${col}`);
  }

  // Verify parsed tx fee/rent/sol delta split
  const owner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const fakeParsed = {
    meta: {
      fee: 15_000, // 5000 base + 10000 priority
      preBalances: [1_000_000_000, 0],
      postBalances: [947_945_720, 2_039_280], // -0.05 SOL swap - 0.00203928 rent - 0.000015 fee
      preTokenBalances: [],
      postTokenBalances: [
        { owner, mint, uiTokenAmount: { uiAmount: 1000 }, accountIndex: 1 },
      ],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: { toBase58: () => owner } },
          { pubkey: { toBase58: () => Keypair.generate().publicKey.toBase58() } },
        ],
        instructions: [
          {
            program: 'spl-associated-token-account',
            parsed: { type: 'createIdempotent' },
          },
        ],
      },
    },
  };
  const metrics = parseVerifiedTransactionMetrics(fakeParsed as any, mint, owner);
  assert.equal(metrics.baseFeeSol, 0.000005);
  assert.equal(metrics.priorityFeeSol, 0.00001);
  assert.ok((metrics.rentPaidSol || 0) > 0.002);
  assert.equal(metrics.actualTokensReceived, 1000);
  assert.ok(Math.abs((metrics.actualSolSpent || 0) - 0.05) < 0.0001);

  // Paper buy & sell share trade_id, and live trade survives paper reset
  await executeBuy('paper', mint, 'PR', 1.0);
  await executeSell('paper', mint, 1.4, 'take_profit');
  assert.equal(ledgers.paper.trades.length, 2);
  assert.ok(ledgers.paper.trades[0].trade_id);
  assert.equal(ledgers.paper.trades[0].trade_id, ledgers.paper.trades[1].trade_id);

  ledgers.live.trades.push({
    id: 'trd_live_keep',
    trade_id: 'trd_live_shared',
    mode: 'live',
    time: new Date().toISOString(),
    action: 'SELL',
    symbol: 'KEEP',
    mint: Keypair.generate().publicKey.toBase58(),
    price: 1,
    usd: 10,
    sol_amount: 0.07,
    sol_spent: 0.05,
    sol_received: 0.07,
    base_fee_sol: 0.000005,
    priority_fee_sol: 0.00002,
    rent_paid_sol: 0.002039,
    pnl_usd: 3,
    pnl_sol: 0.02,
    net_pnl_sol: 0.017936,
    net_pnl_usd: 2.69,
    pnl_pct: 35.8,
    estimated: false,
    reason: 'take_profit',
    dexscreener: '',
  });
  saveStateToDisk();

  const resetRes = resetAccountPreservingLive();
  assert.equal(resetRes.ok, true);
  assert.equal(ledgers.paper.trades.length, 0);
  assert.equal(ledgers.live.trades.length, 1);
  assert.equal(ledgers.live.trades[0].symbol, 'KEEP');
  const csvContent = fs.readFileSync(path.join(ROOT, 'trades_log.csv'), 'utf-8');
  assert.match(csvContent, /KEEP/);
});

// =========================================================================
// CHECK 9: Server-signer required for Live Start, exposure cap, Kill Switch
// =========================================================================
test('Check 9: Live start blocks popup-only mode, exposure cap blocks excess, and POST /api/kill exits positions', async () => {
  botConfig.EXECUTION_MODE = 'live';
  clearTradingKeypair();
  const blockNoSigner = validateLiveStart();
  assert.equal(blockNoSigner.ok, false);
  assert.match(String(blockNoSigner.error), /server-side signer/i);

  const app = await createAppServer({ attachVite: false });
  const token = ensureApiToken();

  // With server signer, verify max_wallet_exposure_sol (default 0.1) blocks oversize trade
  const kp = Keypair.generate();
  setTradingKeypair(JSON.stringify(Array.from(kp.secretKey)));
  registerLiveWallet('solana', kp.publicKey.toBase58(), 'Test Signer', '1.0000 SOL', '$150.00', 'keypair', true);
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input?.url || String(input);
    if (u.startsWith('http://127.0.0.1:')) return origFetch(input, init);
    return new Response(
      JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as any;

  botConfig.max_wallet_exposure_sol = 0.1;
  ledgers.live.positions[Keypair.generate().publicKey.toBase58()] = {
    trade_id: 'exp1',
    mint: 'm1',
    symbol: 'M1',
    qty: 10,
    entry_price: 1,
    cost: 12,
    cost_sol: 0.08,
    exit_params: {
      take_profit_pct: 35,
      stop_loss_pct: 20,
      trailing_stop_pct: 0,
      rug_exit_drop_pct: 75,
      max_hold_minutes: 60,
    },
    opened: Date.now(),
    url: '',
    peak_price: 1,
    low_price: 1,
    dex: 'raydium',
    source: 'gecko',
    age_at_entry: 2000,
    mode: 'live',
  };

  const srv = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = (srv.address() as any).port;
    await fetch(`http://127.0.0.1:${port}/api/status`);
    const expCheck = canOpenPosition('live', 0.05);
    assert.equal(expCheck.allowed, false);
    assert.match(expCheck.reason, /exposure/i);

    // Put a paper position, start paper bot, then call POST /api/kill
    botConfig.EXECUTION_MODE = 'paper';
    await executeBuy('paper', Keypair.generate().publicKey.toBase58(), 'KIL', 1.0);
    assert.equal(Object.keys(ledgers.paper.positions).length, 1);

    const killRes = await fetch(`http://127.0.0.1:${port}/api/kill`, {
      method: 'POST',
      headers: { 'x-api-token': token },
    });
    assert.equal(killRes.status, 200);
    const killJson: any = await killRes.json();
    assert.equal(killJson.stopped, true);
    assert.equal(Object.keys(ledgers.paper.positions).length, 0);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// =========================================================================
// CHECK 10: API token auth, plaintext signer deletion, AES-256-GCM unlock, Paper default boot
// =========================================================================
test('Check 10: API auth blocks unauthenticated writes, startup deletes plaintext signer & defaults to Paper, encrypted signer unlocks', async () => {
  // Write legacy plaintext .sniper_signer.key AND saved LIVE mode to sniper_settings.json
  const kp = Keypair.generate();
  fs.writeFileSync(path.join(ROOT, '.sniper_signer.key'), JSON.stringify(Array.from(kp.secretKey)), 'utf-8');
  fs.writeFileSync(
    path.join(ROOT, 'sniper_settings.json'),
    JSON.stringify({ EXECUTION_MODE: 'live', stop_loss_pct: 15, take_profit_pct: 30 }),
    'utf-8'
  );

  const app = await createAppServer({ attachVite: false });
  // Hard Rule 1 & Sec: Paper default on every start + plaintext key deleted
  assert.equal(botConfig.EXECUTION_MODE, 'paper');
  assert.equal(fs.existsSync(path.join(ROOT, '.sniper_signer.key')), false);
  assert.ok(logs.some((l) => l.message.includes('Deleted unencrypted .sniper_signer.key')));

  const token = ensureApiToken();
  const srv = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const port = (srv.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    // Unauthenticated requests must be rejected with 401
    const rSettingsUnauth = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_open_positions: 2 }),
    });
    assert.equal(rSettingsUnauth.status, 401);

    const rControlUnauth = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop_bot' }),
    });
    assert.equal(rControlUnauth.status, 401);

    const rSignerGetUnauth = await fetch(`${base}/api/trading-signer`);
    assert.equal(rSignerGetUnauth.status, 401);

    // Authenticated POST /api/trading-signer with passphrase writes AES-256-GCM encrypted file
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input?.url || String(input);
      if (u.startsWith(base)) return origFetch(input, init);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 100_000_000 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as any;

    const rSaveEnc = await origFetch(`${base}/api/trading-signer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': token },
      body: JSON.stringify({
        secretKey: JSON.stringify(Array.from(kp.secretKey)),
        passphrase: 'strong-passphrase-42',
      }),
    });
    assert.equal(rSaveEnc.status, 200);
    const encDiskRaw = fs.readFileSync(path.join(ROOT, '.sniper_signer.key'), 'utf-8');
    const encParsed = JSON.parse(encDiskRaw);
    assert.equal(encParsed.alg, 'aes-256-gcm');
    assert.equal(encParsed.ciphertext !== undefined, true);
    assert.equal(encDiskRaw.includes(JSON.stringify(Array.from(kp.secretKey))), false);

    // Clear memory, verify locked, wrong passphrase -> 403, right passphrase -> 200 & key restored
    clearTradingKeypair();
    assert.equal(getTradingKeypair(), null);

    const rWrong = await origFetch(`${base}/api/trading-signer/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': token },
      body: JSON.stringify({ passphrase: 'wrong-pass' }),
    });
    assert.equal(rWrong.status, 403);

    const rRight = await origFetch(`${base}/api/trading-signer/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': token },
      body: JSON.stringify({ passphrase: 'strong-passphrase-42' }),
    });
    assert.equal(rRight.status, 200);
    assert.equal(getTradingKeypair()?.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
