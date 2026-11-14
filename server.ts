import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  setTradingKeypair,
  getTradingKeypair,
  getTradingSignerStatus,
  clearTradingKeypair,
  executeLiveSolanaBuy,
  executeLiveSolanaSell,
  prepareLiveBuyTransaction,
  prepareLiveSellTransaction,
  finalizeBrowserSignedTransaction,
} from './src/trading/SolanaLiveTrader';

// Initialize Trading Keypair from Environment if present (NEVER log the secret)
const envPrivateKey = process.env.SOLANA_PRIVATE_KEY || process.env.SOLANA_SECRET_KEY;
if (envPrivateKey) {
  const res = setTradingKeypair(envPrivateKey);
  if (res.success) {
    console.log(`[BOOT] Trading signer configured from environment for ${res.address?.slice(0, 6)}...`);
  } else {
    console.warn(`[BOOT] Failed to load trading signer from env: ${res.error}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- TYPES & CONSTANTS ----------------
export type ExecutionMode = 'paper' | 'testnet' | 'live';
export type BotLifecycleState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING';

export interface SniperConfig {
  // Core Capital & Risk (bot.py / gui.py)
  start_balance_usd: number;
  start_balance_sol: number;
  trade_size_usd: number;
  trade_size_sol: number;
  max_open_positions: number;
  daily_loss_limit_usd: number;
  daily_loss_limit_sol: number;
  sizing_basis: 'sol' | 'usd';
  take_profit_pct: number;
  trailing_stop_pct: number;
  stop_loss_pct: number;
  rug_exit_drop_pct: number;
  max_hold_minutes: number;
  // Sniper window & grace
  max_age_minutes: number;
  ultra_early_grace_sec: number;
  // Scan & monitor speed
  scan_interval_sec: number;
  monitor_interval_sec: number;
  // Entry guards
  min_liquidity_usd: number;
  min_buys_m5: number;
  min_buy_sell_ratio_m5: number;
  max_price_change_m5_pct: number;
  min_volume_m5_usd: number;
  min_holders: number;
  // Hard rug screen
  use_rugcheck: boolean;
  strict_rugcheck: boolean;
  rugcheck_max_score: number;
  max_top10_holder_pct: number;
  rug_recheck_minutes: number;
  // Candidate sources & live prices
  use_gecko: boolean;
  use_jupiter_recent: boolean;
  use_jupiter_price: boolean;
  use_dex_profiles: boolean;
  use_pumpportal: boolean;
  use_promoted_feeds: boolean;
  // Slippage, fees & logging
  slippage_pct: number;
  fee_pct: number;
  log_rejects: boolean;
  jupiter_api_key: string;
  // Execution mode & live wallet integration
  EXECUTION_MODE: ExecutionMode;
  DEFAULT_CHAIN: string;
  MAX_POSITION_SIZE_USD: number;
  MAX_POSITION_SIZE_SOL: number;
  MIN_GAS_RESERVE_SOL: number;
  MIN_GAS_RESERVE_ETH: number;
  PRIORITY_FEE_LEVEL: 'standard' | 'high' | 'ultra';
  THEME: 'dark' | 'light';
}

export const DEFAULT_CONFIG: SniperConfig = {
  start_balance_usd: 50.0,
  start_balance_sol: 0.35,
  trade_size_usd: 5.0,
  trade_size_sol: 0.035,
  max_open_positions: 3,
  daily_loss_limit_usd: 10.0,
  daily_loss_limit_sol: 0.07,
  sizing_basis: 'sol',
  take_profit_pct: 50.0,
  trailing_stop_pct: 0.0,
  stop_loss_pct: 35.0,
  rug_exit_drop_pct: 85.0,
  max_hold_minutes: 120,
  max_age_minutes: 2.0,
  ultra_early_grace_sec: 10,
  scan_interval_sec: 1,
  monitor_interval_sec: 1.0,
  min_liquidity_usd: 300.0,
  min_buys_m5: 2,
  min_buy_sell_ratio_m5: 1.0,
  max_price_change_m5_pct: 300.0,
  min_volume_m5_usd: 0.0,
  min_holders: 0,
  use_rugcheck: true,
  strict_rugcheck: true,
  rugcheck_max_score: 50.0,
  max_top10_holder_pct: 75.0,
  rug_recheck_minutes: 15,
  use_gecko: true,
  use_jupiter_recent: true,
  use_jupiter_price: true,
  use_dex_profiles: true,
  use_pumpportal: true,
  use_promoted_feeds: false,
  slippage_pct: 2.0,
  fee_pct: 1.0,
  log_rejects: true,
  jupiter_api_key: '',
  EXECUTION_MODE: 'paper',
  DEFAULT_CHAIN: 'solana',
  MAX_POSITION_SIZE_USD: 100.0,
  MAX_POSITION_SIZE_SOL: 0.7,
  MIN_GAS_RESERVE_SOL: 0.01,
  MIN_GAS_RESERVE_ETH: 0.005,
  PRIORITY_FEE_LEVEL: 'standard',
  THEME: 'dark',
};

export const SETTING_LIMITS: Record<string, [number, number]> = {
  start_balance_usd: [0.01, 1e7],
  start_balance_sol: [0.0001, 1e6],
  trade_size_usd: [0.01, 1e6],
  trade_size_sol: [0.0001, 1e5],
  max_open_positions: [1, 50],
  daily_loss_limit_usd: [0, 1e7],
  daily_loss_limit_sol: [0, 1e6],
  take_profit_pct: [0, 1e5],
  trailing_stop_pct: [0, 1000],
  stop_loss_pct: [0, 99.9],
  rug_exit_drop_pct: [0, 99.9],
  max_hold_minutes: [1, 1e5],
  max_age_minutes: [0.05, 60],
  ultra_early_grace_sec: [0, 300],
  scan_interval_sec: [1, 3600],
  monitor_interval_sec: [0.2, 60],
  min_liquidity_usd: [0, 1e9],
  min_buys_m5: [0, 1e6],
  min_buy_sell_ratio_m5: [0, 100],
  max_price_change_m5_pct: [0, 1e6],
  min_volume_m5_usd: [0, 1e9],
  min_holders: [0, 1e6],
  rugcheck_max_score: [0, 100],
  max_top10_holder_pct: [0, 100],
  rug_recheck_minutes: [1, 1440],
  slippage_pct: [0, 50],
  fee_pct: [0, 50],
};

const INT_SETTINGS = new Set([
  'max_open_positions',
  'max_hold_minutes',
  'scan_interval_sec',
  'min_buys_m5',
  'min_holders',
  'rug_recheck_minutes',
  'ultra_early_grace_sec',
]);

const BOOL_SETTINGS = new Set([
  'use_rugcheck',
  'strict_rugcheck',
  'use_gecko',
  'use_jupiter_recent',
  'use_jupiter_price',
  'use_dex_profiles',
  'use_pumpportal',
  'use_promoted_feeds',
  'log_rejects',
]);

const SETTINGS_FILE = path.resolve(__dirname, 'sniper_settings.json');
const STATE_FILE = path.resolve(__dirname, 'sniper_state.json');
const TRADES_LOG_FILE = path.resolve(__dirname, 'trades_log.csv');
const TRADES_LOG_PUBLIC = path.resolve(__dirname, 'public', 'trades_log.csv');

export let botConfig: SniperConfig = { ...DEFAULT_CONFIG };

// ---------------- ENDPOINTS ----------------
const DEX = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const JUP = 'https://api.jup.ag/tokens/v2';
const JUP_PRICE = 'https://api.jup.ag/price/v3';
const RUGC = 'https://api.rugcheck.xyz/v1/tokens';
const PUMPP = 'https://api.pumpportal.fun/api/data';
const RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];
const HEADERS = { 'User-Agent': 'solana-launch-sniper/2.0', Accept: 'application/json' };
const SEEN_TTL_MS = 10_000;

// ---------------- HELPERS ----------------
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fmtPrice(x: number | null | undefined): string {
  if (x === null || x === undefined || isNaN(x)) return 'n/a';
  const n = Number(x);
  if (n === 0) return '0.00';
  if (Math.abs(n) >= 1) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }
  const decimals = Math.min(10, Math.max(2, -Math.floor(Math.log10(Math.abs(n))) + 5));
  return n.toFixed(decimals);
}

function _f(x: any): number | null {
  if (x === null || x === undefined || x === '') return null;
  const v = Number(x);
  return isNaN(v) || !isFinite(v) ? null : v;
}

async function getJson(url: string, params?: Record<string, string | number>, timeoutMs = 6000, extraHeaders?: Record<string, string>): Promise<any> {
  try {
    let target = url;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
      target += (target.includes('?') ? '&' : '?') + qs.toString();
    }
    const resp = await fetch(target, {
      headers: { ...HEADERS, ...(extraHeaders || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ---------------- LOGGING & SSE ----------------
export interface AppLog {
  id: string;
  timestamp: number;
  time_str: string;
  tag: 'buy' | 'sell' | 'reject' | 'warn' | 'summary' | 'info';
  type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  line: string;
  message: string;
}

export let logs: AppLog[] = [];
const sseClients: express.Response[] = [];

export function broadcastSse(eventType: string, data: any) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

export function sniperLog(msg: string, explicitTag?: AppLog['tag'], type = 'SNIPER') {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const timeStr = `${hh}:${mm}:${ss}`;
  const line = `[${timeStr}] ${msg}`;
  const low = line.toLowerCase();

  const tag: AppLog['tag'] =
    explicitTag ||
    (low.includes('sniper buy') || low.includes('[live buy confirmed]')
      ? 'buy'
      : low.includes('✗ sell') || low.includes('[live sell confirmed]')
      ? 'sell'
      : low.includes('reject') || low.includes('rug') || low.includes('filtered')
      ? 'reject'
      : low.includes('scan summary')
      ? 'summary'
      : low.includes('error') || low.includes('failed') || low.includes('⚠') || low.includes('cannot trade')
      ? 'warn'
      : 'info');

  const severity: AppLog['severity'] =
    tag === 'warn' ? 'WARNING' : 'INFO';

  const entry: AppLog = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    time_str: timeStr,
    tag,
    type,
    severity,
    line,
    message: msg,
  };

  logs.push(entry);
  if (logs.length > 2500) {
    logs.splice(0, logs.length - 2000);
  }
  broadcastSse('log', entry);
}

// ---------------- ACCOUNT STATE (PAPER / TESTNET / LIVE) ----------------
export interface SniperPosition {
  mint: string;
  symbol: string;
  qty: number;
  entry_price: number;
  cost: number;
  cost_sol?: number;
  opened: number; // ms timestamp
  url: string;
  peak_price: number;
  low_price: number;
  dex: string;
  source: string;
  age_at_entry: number;
  decimals?: number;
  tx_hash_buy?: string;
  explorer_url?: string;
  mode: ExecutionMode;
  last_seen_price_at?: number;
  failed_sell_attempts?: number;
  last_liquidity_usd?: number;
}

export interface SniperTradeRow {
  id: string;
  mode: ExecutionMode;
  time: string;
  action: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  price: number;
  usd: number;
  sol_amount?: number;
  pnl_usd: number | null;
  pnl_sol?: number | null;
  pnl_pct: number | null;
  reason: string;
  dexscreener: string;
  age_s?: number;
  dex?: string;
  source?: string;
  tx_hash?: string;
  explorer_url?: string;
}

export interface ModeLedger {
  cash: number;
  positions: Record<string, SniperPosition>;
  day: string;
  day_pnl: number;
  total_pnl: number;
  closed: number;
  wins: number;
  blacklist: string[];
  trades: SniperTradeRow[];
}

function createEmptyLedger(startCash: number): ModeLedger {
  return {
    cash: startCash,
    positions: {},
    day: todayStr(),
    day_pnl: 0.0,
    total_pnl: 0.0,
    closed: 0,
    wins: 0,
    blacklist: [],
    trades: [],
  };
}

export const ledgers: Record<ExecutionMode, ModeLedger> = {
  paper: createEmptyLedger(DEFAULT_CONFIG.start_balance_usd),
  testnet: createEmptyLedger(DEFAULT_CONFIG.start_balance_usd),
  live: createEmptyLedger(0),
};

export const livePrices = new Map<string, number>();
export let lastPriceTime = 0;

function rollDay(ledger: ModeLedger) {
  const t = todayStr();
  if (ledger.day !== t) {
    ledger.day = t;
    ledger.day_pnl = 0.0;
  }
}

// ---------------- CSV LOGGING ----------------
const CSV_HEADER = 'time,action,symbol,mint,price,usd,pnl_usd,pnl_pct,reason,dexscreener,age_s,dex,source,mode,tx_hash\n';

export function ensureTradesLogFile() {
  try {
    const pubDir = path.resolve(__dirname, 'public');
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
    if (!fs.existsSync(TRADES_LOG_FILE)) fs.writeFileSync(TRADES_LOG_FILE, CSV_HEADER, 'utf-8');
    if (!fs.existsSync(TRADES_LOG_PUBLIC)) fs.writeFileSync(TRADES_LOG_PUBLIC, CSV_HEADER, 'utf-8');
  } catch (err: any) {
    console.error('Error ensuring trades_log.csv:', err.message);
  }
}

function csvEscape(v: any): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function appendTradeCsv(row: SniperTradeRow) {
  try {
    ensureTradesLogFile();
    const line = [
      row.time,
      row.action,
      row.symbol,
      row.mint,
      fmtPrice(row.price),
      row.usd.toFixed(4),
      row.pnl_usd !== null ? row.pnl_usd.toFixed(4) : '',
      row.pnl_pct !== null ? row.pnl_pct.toFixed(2) : '',
      row.reason,
      row.dexscreener,
      row.age_s ?? '',
      row.dex ?? '',
      row.source ?? '',
      row.mode,
      row.tx_hash ?? '',
    ]
      .map(csvEscape)
      .join(',');
    fs.appendFileSync(TRADES_LOG_FILE, line + '\n', 'utf-8');
    fs.appendFileSync(TRADES_LOG_PUBLIC, line + '\n', 'utf-8');
  } catch (err: any) {
    console.error('Error writing trades_log.csv:', err.message);
  }
}

// ---------------- PERSISTENCE ----------------
function loadSettingsFromDisk() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      // Always start in PAPER mode for safety on boot, keeping other preferences
      const { EXECUTION_MODE: _ignored, ...rest } = raw || {};
      const merged: SniperConfig = { ...DEFAULT_CONFIG, ...rest, EXECUTION_MODE: 'paper' };
      const refSol = cachedSolPrice.price || 145;
      if (rest?.start_balance_usd !== undefined && rest?.start_balance_sol === undefined) {
        merged.start_balance_sol = Number((merged.start_balance_usd / refSol).toFixed(4));
      }
      if (rest?.trade_size_usd !== undefined && rest?.trade_size_sol === undefined) {
        merged.trade_size_sol = Number((merged.trade_size_usd / refSol).toFixed(4));
      }
      if (rest?.daily_loss_limit_usd !== undefined && rest?.daily_loss_limit_sol === undefined) {
        merged.daily_loss_limit_sol = Number((merged.daily_loss_limit_usd / refSol).toFixed(4));
      }
      if (rest?.MAX_POSITION_SIZE_USD !== undefined && rest?.MAX_POSITION_SIZE_SOL === undefined) {
        merged.MAX_POSITION_SIZE_SOL = Number((merged.MAX_POSITION_SIZE_USD / refSol).toFixed(4));
      }
      botConfig = merged;
    }
  } catch {}
}

function saveSettingsToDisk() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botConfig, null, 2), 'utf-8');
  } catch {}
}

function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      for (const m of ['paper', 'testnet', 'live'] as ExecutionMode[]) {
        if (parsed[m]) {
          ledgers[m] = {
            ...createEmptyLedger(m === 'live' ? 0 : botConfig.start_balance_usd),
            ...parsed[m],
            positions: parsed[m].positions || {},
            blacklist: parsed[m].blacklist || [],
            trades: parsed[m].trades || [],
          };
        }
      }
    }
  } catch {}
}

function saveStateToDisk() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ledgers, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

// ---------------- WALLET FEE SCHEDULES & LIVE WALLET REGISTRY (PRESERVED) ----------------
export interface WalletFeeConfig {
  walletId: string;
  name: string;
  swapFeePct: number;
  estimatedGasUsd: number;
  ataRentReserveUsd: number;
  description: string;
}

export const WALLET_FEE_SCHEDULES: Record<string, WalletFeeConfig> = {
  phantom: {
    walletId: 'phantom',
    name: 'Phantom Wallet',
    swapFeePct: 0.85,
    estimatedGasUsd: 0.05,
    ataRentReserveUsd: 0.31,
    description: 'Phantom 0.85% swap fee + Solana priority fee & ATA rent',
  },
  solflare: {
    walletId: 'solflare',
    name: 'Solflare Wallet',
    swapFeePct: 0.50,
    estimatedGasUsd: 0.04,
    ataRentReserveUsd: 0.31,
    description: 'Solflare 0.50% swap fee + Solana priority fee & ATA rent',
  },
  metamask: {
    walletId: 'metamask',
    name: 'MetaMask',
    swapFeePct: 0.875,
    estimatedGasUsd: 0.15,
    ataRentReserveUsd: 0.0,
    description: 'MetaMask 0.875% protocol fee + EVM gas',
  },
  trustwallet: {
    walletId: 'trustwallet',
    name: 'Trust Wallet',
    swapFeePct: 1.00,
    estimatedGasUsd: 0.10,
    ataRentReserveUsd: 0.0,
    description: 'Trust Wallet 1.00% swap fee + multi-chain gas',
  },
  coinbase: {
    walletId: 'coinbase',
    name: 'Coinbase Wallet',
    swapFeePct: 1.00,
    estimatedGasUsd: 0.08,
    ataRentReserveUsd: 0.0,
    description: 'Coinbase Wallet 1.00% swap fee + Base/EVM gas',
  },
  ledger: {
    walletId: 'ledger',
    name: 'Ledger Hardware',
    swapFeePct: 0.0,
    estimatedGasUsd: 0.05,
    ataRentReserveUsd: 0.0,
    description: '0% hardware wallet fee + raw on-chain gas',
  },
  paper: {
    walletId: 'paper',
    name: 'Internal Hot / Paper Vault',
    swapFeePct: 0.30,
    estimatedGasUsd: 0.002,
    ataRentReserveUsd: 0.0,
    description: 'Simulated 0.30% DEX pool fee + micro-gas',
  },
};

export let activeWalletProvider = 'paper';

export interface LiveWalletRecord {
  chain: string;
  address: string;
  name: string;
  type: string;
  native_balance: string;
  balance_usd: string;
  raw_balance_num: number;
  gas_status: 'HEALTHY' | 'LOW' | 'INSUFFICIENT' | 'DISCONNECTED';
  signing_available: boolean;
  network: string;
  is_connected: boolean;
  is_read_only: boolean;
  rpc_endpoint: string;
  last_verified_at: number;
  connected_at: number;
}

const liveWalletsRegistry: Map<string, LiveWalletRecord> = new Map();

export async function queryOnChainBalance(chain: string, address: string): Promise<{
  success: boolean;
  chain: string;
  address: string;
  native_balance: number;
  formatted_balance: string;
  native_symbol: string;
  balance_usd: number;
  formatted_usd: string;
  lamports?: number;
  rpc_endpoint: string;
  updated_at: number;
  error?: string;
}> {
  const normChain = chain.toLowerCase();
  if (normChain === 'solana') {
    const endpoints = [
      'https://api.mainnet-beta.solana.com',
      'https://solana-rpc.publicnode.com',
      'https://rpc.ankr.com/solana',
    ];
    let lamports = 0;
    let successfulEndpoint = endpoints[0];
    let fetched = false;

    for (const ep of endpoints) {
      try {
        const resp = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [address, { commitment: 'confirmed' }],
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.result && typeof data.result.value === 'number') {
            lamports = data.result.value;
            successfulEndpoint = ep;
            fetched = true;
            break;
          }
        }
      } catch {}
    }

    if (!fetched) {
      return {
        success: false,
        chain: 'solana',
        address,
        native_balance: 0,
        formatted_balance: '0.00000 SOL',
        native_symbol: 'SOL',
        balance_usd: 0,
        formatted_usd: '$0.00',
        rpc_endpoint: successfulEndpoint,
        updated_at: Date.now(),
        error: 'RPC timeout / unreachable',
      };
    }

    const solBalance = lamports / 1e9;
    const solPrice = await getSolPriceUsd();
    const usdVal = solBalance * solPrice;
    return {
      success: true,
      chain: 'solana',
      address,
      native_balance: solBalance,
      formatted_balance: `${solBalance.toFixed(5)} SOL`,
      native_symbol: 'SOL',
      balance_usd: usdVal,
      formatted_usd: `$${usdVal.toFixed(2)}`,
      lamports,
      rpc_endpoint: successfulEndpoint,
      updated_at: Date.now(),
    };
  }

  return {
    success: true,
    chain: normChain,
    address,
    native_balance: 0,
    formatted_balance: '0.0000 ETH',
    native_symbol: 'ETH',
    balance_usd: 0,
    formatted_usd: '$0.00',
    rpc_endpoint: 'https://cloudflare-eth.com',
    updated_at: Date.now(),
  };
}

let cachedSolPrice = { price: 145.0, updatedAt: 0 };
async function getSolPriceUsd(): Promise<number> {
  if (Date.now() - cachedSolPrice.updatedAt < 15_000) {
    return cachedSolPrice.price;
  }
  try {
    const jup = await getJson(JUP_PRICE, { ids: 'So11111111111111111111111111111111111111112' }, 3500);
    const p = _f(jup?.['So11111111111111111111111111111111111111112']?.usdPrice);
    if (p && p > 1) {
      cachedSolPrice = { price: p, updatedAt: Date.now() };
      return p;
    }
  } catch {}
  try {
    const ds = await getJson(`${DEX}/latest/dex/tokens/So11111111111111111111111111111111111111112`, undefined, 3500);
    const p = _f(ds?.pairs?.[0]?.priceUsd);
    if (p && p > 1) {
      cachedSolPrice = { price: p, updatedAt: Date.now() };
      return p;
    }
  } catch {}
  return cachedSolPrice.price;
}

export function registerLiveWallet(
  chain: string,
  address: string,
  name: string,
  nativeBalance: string,
  balanceUsd: string,
  type = 'solana',
  signingAvailable = true,
  network = 'Solana Mainnet-Beta',
  rpcEndpoint = 'https://api.mainnet-beta.solana.com'
) {
  const normChain = chain.toLowerCase();
  const balNum = parseFloat(nativeBalance) || 0;
  const gasStatus: 'HEALTHY' | 'LOW' | 'INSUFFICIENT' | 'DISCONNECTED' =
    balNum > 0.05 ? 'HEALTHY' : balNum > 0.01 ? 'LOW' : balNum > 0 ? 'INSUFFICIENT' : 'DISCONNECTED';

  liveWalletsRegistry.set(normChain, {
    chain: normChain,
    address,
    name,
    type,
    native_balance: nativeBalance,
    balance_usd: balanceUsd,
    raw_balance_num: balNum,
    gas_status: gasStatus,
    signing_available: signingAvailable,
    network,
    is_connected: true,
    is_read_only: !signingAvailable,
    rpc_endpoint: rpcEndpoint,
    last_verified_at: Date.now(),
    connected_at: Date.now(),
  });
  sniperLog(
    `[WALLET] Provider: ${name} | Network: ${network} | Address: ${address.slice(0, 6)}...${address.slice(-4)} | Balance: ${nativeBalance} (${balanceUsd})`,
    'info',
    'WALLET_CONNECTED'
  );
}

export function disconnectLiveWallet(chain: string) {
  liveWalletsRegistry.delete(chain.toLowerCase());
  sniperLog(`Live wallet disconnected for ${chain.toUpperCase()}`, 'warn', 'WALLET_DISCONNECTED');
}

export function getLiveConnectedWallet(chain: string): LiveWalletRecord | null {
  return liveWalletsRegistry.get(chain.toLowerCase()) || null;
}

export function resolveWalletsForMode(mode: ExecutionMode, targetChain = 'all') {
  const chains = targetChain === 'all' ? ['solana'] : [targetChain.toLowerCase()];
  if (mode === 'paper') {
    return chains.map((ch) => ({
      mode: 'paper',
      chain: ch,
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      name: 'Paper Simulation Account',
      native_balance: 'Simulated USD Ledger',
      balance_usd: `$${ledgers.paper.cash.toFixed(2)}`,
      gas_status: 'HEALTHY',
      is_connected: true,
      is_read_only: false,
    }));
  }
  if (mode === 'testnet') {
    return chains.map((ch) => ({
      mode: 'testnet',
      chain: ch,
      address: 'dev_9wFF4tBvX3...sol',
      name: 'Testnet / Devnet Vault',
      native_balance: '5.00 SOL',
      balance_usd: `$${ledgers.testnet.cash.toFixed(2)}`,
      gas_status: 'HEALTHY',
      is_connected: true,
      is_read_only: false,
    }));
  }
  return chains.map((ch) => {
    const live = liveWalletsRegistry.get(ch);
    if (live && live.is_connected && live.address) {
      return {
        mode: 'live',
        chain: ch,
        address: live.address,
        name: live.name,
        native_balance: live.native_balance,
        balance_usd: live.balance_usd,
        gas_status: live.gas_status,
        is_connected: true,
        is_read_only: live.is_read_only,
      };
    }
    return {
      mode: 'live',
      chain: ch,
      address: null,
      name: `No Real Wallet Connected (${ch.toUpperCase()})`,
      native_balance: '0.00 SOL',
      balance_usd: '$0.00',
      gas_status: 'DISCONNECTED',
      is_connected: false,
      is_read_only: true,
    };
  });
}

// ---------------- LIFECYCLE STATE ----------------
export let currentLifecycleState: BotLifecycleState = 'STOPPED';
export let botStatus = {
  lifecycle_state: currentLifecycleState as BotLifecycleState,
  is_running: false,
  last_price_time: 0,
  started_at: 0,
  scan_cycle_count: 0,
};

const inFlightBuys = new Set<string>();
const inFlightSells = new Set<string>();

const pendingBrowserTxs = new Map<
  string,
  {
    resolve: (res: { signature?: string; error?: string }) => void;
    timer: NodeJS.Timeout;
  }
>();

function requestBrowserWalletSignature(payload: {
  action: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  base64Tx: string;
  userPublicKey: string;
}): Promise<{ signature?: string; error?: string }> {
  return new Promise((resolve) => {
    const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      pendingBrowserTxs.delete(id);
      resolve({ error: 'Phantom wallet confirmation timed out (65s).' });
    }, 65_000);
    pendingBrowserTxs.set(id, { resolve, timer });
    broadcastSse('pending_browser_sign', { id, ...payload });
  });
}

// ---------------- CANDIDATE SOURCES (bot.py exact logic) ----------------
const _srcLast: Record<string, number> = {};
export const _srcStats: Record<string, { items: number; ok_at: number }> = {};
const _seen = new Map<string, number>();
const _srcOf = new Map<string, string>();

function markSeen(mints: Iterable<string>) {
  const t = Date.now();
  for (const m of mints) _seen.set(m, t);
  if (_seen.size > 20000) {
    for (const [k, v] of _seen.entries()) {
      if (t - v > 600_000) _seen.delete(k);
    }
  }
}

function freshOnly(mints: string[]): string[] {
  const t = Date.now();
  return mints.filter((m) => t - (_seen.get(m) ?? 0) > SEEN_TTL_MS);
}

async function _srcGecko(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_gecko) return [];
  const out: string[] = [];
  for (const page of [1, 2]) {
    const data = await getJson(GECKO, { page });
    if (!data || !Array.isArray(data.data)) continue;
    for (const pool of data.data) {
      const tid = pool?.relationships?.base_token?.data?.id || '';
      if (typeof tid === 'string' && tid.startsWith('solana_')) {
        const mint = tid.slice('solana_'.length);
        if (mint && mint.length > 20) out.push(mint);
      }
    }
  }
  return out;
}

async function _srcJup(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_jupiter_recent) return [];
  const hdrs = cfg.jupiter_api_key ? { 'x-api-key': cfg.jupiter_api_key } : undefined;
  const data = await getJson(`${JUP}/recent`, undefined, 6000, hdrs);
  const items = Array.isArray(data) ? data : data?.tokens || data?.data || [];
  if (!Array.isArray(items)) return [];
  return items.map((t: any) => t?.id).filter((id: any) => typeof id === 'string' && id.length > 0);
}

async function _srcProfiles(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_dex_profiles) return [];
  const data = await getJson(`${DEX}/token-profiles/latest/v1`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((d: any) => d && d.chainId === 'solana' && typeof d.tokenAddress === 'string')
    .map((d: any) => d.tokenAddress);
}

async function _srcPumpPortal(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_pumpportal) return [];
  const data = await getJson(`${PUMPP}/coins/new`);
  if (!Array.isArray(data)) return [];
  return data.map((c: any) => c?.mint).filter((m: any) => typeof m === 'string' && m.length > 0);
}

async function _srcBoosts(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_promoted_feeds) return [];
  const data = await getJson(`${DEX}/token-boosts/latest/v1`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((d: any) => d && d.chainId === 'solana' && typeof d.tokenAddress === 'string')
    .map((d: any) => d.tokenAddress);
}

const SOURCES: Array<[string, number, (cfg: SniperConfig) => Promise<string[]>]> = [
  ['gecko', 5000, _srcGecko],
  ['jup', 5000, _srcJup],
  ['profiles', 3000, _srcProfiles],
  ['pumpportal', 3000, _srcPumpPortal],
  ['boosts', 10000, _srcBoosts],
];

async function fetchCandidateMints(cfg: SniperConfig, force = false): Promise<string[]> {
  const mints = new Set<string>();
  const nowMs = Date.now();

  await Promise.all(
    SOURCES.map(async ([name, cd, fn]) => {
      if (!force && nowMs - (_srcLast[name] || 0) < cd) return;
      _srcLast[name] = nowMs;
      try {
        const res = (await fn(cfg)) || [];
        _srcStats[name] = { items: res.length, ok_at: Date.now() };
        for (const m of res) {
          if (typeof m === 'string' && m.length >= 39 && m.length <= 50) {
            mints.add(m);
            if (!_srcOf.has(m)) _srcOf.set(m, name);
            if (_srcOf.size > 20000) _srcOf.clear();
          }
        }
      } catch {
        _srcStats[name] = { items: -1, ok_at: 0 };
      }
    })
  );

  const list = Array.from(mints);
  const fresh = freshOnly(list);
  markSeen(list);
  return fresh;
}

// ---------------- ENTRY FILTERS (bot.py exact logic) ----------------
export function passesFilters(pair: any, cfg: SniperConfig, nowMs = Date.now()): [boolean, string, string] {
  const created = Number(pair?.pairCreatedAt || 0);
  if (created <= 0) return [false, 'missing data', 'no pairCreatedAt'];
  const ageS = (nowMs - created) / 1000.0;
  if (ageS > (cfg.max_age_minutes ?? 2) * 60) {
    return [false, 'too old', `${(ageS / 60).toFixed(1)}m > window`];
  }
  if (ageS < -10) return [false, 'clock skew', 'sync system clock'];
  if (_f(pair?.priceUsd) === null) return [false, 'no price', 'no price on DexScreener yet'];

  const m5 = pair?.txns?.m5 || {};
  const buys = Number(m5.buys || 0);
  const sells = Number(m5.sells || 0);
  const ratio = cfg.min_buy_sell_ratio_m5 ?? 1.0;
  if (ratio > 0 && buys < sells * ratio) {
    return [false, 'selling pressure', `${buys}b/${sells}s in last 5m`];
  }
  if (sells >= 5 && sells > Math.max(1, buys) * 2.5) {
    return [false, 'heavy initial dump', `${buys}b/${sells}s`];
  }

  const m5c = _f(pair?.priceChange?.m5);
  if (m5c !== null && m5c > (cfg.max_price_change_m5_pct ?? 300)) {
    return [false, 'already pumped', `+${m5c.toFixed(0)}% in 5m`];
  }
  if (m5c !== null && m5c <= -35) {
    return [false, 'already dumping', `${m5c.toFixed(0)}% in 5m`];
  }

  if (ageS > (cfg.ultra_early_grace_sec ?? 10)) {
    const liq = _f(pair?.liquidity?.usd) || 0.0;
    if (liq < (cfg.min_liquidity_usd ?? 300)) {
      return [false, 'low liquidity', `$${liq.toFixed(0)} < $${(cfg.min_liquidity_usd ?? 0).toFixed(0)}`];
    }
    if (buys < (cfg.min_buys_m5 ?? 2)) {
      return [false, 'few buys', `${buys} buys in last 5m`];
    }
    if ((cfg.min_volume_m5_usd ?? 0) > 0) {
      const mv5 = _f(pair?.volume?.m5) || 0.0;
      if (mv5 < cfg.min_volume_m5_usd) {
        return [false, 'low m5 volume', `$${mv5.toFixed(0)}`];
      }
    }
    if ((cfg.min_holders ?? 0) > 0) {
      const h1b = Number(pair?.txns?.h1?.buys || 0);
      if (h1b < cfg.min_holders) {
        return [false, 'too few h1 buys', `${h1b}`];
      }
    }
  }
  return [true, 'ok', ''];
}

// ---------------- HARD RUG SCREEN (bot.py exact logic) ----------------
const _rugCache = new Map<string, [number, [boolean, string]]>();

async function rpcMintAuthorities(mint: string): Promise<[boolean, string | null, string | null]> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [mint, { encoding: 'jsonParsed' }],
  });
  for (const url of RPC_URLS) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const parsed = json?.result?.value?.data?.parsed;
      if (parsed?.type === 'mint') {
        const inf = parsed.info || {};
        return [true, inf.mintAuthority || null, inf.freezeAuthority || null];
      }
    } catch {}
  }
  return [false, null, null];
}

export async function hardRugCheck(mint: string, cfg: SniperConfig, ageS: number): Promise<[boolean, string]> {
  const ttlMs = Math.max(60, (cfg.rug_recheck_minutes ?? 15) * 60) * 1000;
  const hit = _rugCache.get(mint);
  if (hit && Date.now() - hit[0] < ttlMs) {
    return hit[1];
  }

  let verdict: [boolean, string] = [true, 'ok'];
  const [rpcOk, ma, fa] = await rpcMintAuthorities(mint);
  if (rpcOk) {
    if (ma) verdict = [false, 'mint authority NOT revoked (on-chain: dev can mint supply)'];
    else if (fa) verdict = [false, 'freeze authority enabled (on-chain: dev can freeze sells)'];
  } else {
    const hdrs = cfg.jupiter_api_key ? { 'x-api-key': cfg.jupiter_api_key } : undefined;
    let jt = await getJson(`${JUP}/search`, { query: mint }, 6000, hdrs);
    if (jt && !Array.isArray(jt)) jt = jt.tokens || jt.data || [];
    if (Array.isArray(jt) && jt.length > 0) {
      const tok = jt.find((t: any) => t && t.id === mint) || jt[0];
      if (tok && typeof tok === 'object') {
        if (tok.mintAuthority) verdict = [false, 'mint authority NOT revoked'];
        else if (tok.freezeAuthority) verdict = [false, 'freeze authority enabled'];
      }
    }
  }

  const young = ageS < 180;
  if (verdict[0] && cfg.use_rugcheck) {
    const rep = await getJson(`${RUGC}/${mint}/report/summary`, undefined, 8000);
    const risks = rep && typeof rep === 'object' ? rep.risks : null;
    if (Array.isArray(risks)) {
      if (!young) {
        let sn = _f(rep.score_normalised);
        if (sn !== null) {
          if (sn > 100) sn /= 1000.0;
          if (sn >= (cfg.rugcheck_max_score ?? 50)) {
            verdict = [false, `rugcheck risk score ${sn.toFixed(0)}/100`];
          }
        }
      }
      if (verdict[0]) {
        const strict = cfg.strict_rugcheck;
        for (const risk of risks) {
          const level = String(risk?.level || '').toLowerCase();
          const name = String(risk?.name || '');
          const low = name.toLowerCase();
          if (level !== 'danger') {
            if (low.includes('holder')) {
              const txt = `${String(risk?.description || '')} ${name}`;
              const m = txt.match(/([\d.]+)\s*%/);
              if (m && parseFloat(m[1]) > (cfg.max_top10_holder_pct ?? 75)) {
                verdict = [false, `${name} (${m[1]}%)`];
                break;
              }
            }
            continue;
          }
          if (ageS < 30 && (low.includes('liquidity') || low.includes('lp'))) continue;
          if (!strict && !(low.includes('mint') || low.includes('freeze') || low.includes('authorit') || low.includes('holder'))) {
            continue;
          }
          verdict = [false, `rugcheck danger: ${name || 'unknown risk'}`];
          break;
        }
      }
    } else if (!young) {
      verdict = [false, 'no rugcheck report (coin not brand new)'];
    }
  }

  if (_rugCache.size > 5000) _rugCache.clear();
  _rugCache.set(mint, [Date.now(), verdict]);
  return verdict;
}

// ---------------- ACCOUNT GUARD & BUY/SELL EXECUTION ----------------
function canOpenPosition(mode: ExecutionMode): { allowed: boolean; reason: string } {
  const ledger = ledgers[mode];
  rollDay(ledger);
  const c = botConfig;

  if (Object.keys(ledger.positions).length >= c.max_open_positions) {
    return { allowed: false, reason: 'max positions' };
  }
  const activeLossLimitUsd =
    c.sizing_basis === 'sol' && (c.daily_loss_limit_sol ?? 0) > 0
      ? c.daily_loss_limit_sol * (cachedSolPrice.price || 145)
      : c.daily_loss_limit_usd;
  if (activeLossLimitUsd > 0 && ledger.day_pnl <= -activeLossLimitUsd) {
    return { allowed: false, reason: 'daily loss limit' };
  }

  if (mode === 'live') {
    const liveWallet = getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana');
    const hasKeypair = Boolean(getTradingKeypair());
    if (!hasKeypair) {
      if (!liveWallet || !liveWallet.is_connected || !liveWallet.address) {
        return { allowed: false, reason: 'no live wallet connected' };
      }
      if (liveWallet.is_read_only || !liveWallet.signing_available) {
        return { allowed: false, reason: 'live wallet is read-only' };
      }
    }
    if (liveWallet && liveWallet.is_connected) {
      const bal = parseFloat(liveWallet.native_balance) || 0;
      if (bal <= c.MIN_GAS_RESERVE_SOL) {
        return { allowed: false, reason: 'insufficient SOL for gas reserve' };
      }
    }
  } else {
    const requiredUsd =
      c.sizing_basis === 'sol' && (c.trade_size_sol ?? 0) > 0
        ? c.trade_size_sol * (cachedSolPrice.price || 145)
        : c.trade_size_usd;
    if (ledger.cash < requiredUsd) {
      return { allowed: false, reason: 'no cash' };
    }
  }
  return { allowed: true, reason: 'ok' };
}

function noteRejected(mode: ExecutionMode, mint: string) {
  const bl = ledgers[mode].blacklist;
  if (!bl.includes(mint)) bl.push(mint);
  if (bl.length > 5000) bl.splice(0, bl.length - 5000);
  saveStateToDisk();
}

async function executeBuy(
  mode: ExecutionMode,
  mint: string,
  symbol: string,
  price: number,
  url?: string,
  meta?: { dex?: string; source?: string; age_s?: number; decimals?: number }
): Promise<boolean> {
  if (inFlightBuys.has(mint)) return false;
  inFlightBuys.add(mint);
  try {
    const ledger = ledgers[mode];
    const check = canOpenPosition(mode);
    if (!check.allowed || ledger.positions[mint]) return false;

    const c = botConfig;
    const cleanUrl = url || `https://dexscreener.com/solana/${mint}`;
    const solPriceUsd = await getSolPriceUsd();
    const useSolBasis = c.sizing_basis === 'sol' && (c.trade_size_sol ?? 0) > 0;
    const tradeSol =
      mode === 'live'
        ? useSolBasis
          ? Math.min(c.trade_size_sol, c.MAX_POSITION_SIZE_SOL || c.trade_size_sol || 1)
          : Math.min(c.trade_size_usd, c.MAX_POSITION_SIZE_USD || 100) / solPriceUsd
        : useSolBasis
        ? c.trade_size_sol
        : c.trade_size_usd / solPriceUsd;
    const size = tradeSol * solPriceUsd;

    let fill = price * (1 + c.slippage_pct / 100);
    let qty = (size * (1 - c.fee_pct / 100)) / fill;
    let txHash: string | undefined;
    let explorerUrl: string | undefined;

    if (mode === 'live') {
      sniperLog(`⚡ [LIVE BUY START] ${symbol}: swapping ${tradeSol.toFixed(4)} SOL ($${size.toFixed(2)})...`, 'buy');

      let liveRes;
      if (getTradingKeypair()) {
        liveRes = await executeLiveSolanaBuy({
          tokenAddress: mint,
          tokenSymbol: symbol,
          tradeAmountSol: tradeSol,
          tradeAmountUsd: size,
          maxSlippageBps: Math.max(50, Math.round(c.slippage_pct * 100)),
          priorityFeeLevel: c.PRIORITY_FEE_LEVEL || 'standard',
          onStepProgress: (step, detail) => {
            broadcastSse('execution_progress', { action: 'BUY', token: symbol, step, detail });
          },
        });
      } else {
        const liveWallet = getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana');
        if (!liveWallet?.address) {
          sniperLog(`✗ [LIVE BUY FAILED] ${symbol}: No connected Phantom wallet`, 'warn');
          return false;
        }
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'PREPARING', detail: 'Fetching Jupiter quote...' });
        const prep = await prepareLiveBuyTransaction({
          userPublicKey: liveWallet.address,
          tokenAddress: mint,
          tokenSymbol: symbol,
          tradeAmountSol: tradeSol,
          tradeAmountUsd: size,
          maxSlippageBps: Math.max(50, Math.round(c.slippage_pct * 100)),
          priorityFeeLevel: c.PRIORITY_FEE_LEVEL || 'standard',
        });
        if (!prep.success || !prep.base64Tx) {
          sniperLog(`✗ [LIVE BUY FAILED] ${symbol}: ${prep.error}`, 'warn');
          broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'FAILED', error: prep.error });
          return false;
        }
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'PHANTOM_CONFIRM', detail: 'Approve swap in Phantom popup...' });
        const sigRes = await requestBrowserWalletSignature({
          action: 'BUY',
          symbol,
          mint,
          base64Tx: prep.base64Tx,
          userPublicKey: liveWallet.address,
        });
        if (!sigRes.signature) {
          sniperLog(`✗ [LIVE BUY CANCELLED] ${symbol}: ${sigRes.error}`, 'warn');
          broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'FAILED', error: sigRes.error });
          return false;
        }
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'CONFIRMING', detail: `Confirming ${sigRes.signature.slice(0, 8)}...` });
        liveRes = await finalizeBrowserSignedTransaction({
          signature: sigRes.signature,
          targetMint: mint,
          userPubkey: liveWallet.address,
          isBuy: true,
          tradeAmountUsd: size,
          tradeAmountSol: tradeSol,
          estTokensOut: prep.estTokensOut,
          solPriceUsd,
        });
      }

      if (!liveRes.success) {
        sniperLog(`✗ [LIVE BUY FAILED] ${symbol}: ${liveRes.error}`, 'warn');
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'FAILED', error: liveRes.error });
        return false;
      }
      broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'CONFIRMED', detail: `Tx ${liveRes.signature?.slice(0, 8)}` });
      fill = liveRes.actualEffectivePriceUsd || fill;
      qty = liveRes.actualAmountOut || qty;
      txHash = liveRes.signature;
      explorerUrl = liveRes.explorerUrl;
    } else {
      ledger.cash -= size;
    }

    ledger.positions[mint] = {
      mint,
      symbol,
      qty,
      entry_price: fill,
      cost: size,
      cost_sol: tradeSol,
      opened: Date.now(),
      url: cleanUrl,
      peak_price: fill,
      low_price: fill,
      dex: meta?.dex || '?',
      source: meta?.source || '?',
      age_at_entry: Math.round((meta?.age_s || 0) * 10) / 10,
      decimals: meta?.decimals || 6,
      tx_hash_buy: txHash,
      explorer_url: explorerUrl,
      mode,
      last_seen_price_at: Date.now(),
      failed_sell_attempts: 0,
    };
    if (!ledger.blacklist.includes(mint)) ledger.blacklist.push(mint);
    livePrices.set(mint, fill);
    lastPriceTime = Date.now();

    const tradeRow: SniperTradeRow = {
      id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      mode,
      time: new Date().toISOString(),
      action: 'BUY',
      symbol,
      mint,
      price: fill,
      usd: size,
      sol_amount: Math.round(tradeSol * 1e6) / 1e6,
      pnl_usd: null,
      pnl_sol: null,
      pnl_pct: null,
      reason: 'sniper_entry',
      dexscreener: cleanUrl,
      age_s: Math.round((meta?.age_s || 0) * 10) / 10,
      dex: meta?.dex || '?',
      source: meta?.source || '?',
      tx_hash: txHash,
      explorer_url: explorerUrl,
    };
    ledger.trades.unshift(tradeRow);
    if (ledger.trades.length > 500) ledger.trades.length = 500;
    appendTradeCsv(tradeRow);

    sniperLog(
      `✓ SNIPER BUY ${symbol} [${meta?.dex || '?'}/${meta?.source || '?'}] ${tradeSol.toFixed(4)} SOL ($${size.toFixed(2)}) @ $${fmtPrice(fill)}${txHash ? ` (tx: ${txHash.slice(0, 8)}...)` : ''}`,
      'buy'
    );
    saveStateToDisk();
    broadcastSse('trade_event', { action: 'BUY', mode, mint });
    return true;
  } finally {
    inFlightBuys.delete(mint);
  }
}

async function executeSell(mode: ExecutionMode, mint: string, price: number, reason: string): Promise<boolean> {
  if (inFlightSells.has(mint)) return false;
  inFlightSells.add(mint);
  try {
    const ledger = ledgers[mode];
    const pos = ledger.positions[mint];
    if (!pos) return false;

    const c = botConfig;
    const safePrice = Math.max(0, Number.isFinite(price) ? price : 0);
    let fill = safePrice * (1 - c.slippage_pct / 100);
    let proceeds = pos.qty * fill * (1 - c.fee_pct / 100);
    let txHash: string | undefined;
    let explorerUrl: string | undefined;
    let effectiveReason = reason;

    const isEmergencyOrRugExit =
      reason.startsWith('rug_') || reason.startsWith('stop_loss_') || reason.startsWith('max_hold');
    const dropPct = pos.entry_price > 0 ? (safePrice / pos.entry_price - 1) * 100 : -100;

    const shouldWriteOffDeadRug = (errMsg: string): boolean => {
      pos.failed_sell_attempts = (pos.failed_sell_attempts || 0) + 1;
      saveStateToDisk();
      const lowErr = String(errMsg || '').toLowerCase();
      const unroutable =
        lowErr.includes('no route') ||
        lowErr.includes('could not find any route') ||
        lowErr.includes('route') ||
        lowErr.includes('liquidity') ||
        lowErr.includes('too small') ||
        lowErr.includes('zero') ||
        lowErr.includes('balance is 0') ||
        lowErr.includes('not tradable');
      const isDeadOrRugged = reason.startsWith('rug_') || dropPct <= -75 || safePrice <= 0;
      return (unroutable && (isDeadOrRugged || pos.failed_sell_attempts >= 2)) || (isDeadOrRugged && pos.failed_sell_attempts >= 4);
    };

    const writeOffDeadPosition = (errMsg: string): boolean => {
      fill = 0;
      proceeds = 0;
      effectiveReason = `${reason}_unsellable_writeoff`;
      sniperLog(
        `⚠ [RUG WRITE-OFF] ${pos.symbol} un-sellable (${errMsg}) — cleared slot at $0 so bot can continue trading.`,
        'warn'
      );
      broadcastSse('execution_progress', {
        action: 'SELL',
        token: pos.symbol,
        step: 'CONFIRMED',
        detail: 'Rugpull slot cleared ($0 write-off)',
      });
      return true;
    };

    if (mode === 'live') {
      if (safePrice <= 0 && reason === 'rug_no_price_auto_clear' && (pos.failed_sell_attempts || 0) >= 2) {
        writeOffDeadPosition('token has no price/pool quote');
      } else {
        sniperLog(`⚡ [LIVE SELL START] ${pos.symbol} (${reason})...`, 'sell');
        const solPriceUsd = await getSolPriceUsd();
        const exitSlippageBps = isEmergencyOrRugExit
          ? Math.max(2500, Math.round(c.slippage_pct * 100))
          : Math.max(50, Math.round(c.slippage_pct * 100));
        let liveRes: any;

        if (getTradingKeypair()) {
          liveRes = await executeLiveSolanaSell({
            tokenAddress: mint,
            tokenSymbol: pos.symbol,
            tokenQuantity: pos.qty,
            tokenDecimals: pos.decimals || 6,
            maxSlippageBps: exitSlippageBps,
            priorityFeeLevel: 'high',
            onStepProgress: (step, detail) => {
              broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step, detail });
            },
          });
        } else {
          const liveWallet = getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana');
          if (!liveWallet?.address) {
            sniperLog(`✗ [LIVE SELL FAILED] ${pos.symbol}: No connected Phantom wallet`, 'warn');
            return false;
          }
          broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'PREPARING', detail: 'Fetching Jupiter exit quote...' });
          const prep = await prepareLiveSellTransaction({
            userPublicKey: liveWallet.address,
            tokenAddress: mint,
            tokenSymbol: pos.symbol,
            tokenQuantity: pos.qty,
            tokenDecimals: pos.decimals || 6,
            maxSlippageBps: exitSlippageBps,
            priorityFeeLevel: 'high',
          });
          if (!prep.success || !prep.base64Tx) {
            const err = prep.error || 'No swap route';
            if (shouldWriteOffDeadRug(err)) {
              writeOffDeadPosition(err);
              liveRes = { success: true, _writeOff: true };
            } else {
              sniperLog(`✗ [LIVE SELL FAILED] ${pos.symbol}: ${err}`, 'warn');
              broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'FAILED', error: err });
              return false;
            }
          } else {
            broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'PHANTOM_CONFIRM', detail: 'Approve sell in Phantom popup...' });
            const sigRes = await requestBrowserWalletSignature({
              action: 'SELL',
              symbol: pos.symbol,
              mint,
              base64Tx: prep.base64Tx,
              userPublicKey: liveWallet.address,
            });
            if (!sigRes.signature) {
              sniperLog(`✗ [LIVE SELL CANCELLED] ${pos.symbol}: ${sigRes.error}`, 'warn');
              broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'FAILED', error: sigRes.error });
              return false;
            }
            broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'CONFIRMING', detail: `Confirming ${sigRes.signature.slice(0, 8)}...` });
            liveRes = await finalizeBrowserSignedTransaction({
              signature: sigRes.signature,
              targetMint: mint,
              userPubkey: liveWallet.address,
              isBuy: false,
              estSolReceived: prep.estSolReceived,
              tokenQuantity: pos.qty,
              solPriceUsd,
            });
          }
        }

        if (!liveRes?._writeOff) {
          if (!liveRes?.success) {
            const err = liveRes?.error || 'Live swap failed';
            if (shouldWriteOffDeadRug(err)) {
              writeOffDeadPosition(err);
            } else {
              sniperLog(`✗ [LIVE SELL FAILED] ${pos.symbol}: ${err}`, 'warn');
              broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'FAILED', error: err });
              return false;
            }
          } else {
            broadcastSse('execution_progress', { action: 'SELL', token: pos.symbol, step: 'CONFIRMED', detail: `Tx ${liveRes.signature?.slice(0, 8)}` });
            const actualSol = liveRes.actualAmountOut || (proceeds / solPriceUsd);
            proceeds = actualSol * solPriceUsd;
            fill = liveRes.actualEffectivePriceUsd || (proceeds / pos.qty);
            txHash = liveRes.signature;
            explorerUrl = liveRes.explorerUrl;
          }
        }
      }
    } else {
      ledger.cash += proceeds;
    }

    const solPriceNow = await getSolPriceUsd();
    const costSol = pos.cost_sol ?? (solPriceNow > 0 ? pos.cost / solPriceNow : 0);
    const proceedsSol = solPriceNow > 0 ? proceeds / solPriceNow : 0;
    const pnlSol = proceedsSol - costSol;

    delete ledger.positions[mint];
    const pnl = proceeds - pos.cost;
    const pnlPct = pos.cost > 0 ? (pnl / pos.cost) * 100 : 0;

    rollDay(ledger);
    ledger.day_pnl += pnl;
    ledger.total_pnl += pnl;
    ledger.closed += 1;
    if (pnl > 0) ledger.wins += 1;

    const tradeRow: SniperTradeRow = {
      id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      mode,
      time: new Date().toISOString(),
      action: 'SELL',
      symbol: pos.symbol,
      mint,
      price: fill,
      usd: proceeds,
      sol_amount: Math.round(proceedsSol * 1e6) / 1e6,
      pnl_usd: Math.round(pnl * 10000) / 10000,
      pnl_sol: Math.round(pnlSol * 1e6) / 1e6,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      reason: effectiveReason,
      dexscreener: pos.url || `https://dexscreener.com/solana/${mint}`,
      dex: pos.dex,
      source: pos.source,
      tx_hash: txHash,
      explorer_url: explorerUrl,
    };
    ledger.trades.unshift(tradeRow);
    if (ledger.trades.length > 500) ledger.trades.length = 500;
    appendTradeCsv(tradeRow);

    sniperLog(
      `✗ SELL ${pos.symbol} @ $${fmtPrice(fill)} pnl ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL ($${pnl.toFixed(2)} / ${pnlPct.toFixed(1)}%) [${effectiveReason}]${txHash ? ` (tx: ${txHash.slice(0, 8)}...)` : ''}`,
      'sell'
    );
    saveStateToDisk();
    broadcastSse('trade_event', { action: 'SELL', mode, mint });
    return true;
  } finally {
    inFlightSells.delete(mint);
  }
}

async function checkExits(
  mode: ExecutionMode,
  prices: Map<string, number>,
  liquidities: Map<string, number> = new Map()
): Promise<number> {
  const ledger = ledgers[mode];
  const cfg = botConfig;
  const tp = cfg.take_profit_pct ?? 50;
  const trail = cfg.trailing_stop_pct ?? 0;
  const sl = cfg.stop_loss_pct ?? 35;
  const rugDrop = cfg.rug_exit_drop_pct ?? 85;
  const maxHoldMin = cfg.max_hold_minutes ?? 120;
  let exits = 0;

  for (const [mint, pos] of Object.entries(ledger.positions)) {
    const price = prices.get(mint);
    const heldMin = (Date.now() - pos.opened) / 60000;
    const lastSeen = pos.last_seen_price_at || pos.opened;
    const staleMin = (Date.now() - lastSeen) / 60000;
    const liq = liquidities.get(mint) ?? pos.last_liquidity_usd;

    if (price === undefined || price === null) {
      let staleReason: string | null = null;
      if (heldMin >= maxHoldMin) {
        staleReason = 'max_hold_no_price';
      } else if (rugDrop > 0 && staleMin >= 3) {
        staleReason = 'rug_no_price_auto_clear';
      }
      if (staleReason) {
        const exitPx = staleMin >= 2 ? 0 : (livePrices.get(mint) ?? 0);
        const ok = await executeSell(mode, mint, exitPx, staleReason);
        if (ok) exits += 1;
      }
      continue;
    }

    if (price > 0) {
      pos.last_seen_price_at = Date.now();
    }

    const entry = pos.entry_price;
    pos.peak_price = Math.max(pos.peak_price || entry, price);
    pos.low_price = Math.min(pos.low_price || entry, price);

    const change = price <= 0 || entry <= 0 ? -100 : (price / entry - 1) * 100;
    const peakChg = entry > 0 ? (pos.peak_price / entry - 1) * 100 : 0;
    let reason: string | null = null;

    if (price <= 0) {
      reason = 'rug_zero_price';
    } else if (tp > 0 && change >= tp) {
      reason = `take_profit_${tp}`;
    } else if (trail > 0 && peakChg >= 10 && (pos.peak_price / price - 1) * 100 >= trail) {
      reason = `trailing_stop_${trail}`;
    } else if (rugDrop > 0 && change <= -rugDrop) {
      reason = `rug_drop_${rugDrop}`;
    } else if (sl > 0 && change <= -sl) {
      reason = `stop_loss_${sl}`;
    } else if (rugDrop > 0 && liq !== undefined && liq < 50 && change <= -35) {
      reason = 'rug_liquidity_pulled';
    } else if (heldMin >= maxHoldMin) {
      reason = 'max_hold';
    }

    if (reason) {
      const ok = await executeSell(mode, mint, price, reason);
      if (ok) exits += 1;
    }
  }
  return exits;
}

// ---------------- SCAN / MONITOR ENGINE ----------------
let _stats = {
  since: Date.now(),
  cands: 0,
  no_pair: 0,
  checked: 0,
  rejects: {} as Record<string, number>,
  rug: 0,
  bought: 0,
};
let _lastBlockLog = 0;

function maybeSummary() {
  if (Date.now() - _stats.since < 60_000) return;
  const { cands, no_pair: noPair, checked, rejects, rug, bought } = _stats;
  const srcBits = Object.entries(_srcStats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, v]) => `${n}=${v.items ?? 0}${Date.now() - (v.ok_at || 0) > 120_000 ? '*' : ''}`);
  _stats = { since: Date.now(), cands: 0, no_pair: 0, checked: 0, rejects: {}, rug: 0, bought: 0 };

  const rejTxt = Object.entries(rejects)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  sniperLog(
    `scan summary (60s): sources[${srcBits.join(' ') || 'none'}] new-mints=${cands} not-on-dexscreener=${noPair} evaluated=${checked} rejected[${rejTxt || '-'}] rug=${rug} BOUGHT=${bought}`,
    'summary'
  );
  const srcVals = Object.values(_srcStats);
  if (cands === 0 && srcVals.length > 0 && srcVals.every((v) => Date.now() - (v.ok_at || 0) > 60_000)) {
    sniperLog('⚠ all candidate sources returned nothing for 60s — check internet / rate limits', 'warn');
  }
}

async function scanAndBuy() {
  if (currentLifecycleState !== 'RUNNING') return;
  const mode = botConfig.EXECUTION_MODE;
  maybeSummary();

  const openCheck = canOpenPosition(mode);
  if (!openCheck.allowed) {
    if (Date.now() - _lastBlockLog > 30_000) {
      _lastBlockLog = Date.now();
      sniperLog(
        `Cannot trade: ${openCheck.reason}${openCheck.reason === 'max positions' ? ' — sell/close positions in the Open positions tab' : ''}`,
        'warn'
      );
    }
    return;
  }

  const fresh = await fetchCandidateMints(botConfig);
  if (fresh.length === 0) return;
  _stats.cands += fresh.length;

  const nowMs = Date.now();
  const pairs = new Map<string, [number, any]>();
  for (let i = 0; i < fresh.length; i += 30) {
    if (currentLifecycleState !== 'RUNNING') return;
    const chunk = fresh.slice(i, i + 30);
    const data = await getJson(`${DEX}/tokens/v1/solana/${chunk.join(',')}`);
    if (!Array.isArray(data)) continue;
    for (const p of data) {
      const mint = p?.baseToken?.address;
      if (!mint) continue;
      const liq = _f(p?.liquidity?.usd) || 0.0;
      const cur = pairs.get(mint);
      if (!cur || liq > cur[0]) {
        pairs.set(mint, [liq, p]);
      }
    }
  }
  _stats.no_pair += Math.max(0, fresh.length - pairs.size);

  const ledger = ledgers[mode];
  for (const [mint, [, pair]] of pairs.entries()) {
    if (currentLifecycleState !== 'RUNNING') break;
    if (!canOpenPosition(mode).allowed) break;
    if (ledger.positions[mint] || ledger.blacklist.includes(mint)) continue;

    const symbol = pair?.baseToken?.symbol || '?';
    const [okp, code, detail] = passesFilters(pair, botConfig, nowMs);
    _stats.checked += 1;
    if (!okp) {
      _stats.rejects[code] = (_stats.rejects[code] || 0) + 1;
      if (botConfig.log_rejects) {
        sniperLog(`– ${symbol} filtered: ${code} (${detail})`, 'reject');
      }
      continue;
    }

    const ageS = Math.max(0.0, (nowMs - Number(pair?.pairCreatedAt || 0)) / 1000.0);
    const [rok, rwhy] = await hardRugCheck(mint, botConfig, ageS);
    if (!rok) {
      _stats.rug += 1;
      sniperLog(`✗ RUG REJECT ${symbol}: ${rwhy}`, 'reject');
      noteRejected(mode, mint);
      continue;
    }

    const price = _f(pair?.priceUsd);
    if (price === null) continue;

    const meta = {
      dex: pair?.dexId || '?',
      source: _srcOf.get(mint) || '?',
      age_s: ageS,
      decimals: pair?.baseToken?.decimals || 6,
    };
    const bought = await executeBuy(mode, mint, symbol, price, pair?.url, meta);
    if (bought) _stats.bought += 1;
  }
}

async function fetchJupiterPrices(mints: string[], cfg: SniperConfig): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (!cfg.use_jupiter_price || mints.length === 0) return prices;
  const hdrs = cfg.jupiter_api_key ? { 'x-api-key': cfg.jupiter_api_key } : undefined;
  const data = await getJson(JUP_PRICE, { ids: mints.join(',') }, 4000, hdrs);
  if (!data || typeof data !== 'object') return prices;
  for (const [mint, quote] of Object.entries<any>(data)) {
    const p = _f(quote?.usdPrice);
    if (p !== null) prices.set(mint, p);
  }
  return prices;
}

async function monitorPositions() {
  const mode = botConfig.EXECUTION_MODE;
  const ledger = ledgers[mode];
  const mints = Object.keys(ledger.positions);
  if (mints.length === 0) return;

  const prices = await fetchJupiterPrices(mints, botConfig);
  const liquidities = new Map<string, number>();

  const needDex = mints.filter((m) => {
    const px = prices.get(m);
    if (px === undefined || px <= 0) return true;
    const pos = ledger.positions[m];
    return pos && pos.entry_price > 0 && (px / pos.entry_price - 1) * 100 <= -40;
  });

  for (let i = 0; i < needDex.length; i += 30) {
    const chunk = needDex.slice(i, i + 30);
    const data = await getJson(`${DEX}/tokens/v1/solana/${chunk.join(',')}`, undefined, 4000);
    if (Array.isArray(data)) {
      for (const p of data) {
        const mint = p?.baseToken?.address;
        if (!mint || !ledger.positions[mint]) continue;
        const liq = _f(p?.liquidity?.usd);
        if (liq !== null) {
          const prev = liquidities.get(mint) ?? 0;
          if (liq > prev) liquidities.set(mint, liq);
          ledger.positions[mint].last_liquidity_usd = Math.max(prev, liq);
        }
        if (!prices.has(mint)) {
          const px = _f(p?.priceUsd);
          if (px !== null) prices.set(mint, px);
        }
      }
    }
  }

  if (prices.size > 0) {
    for (const [m, px] of prices.entries()) {
      livePrices.set(m, px);
    }
    lastPriceTime = Date.now();
    botStatus.last_price_time = lastPriceTime;
  }

  await checkExits(mode, prices, liquidities);
}

export async function runProbeDiagnostic(): Promise<string[]> {
  const lines: string[] = [];
  const push = (m: string) => {
    lines.push(m);
    sniperLog(m, 'info', 'PROBE');
  };

  push('--- PROBE: force-fetching all sources now ---');
  const cands = await fetchCandidateMints(botConfig, true);
  push(`probe: ${cands.length} fresh mints right now`);
  if (cands.length === 0) {
    push('probe: 0 candidates → all sources returned nothing (internet / rate limit?)');
    return lines;
  }

  const nowMs = Date.now();
  const grace = botConfig.ultra_early_grace_sec ?? 10;
  let shown = 0;

  for (let i = 0; i < cands.length; i += 30) {
    const chunk = cands.slice(i, i + 30);
    const data = await getJson(`${DEX}/tokens/v1/solana/${chunk.join(',')}`);
    const plist = Array.isArray(data) ? data : [];
    if (plist.length === 0) {
      push(`probe: no pair data on DexScreener for ${chunk.length} mints (too new / not indexed yet)`);
    }
    for (const p of plist) {
      const sym = String(p?.baseToken?.symbol || '?').slice(0, 10).padEnd(10, ' ');
      const dex = String(p?.dexId || '?').slice(0, 10).padEnd(10, ' ');
      const created = Number(p?.pairCreatedAt || 0);
      const age = created ? (nowMs - created) / 1000.0 : -1;
      const liq = _f(p?.liquidity?.usd) || 0.0;
      const m5 = p?.txns?.m5 || {};
      const buys = Number(m5.buys || 0);
      const sells = Number(m5.sells || 0);
      const chg = _f(p?.priceChange?.m5);
      const [ok, code, detail] = passesFilters(p, botConfig, nowMs);
      const tag = ok ? 'WOULD BUY → rug check' : `filtered: ${code} (${detail})`;
      const early = age >= 0 && age <= grace ? ' [ultra-early]' : '';
      push(
        `probe: ${sym} ${dex} age=${age.toFixed(1)}s${early} liq=$${liq.toFixed(0)} ${buys}b/${sells}s m5=${chg !== null ? chg : '?'}% → ${tag}`
      );
      shown += 1;
      if (shown >= 25) {
        push('probe: (first 25 shown)');
        return lines;
      }
    }
  }

  if (shown === 0) {
    push('probe: 0 pairs found on DexScreener for current candidates.');
  }
  return lines;
}

// ---------------- DYNAMIC LOOPS ----------------
let scanTimer: NodeJS.Timeout | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
let isScanningNow = false;
let isMonitoringNow = false;
let lastSaveAt = 0;

function stopEngineLoops() {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
}

function scheduleScanLoop() {
  if (currentLifecycleState !== 'RUNNING') return;
  const started = Date.now();
  (async () => {
    if (!isScanningNow && currentLifecycleState === 'RUNNING') {
      isScanningNow = true;
      try {
        botStatus.scan_cycle_count += 1;
        await scanAndBuy();
      } catch (err: any) {
        sniperLog(`scan error: ${err.message}`, 'warn');
      } finally {
        isScanningNow = false;
      }
    }
    if (currentLifecycleState === 'RUNNING') {
      const elapsed = Date.now() - started;
      const delay = Math.max(100, (botConfig.scan_interval_sec || 1) * 1000 - elapsed);
      scanTimer = setTimeout(scheduleScanLoop, delay);
    }
  })();
}

function scheduleMonitorLoop() {
  if (currentLifecycleState !== 'RUNNING') return;
  const started = Date.now();
  (async () => {
    if (!isMonitoringNow && currentLifecycleState === 'RUNNING') {
      isMonitoringNow = true;
      try {
        await monitorPositions();
        if (Date.now() - lastSaveAt >= 10_000) {
          saveStateToDisk();
          lastSaveAt = Date.now();
        }
      } catch (err: any) {
        sniperLog(`monitor error: ${err.message}`, 'warn');
      } finally {
        isMonitoringNow = false;
      }
    }
    if (currentLifecycleState === 'RUNNING') {
      const elapsed = Date.now() - started;
      const delay = Math.max(100, (botConfig.monitor_interval_sec || 1.0) * 1000 - elapsed);
      monitorTimer = setTimeout(scheduleMonitorLoop, delay);
    }
  })();
}

function startBotEngine() {
  if (currentLifecycleState === 'RUNNING') return;
  currentLifecycleState = 'RUNNING';
  botStatus.lifecycle_state = 'RUNNING';
  botStatus.is_running = true;
  botStatus.started_at = Date.now();
  const modeLabel = botConfig.EXECUTION_MODE === 'live' ? 'LIVE MODE - REAL MONEY' : `${botConfig.EXECUTION_MODE.toUpperCase()} MODE - no real money`;
  sniperLog(`Bot started (${modeLabel})`, 'info', 'STATE_CHANGE');
  sniperLog(
    `Sources: gecko=${botConfig.use_gecko} jupiter=${botConfig.use_jupiter_recent} profiles=${botConfig.use_dex_profiles} pumpportal=${botConfig.use_pumpportal} boosts=${botConfig.use_promoted_feeds}`,
    'info',
    'STATE_CHANGE'
  );
  sniperLog(
    `Window: coins < ${(botConfig.max_age_minutes * 60).toFixed(0)}s old (grace <${botConfig.ultra_early_grace_sec}s skips liquidity/buy floors) | TP ${botConfig.take_profit_pct}% | SL ${botConfig.stop_loss_pct}% | RugExit ${botConfig.rug_exit_drop_pct}% | Trail ${botConfig.trailing_stop_pct}% | liq>=$${botConfig.min_liquidity_usd.toFixed(0)} after grace | rug check ${botConfig.use_rugcheck ? 'ON' : 'OFF'}`,
    'info',
    'STATE_CHANGE'
  );
  broadcastSse('status', botStatus);
  scheduleScanLoop();
  scheduleMonitorLoop();
}

function stopBotEngine() {
  if (currentLifecycleState === 'STOPPED') return;
  currentLifecycleState = 'STOPPED';
  botStatus.lifecycle_state = 'STOPPED';
  botStatus.is_running = false;
  stopEngineLoops();
  saveStateToDisk();
  sniperLog('Bot stopped.', 'warn', 'STATE_CHANGE');
  broadcastSse('status', botStatus);
}

// ---------------- VIEW BUILDERS (matching gui.py) ----------------
export function buildPositionRows(mode: ExecutionMode, solPriceUsd = cachedSolPrice.price || 145) {
  const ledger = ledgers[mode] || ledgers.paper;
  const c = botConfig;
  const nowMs = Date.now();
  return Object.values(ledger.positions).map((p) => {
    const price = livePrices.get(p.mint) ?? null;
    let chg: number | null = null;
    let value: number | null = null;
    let pnlUsd: number | null = null;
    if (price !== null && p.entry_price > 0) {
      chg = (price / p.entry_price - 1) * 100;
      value = p.qty * price * (1 - c.slippage_pct / 100) * (1 - c.fee_pct / 100);
      pnlUsd = value - p.cost;
    }
    const costSol = p.cost_sol ?? (solPriceUsd > 0 ? p.cost / solPriceUsd : 0);
    const valueSol = value !== null && solPriceUsd > 0 ? value / solPriceUsd : null;
    const pnlSol = pnlUsd !== null && solPriceUsd > 0 ? pnlUsd / solPriceUsd : null;
    const peak = p.entry_price > 0 ? ((p.peak_price || p.entry_price) / p.entry_price - 1) * 100 : 0;
    const low = p.entry_price > 0 ? ((p.low_price || p.entry_price) / p.entry_price - 1) * 100 : 0;
    const heldMin = (nowMs - p.opened) / 60000;
    return {
      mint: p.mint,
      symbol: p.symbol,
      entry: p.entry_price,
      now: price,
      chg,
      pnl_usd: pnlUsd,
      pnl_sol: pnlSol,
      value,
      value_sol: valueSol,
      cost: p.cost,
      cost_sol: costSol,
      peak,
      low,
      held: heldMin,
      dex: p.dex,
      source: p.source,
      age_at_entry: p.age_at_entry,
      url: p.url,
      tx_hash_buy: p.tx_hash_buy,
      explorer_url: p.explorer_url,
      mode: p.mode,
    };
  });
}

export function buildPortfolioStats(mode: ExecutionMode, solPriceUsd = cachedSolPrice.price || 145) {
  const ledger = ledgers[mode] || ledgers.paper;
  rollDay(ledger);
  const rows = buildPositionRows(mode, solPriceUsd);
  const openPnl = rows.reduce((sum, r) => sum + (r.pnl_usd ?? 0), 0);
  const openValue = rows.reduce((sum, r) => sum + (r.value ?? r.cost), 0);
  const wins = ledger.wins;
  const closed = ledger.closed;

  let cash = ledger.cash;
  let cashSol = solPriceUsd > 0 ? cash / solPriceUsd : 0;
  if (mode === 'live') {
    const liveWallet = getLiveConnectedWallet(botConfig.DEFAULT_CHAIN || 'solana');
    cashSol = liveWallet && liveWallet.is_connected ? liveWallet.raw_balance_num || 0 : 0;
    const parsedUsd = liveWallet && liveWallet.is_connected ? parseFloat(liveWallet.balance_usd.replace(/[^0-9.]/g, '')) || 0 : 0;
    cash = cashSol > 0 && solPriceUsd > 0 ? cashSol * solPriceUsd : parsedUsd;
  }

  const totalValueUsd = cash + openValue;
  const valueSol = solPriceUsd > 0 ? totalValueUsd / solPriceUsd : 0;
  const openPnlSol = solPriceUsd > 0 ? openPnl / solPriceUsd : 0;
  const dayPnlSol = solPriceUsd > 0 ? ledger.day_pnl / solPriceUsd : 0;
  const totalPnlSol = solPriceUsd > 0 ? ledger.total_pnl / solPriceUsd : 0;

  return {
    mode,
    sol_price_usd: solPriceUsd,
    cash,
    cash_sol: cashSol,
    value: totalValueUsd,
    value_sol: valueSol,
    open_pnl: openPnl,
    open_pnl_sol: openPnlSol,
    day_pnl: ledger.day_pnl,
    day_pnl_sol: dayPnlSol,
    total_pnl: ledger.total_pnl,
    total_pnl_sol: totalPnlSol,
    closed,
    wins,
    win_rate_pct: closed > 0 ? Math.round((wins / closed) * 1000) / 10 : 0,
    winrate: closed > 0 ? `${((wins / closed) * 100).toFixed(0)}%  (${wins}/${closed})` : 'no closed trades',
    open_positions_count: rows.length,
    day: ledger.day,
  };
}

// ---------------- EXPRESS SERVER SETUP ----------------
async function startServer() {
  ensureTradesLogFile();
  loadSettingsFromDisk();
  loadStateFromDisk();

  sniperLog("Window ready. Press 'Start bot' to begin trading.", 'info', 'SYSTEM_INIT');

  const app = express();
  const PORT = 3000;
  app.use(express.json());

  // SSE stream
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: connected\ndata: ${JSON.stringify({ lifecycle: currentLifecycleState })}\n\n`);
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
  });

  app.get('/api/heartbeat', (_req, res) => {
    const mode = botConfig.EXECUTION_MODE;
    res.json({
      status: 'OK',
      lifecycle_state: currentLifecycleState,
      execution_mode: mode,
      total_positions: Object.keys(ledgers[mode].positions).length,
      total_trades: ledgers[mode].trades.length,
      last_price_time: lastPriceTime,
      sol_price_usd: cachedSolPrice.price,
      timestamp: Date.now(),
    });
  });

  app.get('/api/status', async (req, res) => {
    const mode = ((req.query.mode as ExecutionMode) || botConfig.EXECUTION_MODE) as ExecutionMode;
    const liveWallet = getLiveConnectedWallet(botConfig.DEFAULT_CHAIN || 'solana');
    const solPriceUsd = await getSolPriceUsd();
    res.json({
      config: botConfig,
      status: {
        ...botStatus,
        lifecycle_state: currentLifecycleState,
      },
      portfolio: buildPortfolioStats(mode, solPriceUsd),
      sol_price_usd: solPriceUsd,
      live_wallet: liveWallet,
      src_stats: _srcStats,
    });
  });

  app.get('/api/positions', async (req, res) => {
    const mode = ((req.query.mode as ExecutionMode) || botConfig.EXECUTION_MODE) as ExecutionMode;
    const solPriceUsd = await getSolPriceUsd();
    res.json(buildPositionRows(mode, solPriceUsd));
  });

  app.post('/api/positions/:mint/sell', async (req, res) => {
    const mode = botConfig.EXECUTION_MODE;
    const mint = req.params.mint;
    const ledger = ledgers[mode];
    const pos = ledger.positions[mint];
    if (!pos) {
      return res.status(404).json({ error: 'That position is already closed.' });
    }

    let price = livePrices.get(mint);
    if (!price) {
      const fresh = await fetchJupiterPrices([mint], botConfig);
      price = fresh.get(mint);
    }
    if (!price) {
      const ds = await getJson(`${DEX}/tokens/v1/solana/${mint}`, undefined, 4000);
      if (Array.isArray(ds) && ds[0]?.priceUsd) price = _f(ds[0].priceUsd) ?? undefined;
    }
    const reason = !price || price <= 0 ? 'manual_no_price_writeoff' : 'manual';
    const finalPrice = !price || price <= 0 ? 0 : price;

    const ok = await executeSell(mode, mint, finalPrice, reason);
    if (!ok) {
      return res.status(500).json({ error: 'Failed to close position.' });
    }
    res.json({ success: true, message: mode === 'live' ? 'Sold / cleared (live).' : 'Sold / cleared (paper trade).' });
  });

  app.post('/api/positions/sell-all', async (_req, res) => {
    const mode = botConfig.EXECUTION_MODE;
    const ledger = ledgers[mode];
    const mints = Object.keys(ledger.positions);
    let sold = 0;
    for (const mint of mints) {
      let price = livePrices.get(mint);
      if (!price) {
        const fresh = await fetchJupiterPrices([mint], botConfig);
        price = fresh.get(mint);
      }
      if (!price) {
        const ds = await getJson(`${DEX}/tokens/v1/solana/${mint}`, undefined, 3000);
        if (Array.isArray(ds) && ds[0]?.priceUsd) price = _f(ds[0].priceUsd) ?? undefined;
      }
      const hasPrice = price !== undefined && price !== null && price > 0;
      const ok = await executeSell(
        mode,
        mint,
        hasPrice ? price! : 0,
        hasPrice ? 'manual_sell_all' : 'manual_sell_all_no_price'
      );
      if (ok) sold += 1;
    }
    res.json({ success: true, sold_count: sold });
  });

  app.get('/api/trades', (req, res) => {
    const mode = ((req.query.mode as ExecutionMode) || botConfig.EXECUTION_MODE) as ExecutionMode;
    res.json(ledgers[mode]?.trades || []);
  });

  app.get('/api/logs', (_req, res) => {
    res.json(logs);
  });

  app.post('/api/logs/clear', (_req, res) => {
    logs = [];
    res.json({ success: true });
  });

  // ---------------- SETTINGS ----------------
  app.get('/api/settings', (_req, res) => {
    res.json({
      ...botConfig,
      jupiter_api_key: botConfig.jupiter_api_key
        ? `${botConfig.jupiter_api_key.slice(0, 2)}***${botConfig.jupiter_api_key.slice(-2)}`
        : '',
    });
  });

  app.post('/api/settings', (req, res) => {
    const raw = req.body || {};
    const errors: string[] = [];
    const parsed: Partial<SniperConfig> = {};

    for (const [key, val] of Object.entries(raw)) {
      if (key === 'jupiter_api_key') {
        if (typeof val === 'string' && !val.includes('***')) {
          parsed.jupiter_api_key = val.trim();
        }
        continue;
      }
      if (BOOL_SETTINGS.has(key)) {
        (parsed as any)[key] = typeof val === 'string' ? ['1', 'true', 'yes', 'on'].includes(val.trim().toLowerCase()) : Boolean(val);
        continue;
      }
      if (key in SETTING_LIMITS) {
        const num = Number(val);
        if (val === '' || val === null || val === undefined || isNaN(num)) {
          errors.push(`${key}: not a valid number`);
          continue;
        }
        const finalVal = INT_SETTINGS.has(key) ? Math.trunc(num) : num;
        const [lo, hi] = SETTING_LIMITS[key];
        if (finalVal < lo || finalVal > hi) {
          errors.push(`${key}: must be between ${lo} and ${hi}`);
          continue;
        }
        (parsed as any)[key] = finalVal;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('\n') });
    }

    // Mode switch guard
    if (raw.EXECUTION_MODE === 'live' && botConfig.EXECUTION_MODE !== 'live') {
      if (currentLifecycleState === 'RUNNING') {
        return res.status(400).json({ error: 'Cannot switch to Live while bot is running. Please STOP the bot first.' });
      }
    }
    if (raw.EXECUTION_MODE && ['paper', 'testnet', 'live'].includes(raw.EXECUTION_MODE)) {
      parsed.EXECUTION_MODE = raw.EXECUTION_MODE;
    }
    if (raw.DEFAULT_CHAIN) parsed.DEFAULT_CHAIN = String(raw.DEFAULT_CHAIN).toLowerCase();
    if (raw.THEME && ['dark', 'light'].includes(raw.THEME)) parsed.THEME = raw.THEME;
    if (raw.sizing_basis && ['sol', 'usd'].includes(raw.sizing_basis)) parsed.sizing_basis = raw.sizing_basis;
    if (raw.MAX_POSITION_SIZE_USD && Number(raw.MAX_POSITION_SIZE_USD) > 0) {
      parsed.MAX_POSITION_SIZE_USD = Number(raw.MAX_POSITION_SIZE_USD);
    }
    if (raw.MAX_POSITION_SIZE_SOL && Number(raw.MAX_POSITION_SIZE_SOL) > 0) {
      parsed.MAX_POSITION_SIZE_SOL = Number(raw.MAX_POSITION_SIZE_SOL);
    }
    if (raw.MIN_GAS_RESERVE_SOL !== undefined && !isNaN(Number(raw.MIN_GAS_RESERVE_SOL)) && Number(raw.MIN_GAS_RESERVE_SOL) >= 0) {
      parsed.MIN_GAS_RESERVE_SOL = Number(raw.MIN_GAS_RESERVE_SOL);
    }
    if (raw.PRIORITY_FEE_LEVEL && ['standard', 'high', 'ultra'].includes(raw.PRIORITY_FEE_LEVEL)) {
      parsed.PRIORITY_FEE_LEVEL = raw.PRIORITY_FEE_LEVEL;
    }

    botConfig = { ...botConfig, ...parsed };
    saveSettingsToDisk();
    sniperLog('Settings applied and saved.', 'info', 'SETTINGS_UPDATED');
    broadcastSse('status', botStatus);
    res.json({ success: true, config: botConfig });
  });

  // ---------------- CONTROL & PROBE ----------------
  app.post('/api/control', async (req, res) => {
    const { action } = req.body || {};
    switch (action) {
      case 'start_bot': {
        if (botConfig.EXECUTION_MODE === 'live') {
          const liveWallet = getLiveConnectedWallet(botConfig.DEFAULT_CHAIN || 'solana');
          const hasKeypair = Boolean(getTradingKeypair());
          if (!hasKeypair) {
            if (!liveWallet || !liveWallet.is_connected || !liveWallet.address) {
              return res.status(400).json({
                error: 'Cannot start Live mode: Connect your Phantom wallet first.',
              });
            }
            if (liveWallet.is_read_only || !liveWallet.signing_available) {
              return res.status(400).json({
                error: `Cannot start Live mode: Connected wallet (${liveWallet.name}) is Read-Only.`,
              });
            }
          }
          if (liveWallet && liveWallet.is_connected) {
            const bal = parseFloat(liveWallet.native_balance) || 0;
            if (bal <= botConfig.MIN_GAS_RESERVE_SOL) {
              return res.status(400).json({
                error: `Cannot start Live mode: Insufficient SOL balance (${bal.toFixed(4)} SOL). Keep above ${botConfig.MIN_GAS_RESERVE_SOL} SOL gas reserve.`,
              });
            }
          }
        }
        startBotEngine();
        break;
      }
      case 'stop_bot': {
        stopBotEngine();
        break;
      }
      case 'scan_once': {
        const prev = currentLifecycleState;
        currentLifecycleState = 'RUNNING';
        try {
          await scanAndBuy();
        } finally {
          currentLifecycleState = prev;
        }
        break;
      }
      case 'probe': {
        const lines = await runProbeDiagnostic();
        return res.json({ success: true, lines });
      }
      case 'reset_account': {
        if (currentLifecycleState === 'RUNNING') {
          return res.status(400).json({ error: "Stop the bot first: press 'Stop bot', then reset the paper account." });
        }
        const resetBalUsd =
          botConfig.sizing_basis === 'sol' && (botConfig.start_balance_sol ?? 0) > 0
            ? botConfig.start_balance_sol * (cachedSolPrice.price || 145)
            : botConfig.start_balance_usd;
        ledgers.paper = createEmptyLedger(resetBalUsd);
        ledgers.testnet = createEmptyLedger(resetBalUsd);
        livePrices.clear();
        try {
          if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
          if (fs.existsSync(TRADES_LOG_FILE)) fs.unlinkSync(TRADES_LOG_FILE);
          if (fs.existsSync(TRADES_LOG_PUBLIC)) fs.unlinkSync(TRADES_LOG_PUBLIC);
        } catch {}
        ensureTradesLogFile();
        saveStateToDisk();
        sniperLog('Paper account reset.', 'info', 'ACCOUNT_RESET');
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    res.json({ success: true, status: botStatus, lifecycle_state: currentLifecycleState });
  });

  app.post('/api/probe', async (_req, res) => {
    const lines = await runProbeDiagnostic();
    res.json({ success: true, lines });
  });

  app.post('/api/account/reset', (_req, res) => {
    if (currentLifecycleState === 'RUNNING') {
      return res.status(400).json({ error: "Stop the bot first: press 'Stop bot', then reset the paper account." });
    }
    const resetBalUsd =
      botConfig.sizing_basis === 'sol' && (botConfig.start_balance_sol ?? 0) > 0
        ? botConfig.start_balance_sol * (cachedSolPrice.price || 145)
        : botConfig.start_balance_usd;
    ledgers.paper = createEmptyLedger(resetBalUsd);
    ledgers.testnet = createEmptyLedger(resetBalUsd);
    livePrices.clear();
    try {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
      if (fs.existsSync(TRADES_LOG_FILE)) fs.unlinkSync(TRADES_LOG_FILE);
      if (fs.existsSync(TRADES_LOG_PUBLIC)) fs.unlinkSync(TRADES_LOG_PUBLIC);
    } catch {}
    ensureTradesLogFile();
    saveStateToDisk();
    sniperLog('Paper account reset.', 'info', 'ACCOUNT_RESET');
    res.json({ success: true });
  });

  // ---------------- PRESERVED LIVE WALLET & SIGNER ROUTES ----------------
  app.get('/api/wallets', (req, res) => {
    const mode = ((req.query.mode as ExecutionMode) || botConfig.EXECUTION_MODE) as ExecutionMode;
    const chain = (req.query.chain as string) || 'all';
    res.json(resolveWalletsForMode(mode, chain));
  });

  app.get('/api/wallets/balance', async (req, res) => {
    const chain = ((req.query.chain as string) || 'solana').toLowerCase();
    const address = (req.query.address as string) || '';
    if (!address) return res.status(400).json({ error: 'Wallet address required' });
    try {
      res.json(await queryOnChainBalance(chain, address));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to query blockchain RPC' });
    }
  });

  app.get('/api/wallets/diagnostics', async (req, res) => {
    const chain = (req.query.chain as string) || 'solana';
    const live = getLiveConnectedWallet(chain);
    const mode = botConfig.EXECUTION_MODE;
    const solPrice = await getSolPriceUsd();
    const tradeSol =
      botConfig.sizing_basis === 'sol' && (botConfig.trade_size_sol ?? 0) > 0
        ? botConfig.trade_size_sol
        : botConfig.trade_size_usd / solPrice;
    const minGasReserve = botConfig.MIN_GAS_RESERVE_SOL;
    const minRequired = tradeSol + minGasReserve;
    const currentBal = live ? live.raw_balance_num : 0;

    let readinessStatus = 'READY_PAPER';
    let readinessReason = `Running in ${mode.toUpperCase()} mode. Simulated account active.`;

    if (mode === 'live') {
      if (!live || !live.is_connected || !live.address) {
        readinessStatus = 'DISCONNECTED';
        readinessReason = 'No verified live wallet connected for SOLANA. Connect Phantom or Solflare.';
      } else if (live.is_read_only || !live.signing_available) {
        readinessStatus = 'READ_ONLY';
        readinessReason = `Connected wallet (${live.name}) is Read-Only.`;
      } else if (currentBal < minRequired) {
        readinessStatus = 'INSUFFICIENT_FUNDS';
        readinessReason = `On-chain balance (${currentBal.toFixed(5)} SOL) is below trade size (~${tradeSol.toFixed(4)} SOL) + gas reserve (${minGasReserve} SOL).`;
      } else {
        readinessStatus = 'LIVE_READY';
        readinessReason = `Verified on-chain balance (${currentBal.toFixed(5)} SOL) ready for live sniper execution.`;
      }
    }

    res.json({
      mode,
      chain,
      is_live: mode === 'live',
      wallet: live,
      readiness: {
        status: readinessStatus,
        is_ready: readinessStatus === 'LIVE_READY' || readinessStatus === 'READY_PAPER',
        reason: readinessReason,
        current_balance: currentBal,
        min_required_balance: minRequired,
        trade_size: tradeSol,
        gas_reserve: minGasReserve,
      },
      server_time: Date.now(),
    });
  });

  app.post('/api/wallets/connect', (req, res) => {
    const { chain, address, name, wallet_id, type, native_balance, balance_usd, signing_available, network } = req.body;
    if (!chain || !address) return res.status(400).json({ error: 'chain and address required' });
    if (wallet_id && WALLET_FEE_SCHEDULES[wallet_id]) activeWalletProvider = wallet_id;
    else if (name?.toLowerCase().includes('phantom')) activeWalletProvider = 'phantom';
    else if (name?.toLowerCase().includes('solflare')) activeWalletProvider = 'solflare';

    registerLiveWallet(
      chain,
      address,
      name || 'Solana Wallet',
      native_balance || '0.00 SOL',
      balance_usd || '$0.00',
      type || 'solana',
      signing_available !== false,
      network || 'Solana Mainnet-Beta'
    );

    res.json({
      success: true,
      wallet: getLiveConnectedWallet(chain),
      applied_fee_schedule: WALLET_FEE_SCHEDULES[activeWalletProvider],
    });
  });

  app.get('/api/wallets/fee-schedules', (_req, res) => {
    res.json({
      active_wallet: activeWalletProvider,
      active_schedule: WALLET_FEE_SCHEDULES[activeWalletProvider] || WALLET_FEE_SCHEDULES.paper,
      schedules: WALLET_FEE_SCHEDULES,
    });
  });

  app.post('/api/wallets/disconnect', (req, res) => {
    const { chain } = req.body || {};
    if (!chain) return res.status(400).json({ error: 'chain required' });
    disconnectLiveWallet(chain);
    res.json({ success: true });
  });

  app.get('/api/trading-signer', async (_req, res) => {
    try {
      res.json(await getTradingSignerStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/trading-signer', async (req, res) => {
    const { secretKey } = req.body || {};
    if (!secretKey) return res.status(400).json({ error: 'secretKey is required' });
    const result = setTradingKeypair(secretKey);
    if (!result.success) return res.status(400).json({ error: result.error });

    if (result.address) {
      const bal = await queryOnChainBalance('solana', result.address);
      registerLiveWallet(
        'solana',
        result.address,
        'Solana Trading Keypair',
        bal.formatted_balance,
        bal.formatted_usd,
        'keypair',
        true,
        'Solana Mainnet-Beta',
        bal.rpc_endpoint
      );
    }
    res.json({ success: true, signer: await getTradingSignerStatus() });
  });

  app.delete('/api/trading-signer', (_req, res) => {
    clearTradingKeypair();
    disconnectLiveWallet('solana');
    res.json({ success: true, message: 'Trading signer cleared' });
  });

  app.post('/api/live-tx/:id/complete', (req, res) => {
    const id = req.params.id;
    const entry = pendingBrowserTxs.get(id);
    if (!entry) {
      return res.status(404).json({ error: 'Pending transaction expired or not found.' });
    }
    pendingBrowserTxs.delete(id);
    clearTimeout(entry.timer);
    const { signature, error } = req.body || {};
    entry.resolve({ signature, error });
    res.json({ success: true });
  });

  // ---------------- CSV EXPORT ----------------
  app.get('/api/export/trades_log.csv', (_req, res) => {
    ensureTradesLogFile();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="trades_log.csv"');
    res.sendFile(TRADES_LOG_FILE);
  });

  app.get('/trades_log.csv', (_req, res) => {
    ensureTradesLogFile();
    res.setHeader('Content-Type', 'text/csv');
    res.sendFile(TRADES_LOG_FILE);
  });

  // ---------------- VITE MIDDLEWARE / SPA ----------------
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`◈ Solana Launch Sniper running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal startup error in server.ts:', err);
  process.exit(1);
});
