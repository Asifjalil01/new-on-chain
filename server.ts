import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PublicKey } from '@solana/web3.js';
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
  findExternalSellOnChain,
  getSolanaRpcEndpoints,
  fetchSplMintDecimals,
  fetchJupiterQuote,
  checkPendingSignatureStatus,
  parseVerifiedTransactionMetrics,
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
  // Core Capital & Risk
  start_balance_usd: number;
  start_balance_sol: number;
  trade_size_usd: number;
  trade_size_sol: number;
  max_open_positions: number;
  max_wallet_exposure_sol: number;
  daily_loss_limit_usd: number;
  daily_loss_limit_sol: number;
  sizing_basis: 'sol' | 'usd';
  take_profit_pct: number;
  trailing_stop_pct: number;
  stop_loss_pct: number;
  rug_exit_drop_pct: number;
  max_hold_minutes: number;
  // Sniper window
  min_age_minutes: number;
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
  max_open_positions: 2,
  max_wallet_exposure_sol: 0.1,
  daily_loss_limit_usd: 10.0,
  daily_loss_limit_sol: 0.07,
  sizing_basis: 'sol',
  take_profit_pct: 35.0,
  trailing_stop_pct: 10.0,
  stop_loss_pct: 20.0,
  rug_exit_drop_pct: 75.0,
  max_hold_minutes: 60,
  min_age_minutes: 0,
  max_age_minutes: 720,
  ultra_early_grace_sec: 10,
  scan_interval_sec: 1,
  monitor_interval_sec: 1.0,
  min_liquidity_usd: 1000.0,
  min_buys_m5: 4,
  min_buy_sell_ratio_m5: 1.5,
  max_price_change_m5_pct: 150.0,
  min_volume_m5_usd: 100.0,
  min_holders: 20,
  use_rugcheck: true,
  strict_rugcheck: true,
  rugcheck_max_score: 30.0,
  max_top10_holder_pct: 35.0,
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
  max_wallet_exposure_sol: [0.001, 100],
  daily_loss_limit_usd: [0, 1e7],
  daily_loss_limit_sol: [0, 1e6],
  take_profit_pct: [0, 1e5],
  trailing_stop_pct: [0, 1000],
  stop_loss_pct: [0, 20],
  rug_exit_drop_pct: [0, 99.9],
  max_hold_minutes: [1, 1e5],
  min_age_minutes: [1, 1440],
  max_age_minutes: [1, 10080],
  ultra_early_grace_sec: [0, 0],
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
const SIGNER_FILE = path.resolve(__dirname, '.sniper_signer.key');
const TRADES_LOG_FILE = path.resolve(__dirname, 'trades_log.csv');
const TRADES_LOG_PUBLIC = path.resolve(__dirname, 'public', 'trades_log.csv');
const ENV_FILE = path.resolve(__dirname, '.env');

export let botConfig: SniperConfig = { ...DEFAULT_CONFIG };
let cachedApiToken = '';
let encryptedSignerOnDisk = false;

export function ensureApiToken(): string {
  if (cachedApiToken) return cachedApiToken;
  const fromEnv = (process.env.API_TOKEN || '').trim();
  if (fromEnv && fromEnv.length >= 16) {
    cachedApiToken = fromEnv;
    return cachedApiToken;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  cachedApiToken = generated;
  process.env.API_TOKEN = generated;
  try {
    let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
    if (/^API_TOKEN=.*$/m.test(content)) {
      content = content.replace(/^API_TOKEN=.*$/m, `API_TOKEN=${generated}`);
    } else {
      content = content + (content && !content.endsWith('\n') ? '\n' : '') + `API_TOKEN=${generated}\n`;
    }
    fs.writeFileSync(ENV_FILE, content, { encoding: 'utf-8', mode: 0o600 });
  } catch (err: any) {
    console.warn('[SECURITY] Could not persist API_TOKEN to .env:', err?.message);
  }
  return cachedApiToken;
}

// ---------------- ENDPOINTS ----------------
const DEX = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const JUP = 'https://api.jup.ag/tokens/v2';
const JUP_PRICE = 'https://api.jup.ag/price/v3';
const RUGC = 'https://api.rugcheck.xyz/v1/tokens';
const PUMPP = 'https://api.pumpportal.fun/api/data';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
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

let _jupRateLimitUntil = 0;
let _swapPriorityUntil = 0;
const _jupTokenCache = new Map<string, { tok: any; ts: number }>();

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
    if (!resp.ok) {
      if (resp.status === 429 && target.includes('jup.ag')) {
        const ra = Number(resp.headers.get('retry-after') || 0);
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(15_000, ra * 1000) : 8000;
        _jupRateLimitUntil = Math.max(_jupRateLimitUntil, Date.now() + waitMs);
      }
      return null;
    }
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
export interface PositionExitParams {
  take_profit_pct: number;
  stop_loss_pct: number;
  trailing_stop_pct: number;
  rug_exit_drop_pct: number;
  max_hold_minutes: number;
}

export interface SniperPosition {
  trade_id?: string;
  mint: string;
  symbol: string;
  qty: number;
  entry_price: number;
  cost: number;
  cost_sol?: number;
  buy_base_fee_sol?: number;
  buy_priority_fee_sol?: number;
  buy_rent_paid_sol?: number;
  exit_params?: PositionExitParams;
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
  first_unsellable_at?: number;
  next_sell_retry_at?: number;
  zero_bal_checks?: number;
  needs_review?: boolean;
  needs_review_reason?: string;
  last_liquidity_usd?: number;
}

export interface PendingBuyRecord {
  mint: string;
  symbol: string;
  signature: string;
  userPublicKey: string;
  mode: ExecutionMode;
  trade_id: string;
  startedAt: number;
  expiresAt: number;
  tradeSol: number;
  tradeUsd: number;
  solPriceUsd: number | null;
  estTokensOut?: number;
  url: string;
  dex: string;
  source: string;
  age_s: number;
  decimals?: number;
  exit_params: PositionExitParams;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
}

export interface SniperTradeRow {
  id: string;
  trade_id: string;
  mode: ExecutionMode;
  time: string;
  action: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  price: number;
  usd: number;
  sol_amount?: number;
  sol_spent?: number | null;
  sol_received?: number | null;
  base_fee_sol?: number | null;
  priority_fee_sol?: number | null;
  rent_paid_sol?: number | null;
  pnl_usd: number | null;
  pnl_sol?: number | null;
  net_pnl_sol?: number | null;
  net_pnl_usd?: number | null;
  pnl_pct: number | null;
  estimated?: boolean;
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
  attempted_mints: string[];
  pending_buys: PendingBuyRecord[];
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
    attempted_mints: [],
    pending_buys: [],
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
export const CSV_HEADER =
  'trade_id,time,action,symbol,mint,price,usd,sol_spent,sol_received,base_fee_sol,priority_fee_sol,rent_paid_sol,net_pnl_sol,net_pnl_usd,pnl_pct,estimated,reason,dexscreener,age_s,dex,source,mode,tx_hash\n';

function csvEscape(v: any): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatTradeCsvLine(row: SniperTradeRow): string {
  const tradeId = row.trade_id || row.id;
  const solSpent =
    row.sol_spent !== undefined && row.sol_spent !== null
      ? row.sol_spent.toFixed(6)
      : row.action === 'BUY' && row.sol_amount !== undefined
      ? row.sol_amount.toFixed(6)
      : '';
  const solReceived =
    row.sol_received !== undefined && row.sol_received !== null
      ? row.sol_received.toFixed(6)
      : row.action === 'SELL' && row.sol_amount !== undefined
      ? row.sol_amount.toFixed(6)
      : '';
  const baseFee = row.base_fee_sol !== undefined && row.base_fee_sol !== null ? row.base_fee_sol.toFixed(8) : '';
  const prioFee = row.priority_fee_sol !== undefined && row.priority_fee_sol !== null ? row.priority_fee_sol.toFixed(8) : '';
  const rentPaid = row.rent_paid_sol !== undefined && row.rent_paid_sol !== null ? row.rent_paid_sol.toFixed(8) : '';
  const netPnlSol =
    row.net_pnl_sol !== undefined && row.net_pnl_sol !== null
      ? row.net_pnl_sol.toFixed(6)
      : row.pnl_sol !== undefined && row.pnl_sol !== null
      ? row.pnl_sol.toFixed(6)
      : '';
  const netPnlUsd =
    row.net_pnl_usd !== undefined && row.net_pnl_usd !== null
      ? row.net_pnl_usd.toFixed(4)
      : row.pnl_usd !== null
      ? row.pnl_usd.toFixed(4)
      : '';

  return [
    tradeId,
    row.time,
    row.action,
    row.symbol,
    row.mint,
    fmtPrice(row.price),
    row.usd.toFixed(4),
    solSpent,
    solReceived,
    baseFee,
    prioFee,
    rentPaid,
    netPnlSol,
    netPnlUsd,
    row.pnl_pct !== null ? row.pnl_pct.toFixed(2) : '',
    row.estimated ? 'true' : 'false',
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
}

function archiveOldCsvIfExists(targetPath: string, suffixTag: string): string | null {
  try {
    if (!fs.existsSync(targetPath)) return null;
    const archivePath = path.resolve(path.dirname(targetPath), `trades_log.old-${suffixTag}.csv`);
    fs.renameSync(targetPath, archivePath);
    return archivePath;
  } catch {
    return null;
  }
}

export function ensureTradesLogFile(
  logFilePath = TRADES_LOG_FILE,
  publicLogPath = TRADES_LOG_PUBLIC
) {
  try {
    const pubDir = path.dirname(publicLogPath);
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });

    if (fs.existsSync(logFilePath)) {
      const content = fs.readFileSync(logFilePath, 'utf-8');
      const firstLine = content.split(/\r?\n/)[0]?.trim() || '';
      if (firstLine !== CSV_HEADER.trim()) {
        const ts = Date.now();
        archiveOldCsvIfExists(logFilePath, String(ts));
        if (fs.existsSync(publicLogPath)) {
          try {
            fs.unlinkSync(publicLogPath);
          } catch {}
        }
      }
    }

    if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, CSV_HEADER, 'utf-8');
    if (!fs.existsSync(publicLogPath)) fs.writeFileSync(publicLogPath, CSV_HEADER, 'utf-8');
  } catch (err: any) {
    console.error('Error ensuring trades_log.csv:', err.message);
  }
}

function appendTradeCsv(row: SniperTradeRow) {
  try {
    ensureTradesLogFile();
    const line = formatTradeCsvLine(row);
    fs.appendFileSync(TRADES_LOG_FILE, line + '\n', 'utf-8');
    fs.appendFileSync(TRADES_LOG_PUBLIC, line + '\n', 'utf-8');
  } catch (err: any) {
    console.error('Error writing trades_log.csv:', err.message);
  }
}

export function rewriteCsvWithLiveTrades(
  logFilePath = TRADES_LOG_FILE,
  publicLogPath = TRADES_LOG_PUBLIC
) {
  try {
    const pubDir = path.dirname(publicLogPath);
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
    const ts = Date.now();
    archiveOldCsvIfExists(logFilePath, String(ts));
    if (fs.existsSync(publicLogPath)) {
      try {
        fs.unlinkSync(publicLogPath);
      } catch {}
    }
    const liveChronological = [...(ledgers.live.trades || [])].reverse();
    const body = liveChronological.map(formatTradeCsvLine).join('\n');
    const full = CSV_HEADER + (body ? body + '\n' : '');
    fs.writeFileSync(logFilePath, full, 'utf-8');
    fs.writeFileSync(publicLogPath, full, 'utf-8');
  } catch (err: any) {
    console.error('Error rewriting trades_log.csv with live trades:', err.message);
  }
}

// ---------------- PERSISTENCE ----------------
function loadSettingsFromDisk() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      // Always start in PAPER mode for safety on boot
      const { EXECUTION_MODE: _ignored, ...rest } = raw || {};
      const merged: SniperConfig = { ...DEFAULT_CONFIG, ...rest, EXECUTION_MODE: 'paper' };
      merged.ultra_early_grace_sec = 0;
      if (merged.stop_loss_pct > 20) merged.stop_loss_pct = 20;
      if (merged.stop_loss_pct > 0 && merged.take_profit_pct < merged.stop_loss_pct * 1.5) {
        merged.take_profit_pct = Number((merged.stop_loss_pct * 1.5).toFixed(2));
      }
      if (rest?.min_age_minutes === undefined) {
        merged.min_age_minutes = DEFAULT_CONFIG.min_age_minutes;
      }
      if (merged.max_age_minutes < merged.min_age_minutes) {
        merged.max_age_minutes = Math.max(DEFAULT_CONFIG.max_age_minutes, merged.min_age_minutes);
      }
      if (rest?.min_liquidity_usd === undefined || Number(merged.min_liquidity_usd) < DEFAULT_CONFIG.min_liquidity_usd) {
        if (rest?.min_liquidity_usd !== undefined && Number(rest.min_liquidity_usd) === 300) {
          merged.min_liquidity_usd = DEFAULT_CONFIG.min_liquidity_usd;
        }
      }
      const refSol = cachedSolPrice.price;
      if (refSol && refSol > 0) {
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
            attempted_mints: parsed[m].attempted_mints || [],
            pending_buys: parsed[m].pending_buys || [],
            trades: parsed[m].trades || [],
          };
        }
      }
    }
  } catch {}
}

export function saveStateToDisk() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ledgers, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

interface EncryptedSignerPayload {
  version: 1;
  alg: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function encryptSignerPayload(secretKey: string, passphrase: string): EncryptedSignerPayload {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(secretKey.trim(), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: enc.toString('hex'),
  };
}

function decryptSignerPayload(payload: EncryptedSignerPayload, passphrase: string): string | null {
  try {
    const salt = Buffer.from(payload.salt, 'hex');
    const iv = Buffer.from(payload.iv, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');
    const ciphertext = Buffer.from(payload.ciphertext, 'hex');
    const key = crypto.scryptSync(passphrase, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString('utf-8').trim();
  } catch {
    return null;
  }
}

function saveEncryptedSignerToDisk(secretKey: string, passphrase: string) {
  const payload = encryptSignerPayload(secretKey, passphrase);
  const tmp = SIGNER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, SIGNER_FILE);
  encryptedSignerOnDisk = true;
}

function auditAndLoadSignerDiskState() {
  try {
    if (!fs.existsSync(SIGNER_FILE)) {
      encryptedSignerOnDisk = false;
      return;
    }
    const raw = fs.readFileSync(SIGNER_FILE, 'utf-8').trim();
    if (!raw) {
      fs.unlinkSync(SIGNER_FILE);
      encryptedSignerOnDisk = false;
      return;
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.version === 1 &&
      parsed.alg === 'aes-256-gcm' &&
      parsed.ciphertext &&
      parsed.iv &&
      parsed.salt &&
      parsed.tag
    ) {
      encryptedSignerOnDisk = true;
      console.log('[SECURITY] Encrypted .sniper_signer.key detected on disk (unlock with passphrase in Wallets tab or via POST /api/trading-signer/unlock).');
    } else {
      fs.unlinkSync(SIGNER_FILE);
      encryptedSignerOnDisk = false;
      console.warn(
        '[SECURITY] WARNING: Found unencrypted plain-text .sniper_signer.key on disk and deleted it. Re-import your key with an encryption passphrase or set SOLANA_PRIVATE_KEY in .env.'
      );
      sniperLog(
        '[SECURITY] WARNING: Deleted unencrypted .sniper_signer.key on startup. Import signer with passphrase or SOLANA_PRIVATE_KEY env var.',
        'warn',
        'SECURITY_WARNING'
      );
    }
  } catch {}
}

function clearSignerFromDisk() {
  try {
    if (fs.existsSync(SIGNER_FILE)) fs.unlinkSync(SIGNER_FILE);
  } catch {}
  encryptedSignerOnDisk = false;
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
    const endpoints = getSolanaRpcEndpoints();
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
    const usdVal = solPrice && solPrice > 0 ? solBalance * solPrice : 0;
    return {
      success: true,
      chain: 'solana',
      address,
      native_balance: solBalance,
      formatted_balance: `${solBalance.toFixed(5)} SOL`,
      native_symbol: 'SOL',
      balance_usd: usdVal,
      formatted_usd: solPrice && solPrice > 0 ? `$${usdVal.toFixed(2)}` : 'price unavailable',
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

let cachedSolPrice: { price: number | null; updatedAt: number } = { price: null, updatedAt: 0 };
async function getSolPriceUsd(): Promise<number | null> {
  if (cachedSolPrice.price !== null && Date.now() - cachedSolPrice.updatedAt < 15_000) {
    return cachedSolPrice.price;
  }
  try {
    const hdrs = botConfig.jupiter_api_key ? { 'x-api-key': botConfig.jupiter_api_key } : undefined;
    const jup = await getJson(JUP_PRICE, { ids: WSOL_MINT }, 3500, hdrs);
    const p = _f(jup?.[WSOL_MINT]?.usdPrice);
    if (p && p > 1) {
      cachedSolPrice = { price: p, updatedAt: Date.now() };
      return p;
    }
  } catch {}
  try {
    const ds = await getJson(`${DEX}/latest/dex/tokens/${WSOL_MINT}`, undefined, 3500);
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

interface LateBrowserTxContext {
  action: 'BUY' | 'SELL';
  symbol: string;
  mint: string;
  userPublicKey: string;
  tradeSol: number;
  tradeUsd: number;
  solPriceUsd: number | null;
  estTokensOut?: number;
  url: string;
  dex: string;
  source: string;
  age_s: number;
  decimals?: number;
  exit_params: PositionExitParams;
  trade_id: string;
  expiresAt: number;
}

const pendingBrowserTxs = new Map<
  string,
  {
    resolve: (res: { signature?: string; error?: string; timedOut?: boolean }) => void;
    timer: NodeJS.Timeout;
    context: LateBrowserTxContext;
  }
>();

const lateBrowserTxs = new Map<string, LateBrowserTxContext>();

function requestBrowserWalletSignature(
  payload: {
    action: 'BUY' | 'SELL';
    symbol: string;
    mint: string;
    base64Tx: string;
    userPublicKey: string;
  },
  context: Omit<LateBrowserTxContext, 'expiresAt'>
): Promise<{ signature?: string; error?: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullCtx: LateBrowserTxContext = {
      ...context,
      expiresAt: Date.now() + 600_000,
    };
    const timer = setTimeout(() => {
      pendingBrowserTxs.delete(id);
      lateBrowserTxs.set(id, fullCtx);
      resolve({ error: 'Phantom wallet confirmation timed out (65s).', timedOut: true });
    }, 65_000);
    pendingBrowserTxs.set(id, { resolve, timer, context: fullCtx });
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

let _geckoCooldownUntil = 0;

async function _srcGecko(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_gecko) return [];
  if (Date.now() < _geckoCooldownUntil) return [];
  const out: string[] = [];
  const data = await getJson(GECKO, { page: 1 }, 6000);
  if (!data || !Array.isArray(data.data)) {
    _geckoCooldownUntil = Date.now() + 20_000;
    return [];
  }
  for (const pool of data.data) {
    const tid = pool?.relationships?.base_token?.data?.id || '';
    if (typeof tid === 'string' && tid.startsWith('solana_')) {
      const mint = tid.slice('solana_'.length);
      if (mint && mint.length > 20) out.push(mint);
    }
  }
  return out;
}

async function _srcJup(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_jupiter_recent) return [];
  if (Date.now() < _jupRateLimitUntil || Date.now() < _swapPriorityUntil) return [];
  const hdrs = cfg.jupiter_api_key ? { 'x-api-key': cfg.jupiter_api_key } : undefined;
  const data = await getJson(`${JUP}/recent`, undefined, 6000, hdrs);
  const items = Array.isArray(data) ? data : data?.tokens || data?.data || [];
  if (!Array.isArray(items)) return [];
  const now = Date.now();
  const ids: string[] = [];
  for (const t of items) {
    if (t && typeof t.id === 'string' && t.id.length > 0) {
      _jupTokenCache.set(t.id, { tok: t, ts: now });
      ids.push(t.id);
    }
  }
  if (_jupTokenCache.size > 1000) _jupTokenCache.clear();
  return ids;
}

async function _srcProfiles(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_dex_profiles) return [];
  const data = await getJson(`${DEX}/token-profiles/latest/v1`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((d: any) => d && d.chainId === 'solana' && typeof d.tokenAddress === 'string')
    .map((d: any) => d.tokenAddress);
}

const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
let _pumpWs: any = null;
let _pumpWsLastRetry = 0;
const _pumpPortalBuffer: Array<{ mint: string; ts: number }> = [];

function ensurePumpPortalStream() {
  const WS = (globalThis as any).WebSocket;
  if (!WS) return;
  if (_pumpWs && (_pumpWs.readyState === 0 || _pumpWs.readyState === 1)) return;
  if (Date.now() - _pumpWsLastRetry < 5000) return;
  _pumpWsLastRetry = Date.now();

  try {
    const ws = new WS(PUMPPORTAL_WS_URL);
    _pumpWs = ws;
    const onOpen = () => {
      try {
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      } catch {}
    };
    const onMessage = (evt: any) => {
      try {
        const raw = typeof evt?.data === 'string' ? evt.data : String(evt?.data || '');
        const msg = JSON.parse(raw);
        const mint = msg?.mint;
        if (typeof mint === 'string' && mint.length >= 32) {
          const now = Date.now();
          if (!_pumpPortalBuffer.some((x) => x.mint === mint)) {
            _pumpPortalBuffer.unshift({ mint, ts: now });
            if (_pumpPortalBuffer.length > 200) _pumpPortalBuffer.length = 200;
          }
        }
      } catch {}
    };
    const onCloseOrErr = () => {
      if (_pumpWs === ws) _pumpWs = null;
    };
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onCloseOrErr);
      ws.addEventListener('error', onCloseOrErr);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = onMessage;
      ws.onclose = onCloseOrErr;
      ws.onerror = onCloseOrErr;
    }
  } catch {
    _pumpWs = null;
  }
}

function stopPumpPortalStream() {
  try {
    if (_pumpWs && typeof _pumpWs.close === 'function') _pumpWs.close();
  } catch {}
  _pumpWs = null;
}

async function _srcPumpPortal(cfg: SniperConfig, waitOnFirstConnect = false): Promise<string[]> {
  if (!cfg.use_pumpportal) {
    stopPumpPortalStream();
    return [];
  }
  const hadSocket = Boolean(_pumpWs);
  ensurePumpPortalStream();
  if (waitOnFirstConnect && !hadSocket && _pumpPortalBuffer.length === 0) {
    await new Promise((r) => setTimeout(r, 2200));
  }
  const cutoff = Date.now() - 180_000;
  while (_pumpPortalBuffer.length > 0 && _pumpPortalBuffer[_pumpPortalBuffer.length - 1].ts < cutoff) {
    _pumpPortalBuffer.pop();
  }
  return _pumpPortalBuffer.map((x) => x.mint);
}

async function _srcBoosts(cfg: SniperConfig): Promise<string[]> {
  if (!cfg.use_promoted_feeds) return [];
  const data = await getJson(`${DEX}/token-boosts/latest/v1`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((d: any) => d && d.chainId === 'solana' && typeof d.tokenAddress === 'string')
    .map((d: any) => d.tokenAddress);
}

const SOURCES: Array<[string, number, (cfg: SniperConfig, force?: boolean) => Promise<string[]>]> = [
  ['gecko', 10000, _srcGecko],
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
        const res = (await fn(cfg, force)) || [];
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

// ---------------- JUPITER TOKENS V2 MARKET CHECKER ----------------
function jupTokenToSnapshot(tok: any): any | null {
  if (!tok || typeof tok.id !== 'string') return null;
  const createdIso = tok.firstPool?.createdAt || tok.createdAt || '';
  const createdMs = createdIso ? Date.parse(createdIso) : 0;
  const stats5m = tok.stats5m || {};
  const stats1h = tok.stats1h || {};
  const buyVol = _f(stats5m.buyVolume) || 0;
  const sellVol = _f(stats5m.sellVolume) || 0;
  return {
    baseToken: {
      address: tok.id,
      symbol: tok.symbol || tok.name || '?',
      decimals: typeof tok.decimals === 'number' ? tok.decimals : 6,
    },
    dexId: tok.launchpad || (Array.isArray(tok.tags) && tok.tags[0]) || 'jupiter',
    pairCreatedAt: Number.isFinite(createdMs) ? createdMs : 0,
    priceUsd: tok.usdPrice ?? null,
    liquidity: { usd: _f(tok.liquidity) ?? 0 },
    txns: {
      m5: {
        buys: Number(stats5m.numBuys || 0),
        sells: Number(stats5m.numSells || 0),
      },
      h1: {
        buys: Number(stats1h.numBuys ?? stats5m.numBuys ?? 0),
        sells: Number(stats1h.numSells ?? stats5m.numSells ?? 0),
      },
    },
    priceChange: { m5: _f(stats5m.priceChange) },
    volume: { m5: buyVol + sellVol },
    holderCount: _f(tok.holderCount),
    url: `https://dexscreener.com/solana/${tok.id}`,
  };
}

async function fetchJupiterPairSnapshots(
  mints: string[],
  cfg: SniperConfig,
  opts: { priority?: boolean; bypassCache?: boolean } = {}
): Promise<any[]> {
  if (mints.length === 0) return [];
  const now = Date.now();
  const out: any[] = [];
  const uncached: string[] = [];

  for (const m of mints) {
    const hit = !opts.bypassCache ? _jupTokenCache.get(m) : undefined;
    if (hit && now - hit.ts < 10_000) {
      const snap = jupTokenToSnapshot(hit.tok);
      if (snap) out.push(snap);
    } else {
      uncached.push(m);
    }
  }

  if (uncached.length === 0) return out;
  if (!opts.priority && (now < _jupRateLimitUntil || now < _swapPriorityUntil)) {
    return out;
  }

  const hdrs = cfg.jupiter_api_key ? { 'x-api-key': cfg.jupiter_api_key } : undefined;
  for (let i = 0; i < uncached.length; i += 30) {
    const chunk = uncached.slice(i, i + 30);
    const data = await getJson(`${JUP}/search`, { query: chunk.join(',') }, 6000, hdrs);
    const items = Array.isArray(data) ? data : data?.tokens || data?.data || [];
    if (!Array.isArray(items)) continue;
    const fetchedAt = Date.now();
    for (const tok of items) {
      if (tok && typeof tok.id === 'string') {
        _jupTokenCache.set(tok.id, { tok, ts: fetchedAt });
      }
      const snap = jupTokenToSnapshot(tok);
      if (snap) out.push(snap);
    }
  }
  return out;
}

// ---------------- ENTRY FILTERS (AGE & LIQUIDITY ENFORCED AT ALL AGES) ----------------
export function passesFilters(pair: any, cfg: SniperConfig, nowMs = Date.now()): [boolean, string, string] {
  const created = Number(pair?.pairCreatedAt || 0);
  if (created <= 0) return [false, 'missing data', 'no pairCreatedAt'];
  const ageS = (nowMs - created) / 1000.0;
  if (ageS < -10) return [false, 'clock skew', 'sync system clock'];

  const minAgeMin = cfg.min_age_minutes ?? 30;
  const maxAgeMin = cfg.max_age_minutes ?? 720;
  if (ageS < minAgeMin * 60) {
    return [false, 'too young', `${(ageS / 60).toFixed(1)}m < ${minAgeMin}m min`];
  }
  if (ageS > maxAgeMin * 60) {
    return [false, 'too old', `${(ageS / 60).toFixed(1)}m > ${maxAgeMin}m max`];
  }
  if (_f(pair?.priceUsd) === null) return [false, 'no price', 'no price on Jupiter yet'];

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
  if (m5c !== null && m5c > (cfg.max_price_change_m5_pct ?? 150)) {
    return [false, 'already pumped', `+${m5c.toFixed(0)}% in 5m`];
  }
  if (m5c !== null && m5c <= -35) {
    return [false, 'already dumping', `${m5c.toFixed(0)}% in 5m`];
  }

  if ((cfg.min_holders ?? 0) > 0) {
    const hc = _f(pair?.holderCount);
    if (hc !== null) {
      if (hc < cfg.min_holders) {
        return [false, 'too few holders', `${hc} < ${cfg.min_holders}`];
      }
    } else {
      const h1b = Number(pair?.txns?.h1?.buys || 0);
      if (h1b < cfg.min_holders) {
        return [false, 'too few h1 buys', `${h1b}`];
      }
    }
  }

  // Always enforce liquidity, buys, and volume floors at ALL ages (no ultra-early grace bypass)
  const minLiq = cfg.min_liquidity_usd ?? 25000;
  const liq = _f(pair?.liquidity?.usd) || 0.0;
  if (liq < minLiq) {
    return [false, 'low liquidity', `$${liq.toFixed(0)} < $${minLiq.toFixed(0)}`];
  }
  if (buys < (cfg.min_buys_m5 ?? 4)) {
    return [false, 'few buys', `${buys} buys in last 5m`];
  }
  if ((cfg.min_volume_m5_usd ?? 0) > 0) {
    const mv5 = _f(pair?.volume?.m5) || 0.0;
    if (mv5 < cfg.min_volume_m5_usd) {
      return [false, 'low m5 volume', `$${mv5.toFixed(0)}`];
    }
  }
  return [true, 'ok', ''];
}

// ---------------- FAIL-CLOSED HARD RUG SCREEN ----------------
const _rugCache = new Map<string, [number, [boolean, string]]>();

const KNOWN_POOL_OR_BURN_OWNERS = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium V4 Authority
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

async function rpcCall(method: string, params: any[], endpointUrl?: string, timeoutMs = 6000): Promise<any | null> {
  const urls = endpointUrl ? [endpointUrl] : getSolanaRpcEndpoints();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json && !json.error && json.result !== undefined) {
        return json.result;
      }
    } catch {}
  }
  return null;
}

async function rpcMintAuthorities(mint: string): Promise<[boolean, string | null, string | null]> {
  const res = await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const parsed = res?.value?.data?.parsed;
  if (parsed?.type === 'mint') {
    const inf = parsed.info || {};
    return [true, inf.mintAuthority || null, inf.freezeAuthority || null];
  }
  return [false, null, null];
}

async function getOnChainSplTokenBalanceOnEndpoint(
  ownerAddress: string,
  mint: string,
  endpointUrl: string
): Promise<{ ok: boolean; uiAmount: number }> {
  try {
    const res = await rpcCall(
      'getTokenAccountsByOwner',
      [ownerAddress, { mint }, { encoding: 'jsonParsed' }],
      endpointUrl,
      5000
    );
    if (!res || !Array.isArray(res.value)) return { ok: false, uiAmount: 0 };
    let total = 0;
    for (const acc of res.value) {
      const amt = Number(acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
      if (Number.isFinite(amt)) total += amt;
    }
    return { ok: true, uiAmount: total };
  } catch {
    return { ok: false, uiAmount: 0 };
  }
}

async function getOnChainSplTokenBalance(ownerAddress: string, mint: string): Promise<{ ok: boolean; uiAmount: number }> {
  for (const url of getSolanaRpcEndpoints()) {
    const r = await getOnChainSplTokenBalanceOnEndpoint(ownerAddress, mint, url);
    if (r.ok) return r;
  }
  return { ok: false, uiAmount: 0 };
}

/**
 * Fix 6: Require confirmed zero balance across TWO DIFFERENT RPC endpoints.
 */
export async function checkZeroBalanceAcrossTwoRpcs(
  ownerAddress: string,
  mint: string,
  balanceFetcher = getOnChainSplTokenBalanceOnEndpoint
): Promise<{ status: 'ZERO' | 'NON_ZERO' | 'INCONCLUSIVE' }> {
  const endpoints = getSolanaRpcEndpoints();
  if (endpoints.length < 2) {
    return { status: 'INCONCLUSIVE' };
  }
  const results = await Promise.all([
    balanceFetcher(ownerAddress, mint, endpoints[0]),
    balanceFetcher(ownerAddress, mint, endpoints[1]),
  ]);
  for (const r of results) {
    if (r.ok && r.uiAmount > 0.000001) {
      return { status: 'NON_ZERO' };
    }
  }
  if (results[0].ok && results[1].ok && results[0].uiAmount <= 0.000001 && results[1].uiAmount <= 0.000001) {
    return { status: 'ZERO' };
  }
  return { status: 'INCONCLUSIVE' };
}

export function isPoolOrPdaOwner(ownerAddr: string): boolean {
  if (!ownerAddr || KNOWN_POOL_OR_BURN_OWNERS.has(ownerAddr)) return true;
  try {
    const pk = new PublicKey(ownerAddr);
    return !PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

/**
 * Fix 2: On-chain holder check using getTokenSupply + getTokenLargestAccounts + getMultipleAccounts.
 * Rejects if RPC data is unavailable, if top-10 non-pool holders exceed maxTop10Pct (35%),
 * or if any single non-pool holder exceeds 10%.
 */
export async function checkOnChainHolders(
  mint: string,
  maxTop10Pct = 35,
  singleHolderMaxPct = 10,
  rpcFn = rpcCall
): Promise<[boolean, string]> {
  const [supplyRes, largestRes] = await Promise.all([
    rpcFn('getTokenSupply', [mint]),
    rpcFn('getTokenLargestAccounts', [mint]),
  ]);

  const totalUi = Number(supplyRes?.value?.uiAmountString || supplyRes?.value?.uiAmount || 0);
  const accounts = largestRes?.value;
  if (!supplyRes?.value || !Number.isFinite(totalUi) || totalUi <= 0 || !Array.isArray(accounts) || accounts.length === 0) {
    return [false, 'on-chain holder/supply RPC data unavailable (fail closed)'];
  }

  const topAddrs = accounts.slice(0, 20).map((a: any) => a?.address).filter(Boolean);
  const multiRes = await rpcFn('getMultipleAccounts', [topAddrs, { encoding: 'jsonParsed' }]);
  const multiVals = multiRes?.value;
  if (!Array.isArray(multiVals)) {
    return [false, 'on-chain token account owner lookup unavailable (fail closed)'];
  }

  const nonPoolPcts: number[] = [];
  for (let i = 0; i < Math.min(accounts.length, multiVals.length); i++) {
    const amt = Number(accounts[i]?.uiAmountString || accounts[i]?.uiAmount || 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const owner = multiVals[i]?.data?.parsed?.info?.owner;
    if (!owner) {
      return [false, 'missing token account owner in RPC response (fail closed)'];
    }
    if (isPoolOrPdaOwner(owner)) {
      continue;
    }
    const pct = (amt / totalUi) * 100;
    if (pct > singleHolderMaxPct) {
      return [false, `single non-pool holder owns ${pct.toFixed(1)}% (> ${singleHolderMaxPct}%)`];
    }
    nonPoolPcts.push(pct);
  }

  nonPoolPcts.sort((a, b) => b - a);
  const top10Sum = nonPoolPcts.slice(0, 10).reduce((s, p) => s + p, 0);
  if (top10Sum > maxTop10Pct) {
    return [false, `top-10 non-pool holders own ${top10Sum.toFixed(1)}% (> ${maxTop10Pct}%)`];
  }

  return [true, 'ok'];
}

/**
 * Fix 2: Pre-buy sell-route test via Jupiter Quote (sell small amount back to SOL).
 */
export async function checkPreBuySellRoute(
  mint: string,
  cfg: SniperConfig,
  opts?: { tokenPriceUsd?: number | null; decimals?: number | null },
  quoteFn = fetchJupiterQuote
): Promise<[boolean, string]> {
  try {
    let dec = typeof opts?.decimals === 'number' && opts.decimals >= 0 ? opts.decimals : null;
    if (dec === null) dec = await fetchSplMintDecimals(mint);
    if (dec === null) {
      return [false, 'could not verify SPL mint decimals for pre-buy sell route'];
    }
    const solUsd = cachedSolPrice.price || 100;
    const tokPx = opts?.tokenPriceUsd && opts.tokenPriceUsd > 0 ? opts.tokenPriceUsd : null;
    const targetSol = 0.01;
    const tokenUi = tokPx && tokPx > 0 ? (targetSol * solUsd) / tokPx : 1;
    const rawAmount = Math.max(1000, Math.floor(tokenUi * Math.pow(10, dec)));
    const slippageBps = Math.max(50, Math.round((cfg.slippage_pct || 2) * 100));

    const quote = await quoteFn(mint, WSOL_MINT, rawAmount, slippageBps, cfg.jupiter_api_key || undefined);
    const outAmt = Number(quote?.outAmount || 0);
    if (!quote || !Number.isFinite(outAmt) || outAmt <= 0) {
      return [false, 'pre-buy sell test failed: no Jupiter sell route back to SOL'];
    }
    const impactPct = Math.abs(parseFloat(String(quote.priceImpactPct ?? '0')) || 0) * 100;
    if (impactPct > 5) {
      return [false, `pre-buy sell test rejected: price impact ${impactPct.toFixed(2)}% > 5%`];
    }
    return [true, 'ok'];
  } catch (err: any) {
    return [false, `pre-buy sell test failed: ${err?.message || 'no route'}`];
  }
}

export interface HardRugDeps {
  getJsonFn?: typeof getJson;
  rpcMintAuthFn?: typeof rpcMintAuthorities;
  holdersFn?: typeof checkOnChainHolders;
  sellRouteFn?: typeof checkPreBuySellRoute;
  bypassCache?: boolean;
}

export async function hardRugCheck(
  mint: string,
  cfg: SniperConfig,
  _ageS: number,
  opts?: { tokenPriceUsd?: number | null; decimals?: number | null },
  deps?: HardRugDeps
): Promise<[boolean, string]> {
  const ttlMs = Math.max(60, (cfg.rug_recheck_minutes ?? 15) * 60) * 1000;
  if (!deps?.bypassCache) {
    const hit = _rugCache.get(mint);
    if (hit && Date.now() < hit[0]) {
      return hit[1];
    }
  }

  const getJsonFn = deps?.getJsonFn || getJson;
  const rpcAuthFn = deps?.rpcMintAuthFn || rpcMintAuthorities;
  const holdersFn = deps?.holdersFn || checkOnChainHolders;
  const sellRouteFn = deps?.sellRouteFn || checkPreBuySellRoute;

  let verdict: [boolean, string] = [true, 'ok'];
  let shortCacheFail = false;

  const [rpcOk, ma, fa] = await rpcAuthFn(mint);
  if (!rpcOk) {
    verdict = [false, 'on-chain mint/freeze authority RPC check unavailable (fail closed)'];
    shortCacheFail = true;
  } else if (ma) {
    verdict = [false, 'mint authority NOT revoked (on-chain: dev can mint supply)'];
  } else if (fa) {
    verdict = [false, 'freeze authority enabled (on-chain: dev can freeze sells)'];
  }

  if (verdict[0] && cfg.use_rugcheck) {
    const rep = await getJsonFn(`${RUGC}/${mint}/report/summary`, undefined, 8000);
    const risks = rep && typeof rep === 'object' ? rep.risks : null;
    if (!Array.isArray(risks)) {
      shortCacheFail = true;
      verdict = [false, 'rugcheck report missing or request failed (fail closed)'];
    } else {
      const lpLockedPct = _f(rep.lpLockedPct);
      if (lpLockedPct !== null && lpLockedPct < 80) {
        verdict = [false, `LP not locked (${lpLockedPct.toFixed(0)}% locked — dev can pull liquidity)`];
      }
      if (verdict[0]) {
        let sn = _f(rep.score_normalised ?? rep.score);
        if (sn !== null) {
          if (sn > 100) sn /= 1000.0;
          if (sn >= (cfg.rugcheck_max_score ?? 30)) {
            verdict = [false, `rugcheck risk score ${sn.toFixed(0)}/100`];
          }
        }
      }
      if (verdict[0]) {
        for (const risk of risks) {
          const level = String(risk?.level || '').toLowerCase();
          const name = String(risk?.name || '');
          const low = name.toLowerCase();
          if (level === 'danger') {
            verdict = [false, `rugcheck danger: ${name || 'unknown risk'}`];
            break;
          }
          if (low.includes('holder')) {
            const txt = `${String(risk?.description || '')} ${name}`;
            const m = txt.match(/([\d.]+)\s*%/);
            if (m && parseFloat(m[1]) > (cfg.max_top10_holder_pct ?? 35)) {
              verdict = [false, `${name} (${m[1]}%)`];
              break;
            }
          }
        }
      }
    }
  }

  if (verdict[0]) {
    const [holdersOk, holdersWhy] = await holdersFn(mint, cfg.max_top10_holder_pct ?? 35, 10);
    if (!holdersOk) {
      shortCacheFail = true;
      verdict = [false, holdersWhy];
    }
  }

  if (verdict[0]) {
    const [routeOk, routeWhy] = await sellRouteFn(mint, cfg, opts);
    if (!routeOk) {
      shortCacheFail = true;
      verdict = [false, routeWhy];
    }
  }

  if (!deps?.bypassCache) {
    if (_rugCache.size > 5000) _rugCache.clear();
    const cacheForMs = shortCacheFail || !verdict[0] ? 10_000 : ttlMs;
    _rugCache.set(mint, [Date.now() + cacheForMs, verdict]);
  }
  return verdict;
}

// ---------------- ACCOUNT GUARD, VALIDATION & BUY/SELL EXECUTION ----------------
let lastConfirmedLiveRisk: { sl: number; tp: number } | null = null;

export function getLiveExposureSol(mode: ExecutionMode): number {
  const ledger = ledgers[mode];
  if (!ledger) return 0;
  let total = 0;
  for (const pos of Object.values(ledger.positions)) {
    total += pos.cost_sol ?? 0;
  }
  for (const pb of ledger.pending_buys || []) {
    if (pb.status === 'PENDING') {
      total += pb.tradeSol || 0;
    }
  }
  return total;
}

export function canOpenPosition(
  mode: ExecutionMode,
  plannedTradeSol?: number
): { allowed: boolean; reason: string } {
  const ledger = ledgers[mode];
  rollDay(ledger);
  const c = botConfig;

  if (Object.keys(ledger.positions).length >= c.max_open_positions) {
    return { allowed: false, reason: 'max positions' };
  }

  const solPx = cachedSolPrice.price;
  if (mode === 'live' && (!solPx || solPx <= 0)) {
    return { allowed: false, reason: 'live SOL price unavailable (fail closed)' };
  }

  const activeLossLimitUsd =
    c.sizing_basis === 'sol' && (c.daily_loss_limit_sol ?? 0) > 0
      ? solPx && solPx > 0
        ? c.daily_loss_limit_sol * solPx
        : c.daily_loss_limit_usd
      : c.daily_loss_limit_usd;
  if (activeLossLimitUsd > 0 && ledger.day_pnl <= -activeLossLimitUsd) {
    return { allowed: false, reason: 'daily loss limit' };
  }

  if (mode === 'live') {
    const liveWallet = getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana');
    const kp = getTradingKeypair();
    if (!kp) {
      return { allowed: false, reason: 'server-side trading signer required for live exits' };
    }
    const maxExpSol = c.max_wallet_exposure_sol ?? 0.1;
    const tradeSolEstimate =
      plannedTradeSol ??
      (c.sizing_basis === 'sol' && (c.trade_size_sol ?? 0) > 0
        ? Math.min(c.trade_size_sol, c.MAX_POSITION_SIZE_SOL || c.trade_size_sol)
        : solPx && solPx > 0
        ? Math.min(c.trade_size_usd, c.MAX_POSITION_SIZE_USD || 100) / solPx
        : 0);
    const currentExposureSol = getLiveExposureSol('live');
    if (maxExpSol > 0 && currentExposureSol + tradeSolEstimate > maxExpSol + 1e-9) {
      return {
        allowed: false,
        reason: `max wallet exposure exceeded (${(currentExposureSol + tradeSolEstimate).toFixed(4)} > ${maxExpSol.toFixed(4)} SOL)`,
      };
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
        ? solPx && solPx > 0
          ? c.trade_size_sol * solPx
          : c.trade_size_usd
        : c.trade_size_usd;
    if (ledger.cash < requiredUsd) {
      return { allowed: false, reason: 'no cash' };
    }
  }
  return { allowed: true, reason: 'ok' };
}

export function validateLiveStart(): { ok: boolean; error?: string } {
  if (botConfig.EXECUTION_MODE !== 'live') return { ok: true };

  if (!getTradingKeypair()) {
    return {
      ok: false,
      error:
        'Live trading requires an autonomous server-side signer keypair so stop-loss and rug exits execute without browser popups. Configure your dedicated keypair in Wallets, or use Paper mode.',
    };
  }

  const liveWallet = getLiveConnectedWallet(botConfig.DEFAULT_CHAIN || 'solana');
  if (liveWallet && liveWallet.is_connected) {
    const bal = parseFloat(liveWallet.native_balance) || 0;
    if (bal <= botConfig.MIN_GAS_RESERVE_SOL) {
      return {
        ok: false,
        error: `Cannot start Live mode: Insufficient SOL balance (${bal.toFixed(4)} SOL). Keep above ${botConfig.MIN_GAS_RESERVE_SOL} SOL gas reserve.`,
      };
    }
  }

  return { ok: true };
}

export function validateAndApplySettings(
  raw: Record<string, any>
): { ok: boolean; error?: string; changes: string[]; config?: SniperConfig } {
  const errors: string[] = [];
  const parsed: Partial<SniperConfig> = {};

  for (const [key, val] of Object.entries(raw || {})) {
    if (key === 'jupiter_api_key') {
      if (typeof val === 'string' && !val.includes('***')) {
        parsed.jupiter_api_key = val.trim();
      }
      continue;
    }
    if (BOOL_SETTINGS.has(key)) {
      (parsed as any)[key] =
        typeof val === 'string' ? ['1', 'true', 'yes', 'on'].includes(val.trim().toLowerCase()) : Boolean(val);
      continue;
    }
    if (key in SETTING_LIMITS) {
      if (key === 'ultra_early_grace_sec') {
        parsed.ultra_early_grace_sec = 0;
        continue;
      }
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
    return { ok: false, error: errors.join('\n'), changes: [] };
  }

  // Risk/Reward invariant: stop_loss_pct <= 20 and take_profit_pct >= stop_loss_pct * 1.5
  const nextSl = parsed.stop_loss_pct !== undefined ? parsed.stop_loss_pct : botConfig.stop_loss_pct;
  const nextTp = parsed.take_profit_pct !== undefined ? parsed.take_profit_pct : botConfig.take_profit_pct;
  if (nextSl > 20) {
    return { ok: false, error: 'stop_loss_pct cannot exceed 20%.', changes: [] };
  }
  if (nextSl > 0 && nextTp < nextSl * 1.5) {
    return {
      ok: false,
      error: `Risk/Reward guard: take_profit_pct (${nextTp}%) must be at least 1.5x stop_loss_pct (${(nextSl * 1.5).toFixed(1)}%).`,
      changes: [],
    };
  }

  const nextMinAge = parsed.min_age_minutes !== undefined ? parsed.min_age_minutes : botConfig.min_age_minutes;
  const nextMaxAge = parsed.max_age_minutes !== undefined ? parsed.max_age_minutes : botConfig.max_age_minutes;
  if (nextMaxAge < nextMinAge) {
    return {
      ok: false,
      error: `max_age_minutes (${nextMaxAge}) must be >= min_age_minutes (${nextMinAge}).`,
      changes: [],
    };
  }

  if (raw.EXECUTION_MODE === 'live' && botConfig.EXECUTION_MODE !== 'live') {
    if (currentLifecycleState === 'RUNNING') {
      return { ok: false, error: 'Cannot switch to Live while bot is running. Please STOP the bot first.', changes: [] };
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

  parsed.ultra_early_grace_sec = 0;

  const prev = botConfig;
  const nextConfig: SniperConfig = { ...prev, ...parsed };
  const changes: string[] = [];
  for (const key of Object.keys(parsed) as Array<keyof SniperConfig>) {
    const oldVal = (prev as any)[key];
    const newVal = (nextConfig as any)[key];
    if (oldVal !== newVal) {
      if (key === 'jupiter_api_key') {
        changes.push(`jupiter_api_key: ${oldVal ? '***' : 'empty'} -> ${newVal ? '***' : 'empty'}`);
      } else {
        changes.push(`${String(key)}: ${JSON.stringify(oldVal)} -> ${JSON.stringify(newVal)}`);
      }
    }
  }

  botConfig = nextConfig;
  if (parsed.EXECUTION_MODE === 'live') {
    lastConfirmedLiveRisk = { sl: botConfig.stop_loss_pct, tp: botConfig.take_profit_pct };
  }
  saveSettingsToDisk();
  if (changes.length > 0) {
    sniperLog(`Settings updated (applies to new positions only): ${changes.join(', ')}`, 'info', 'SETTINGS_UPDATED');
  } else {
    sniperLog('Settings applied and saved (no changes).', 'info', 'SETTINGS_UPDATED');
  }
  return { ok: true, changes, config: botConfig };
}

function noteRejected(mode: ExecutionMode, mint: string) {
  const bl = ledgers[mode].blacklist;
  if (!bl.includes(mint)) bl.push(mint);
  if (bl.length > 5000) bl.splice(0, bl.length - 5000);
  saveStateToDisk();
}

function recordAttemptedMint(mode: ExecutionMode, mint: string) {
  const ledger = ledgers[mode];
  if (!Array.isArray(ledger.attempted_mints)) ledger.attempted_mints = [];
  if (!ledger.attempted_mints.includes(mint)) {
    ledger.attempted_mints.push(mint);
    if (ledger.attempted_mints.length > 5000) {
      ledger.attempted_mints.splice(0, ledger.attempted_mints.length - 5000);
    }
  }
  saveStateToDisk();
}

function snapshotExitParams(c: SniperConfig): PositionExitParams {
  return {
    take_profit_pct: c.take_profit_pct,
    stop_loss_pct: c.stop_loss_pct,
    trailing_stop_pct: c.trailing_stop_pct,
    rug_exit_drop_pct: c.rug_exit_drop_pct,
    max_hold_minutes: c.max_hold_minutes,
  };
}

function createRecoveredPositionFromBalance(
  mode: ExecutionMode,
  mint: string,
  symbol: string,
  qty: number,
  priceUsd: number,
  tradeSol: number,
  solPriceUsd: number,
  url: string,
  meta?: { dex?: string; source?: string; age_s?: number; decimals?: number },
  txHash?: string,
  explorerUrl?: string,
  tradeId?: string,
  fees?: { baseFeeSol?: number; priorityFeeSol?: number; rentPaidSol?: number },
  exitParams?: PositionExitParams
) {
  const ledger = ledgers[mode];
  const costUsd = tradeSol * solPriceUsd;
  const entryPx = qty > 0 && costUsd > 0 ? costUsd / qty : priceUsd;
  const tid = tradeId || `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  ledger.positions[mint] = {
    trade_id: tid,
    mint,
    symbol,
    qty,
    entry_price: entryPx,
    cost: costUsd,
    cost_sol: tradeSol,
    buy_base_fee_sol: fees?.baseFeeSol ?? 0,
    buy_priority_fee_sol: fees?.priorityFeeSol ?? 0,
    buy_rent_paid_sol: fees?.rentPaidSol ?? 0,
    exit_params: exitParams || snapshotExitParams(botConfig),
    opened: Date.now(),
    url,
    peak_price: entryPx,
    low_price: entryPx,
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
  recordAttemptedMint(mode, mint);
  if (entryPx > 0) {
    livePrices.set(mint, entryPx);
    lastPriceTime = Date.now();
  }

  const buyRow: SniperTradeRow = {
    id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    trade_id: tid,
    mode,
    time: new Date().toISOString(),
    action: 'BUY',
    symbol,
    mint,
    price: entryPx,
    usd: costUsd,
    sol_amount: Math.round(tradeSol * 1e6) / 1e6,
    sol_spent: Math.round(tradeSol * 1e6) / 1e6,
    sol_received: null,
    base_fee_sol: fees?.baseFeeSol ?? 0,
    priority_fee_sol: fees?.priorityFeeSol ?? 0,
    rent_paid_sol: fees?.rentPaidSol ?? 0,
    pnl_usd: null,
    pnl_sol: null,
    net_pnl_sol: null,
    net_pnl_usd: null,
    pnl_pct: null,
    estimated: !txHash,
    reason: txHash ? 'sniper_entry' : 'recovered_onchain_balance',
    dexscreener: url,
    age_s: Math.round((meta?.age_s || 0) * 10) / 10,
    dex: meta?.dex || '?',
    source: meta?.source || '?',
    tx_hash: txHash,
    explorer_url: explorerUrl,
  };
  ledger.trades.unshift(buyRow);
  if (ledger.trades.length > 500) ledger.trades.length = 500;
  appendTradeCsv(buyRow);
  saveStateToDisk();
  broadcastSse('trade_event', { action: 'BUY', mode, mint });
}

let _reconcilePendingRunning = false;
async function reconcilePendingBuys(): Promise<void> {
  if (_reconcilePendingRunning) return;
  const ledger = ledgers.live;
  const pending = (ledger.pending_buys || []).filter((p) => p.status === 'PENDING');
  if (pending.length === 0) return;

  _reconcilePendingRunning = true;
  try {
    const now = Date.now();
    for (const rec of pending) {
      if (ledger.positions[rec.mint]) {
        rec.status = 'CONFIRMED';
        continue;
      }

      if (rec.signature) {
        const check = await checkPendingSignatureStatus(rec.signature, rec.mint, rec.userPublicKey);
        if (check.state === 'CONFIRMED' && (check.metrics?.actualTokensReceived || 0) > 0) {
          rec.status = 'CONFIRMED';
          const solPx = rec.solPriceUsd || (await getSolPriceUsd());
          const actualSol = check.metrics?.actualSolSpent ?? rec.tradeSol;
          const actualQty = check.metrics!.actualTokensReceived!;
          const pxUsd = solPx && solPx > 0 ? (actualSol * solPx) / actualQty : 0;
          createRecoveredPositionFromBalance(
            'live',
            rec.mint,
            rec.symbol,
            actualQty,
            pxUsd,
            actualSol,
            solPx || 0,
            rec.url,
            { dex: rec.dex, source: rec.source, age_s: rec.age_s, decimals: rec.decimals },
            rec.signature,
            `https://solscan.io/tx/${rec.signature}`,
            rec.trade_id,
            {
              baseFeeSol: check.metrics?.baseFeeSol,
              priorityFeeSol: check.metrics?.priorityFeeSol,
              rentPaidSol: check.metrics?.rentPaidSol,
            },
            rec.exit_params
          );
          sniperLog(
            `✓ [PENDING CONFIRMED] ${rec.symbol} landed on-chain (${rec.signature.slice(0, 8)}...): ${actualSol.toFixed(4)} SOL for ${actualQty.toFixed(2)} tokens.`,
            'buy'
          );
          continue;
        }
        if (check.state === 'FAILED') {
          rec.status = 'FAILED';
          sniperLog(`✗ [PENDING FAILED] ${rec.symbol} failed on-chain: ${check.error || 'transaction error'}`, 'warn');
          continue;
        }
      }

      // Check on-chain token balance directly in case confirmation fell outside lookback
      const bal = await getOnChainSplTokenBalance(rec.userPublicKey, rec.mint);
      if (bal.ok && bal.uiAmount > 0.000001) {
        rec.status = 'CONFIRMED';
        const solPx = rec.solPriceUsd || (await getSolPriceUsd()) || 0;
        createRecoveredPositionFromBalance(
          'live',
          rec.mint,
          rec.symbol,
          bal.uiAmount,
          0,
          rec.tradeSol,
          solPx,
          rec.url,
          { dex: rec.dex, source: rec.source, age_s: rec.age_s, decimals: rec.decimals },
          rec.signature || undefined,
          rec.signature ? `https://solscan.io/tx/${rec.signature}` : undefined,
          rec.trade_id,
          undefined,
          rec.exit_params
        );
        sniperLog(
          `✓ [PENDING RECOVERED] ${rec.symbol} wallet holds ${bal.uiAmount.toFixed(2)} tokens — position created from real balance.`,
          'buy'
        );
        continue;
      }

      if (now >= rec.expiresAt) {
        rec.status = 'FAILED';
        sniperLog(`✗ [PENDING EXPIRED] ${rec.symbol} did not confirm within 120s and wallet holds 0 tokens.`, 'warn');
      }
    }
    ledger.pending_buys = (ledger.pending_buys || []).filter(
      (p) => p.status === 'PENDING' || Date.now() - p.startedAt < 3_600_000
    );
    saveStateToDisk();
  } finally {
    _reconcilePendingRunning = false;
  }
}

export async function executeBuy(
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
    if (ledger.positions[mint]) return false;
    if (Array.isArray(ledger.attempted_mints) && ledger.attempted_mints.includes(mint)) return false;
    if ((ledger.pending_buys || []).some((p) => p.mint === mint && p.status === 'PENDING')) return false;

    const c = botConfig;
    const solPriceUsd = await getSolPriceUsd();
    if (mode === 'live' && (!solPriceUsd || solPriceUsd <= 0)) {
      sniperLog(`✗ [LIVE BUY SKIPPED] ${symbol}: live SOL price unavailable.`, 'warn');
      return false;
    }
    const effectiveSolPx = solPriceUsd && solPriceUsd > 0 ? solPriceUsd : 100;

    const useSolBasis = c.sizing_basis === 'sol' && (c.trade_size_sol ?? 0) > 0;
    const tradeSol =
      mode === 'live'
        ? useSolBasis
          ? Math.min(c.trade_size_sol, c.MAX_POSITION_SIZE_SOL || c.trade_size_sol || 1)
          : Math.min(c.trade_size_usd, c.MAX_POSITION_SIZE_USD || 100) / effectiveSolPx
        : useSolBasis
        ? c.trade_size_sol
        : c.trade_size_usd / effectiveSolPx;
    const size = tradeSol * effectiveSolPx;

    const check = canOpenPosition(mode, tradeSol);
    if (!check.allowed) return false;

    const cleanUrl = url || `https://dexscreener.com/solana/${mint}`;
    const exitParams = snapshotExitParams(c);
    const tradeId = `trd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Fix 5: Check on-chain token balance before any new live buy so untracked tokens are never rebought
    if (mode === 'live') {
      const kp = getTradingKeypair();
      const ownerAddr = kp?.publicKey.toBase58() || getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana')?.address || null;
      if (ownerAddr) {
        const preBal = await getOnChainSplTokenBalance(ownerAddr, mint);
        if (preBal.ok && preBal.uiAmount > 0.000001) {
          createRecoveredPositionFromBalance(
            mode,
            mint,
            symbol,
            preBal.uiAmount,
            price,
            tradeSol,
            effectiveSolPx,
            cleanUrl,
            meta,
            undefined,
            undefined,
            tradeId,
            undefined,
            exitParams
          );
          sniperLog(
            `⚠ [RECOVERY] ${symbol}: already holding ${preBal.uiAmount.toFixed(4)} tokens on-chain — created tracked position instead of rebuying.`,
            'warn'
          );
          return false;
        }
      }
    }

    let fill = price * (1 + c.slippage_pct / 100);
    let qty = (size * (1 - c.fee_pct / 100)) / fill;
    let txHash: string | undefined;
    let explorerUrl: string | undefined;
    let actualSolSpent = tradeSol;
    let actualCostUsd = size;
    let buyBaseFeeSol = 0;
    let buyPriorityFeeSol = 0;
    let buyRentPaidSol = 0;

    if (mode === 'live') {
      _swapPriorityUntil = Date.now() + 8000;
      sniperLog(`⚡ [LIVE BUY START] ${symbol}: swapping ${tradeSol.toFixed(4)} SOL ($${size.toFixed(2)})...`, 'buy');

      // Record attempted mint the moment buy submission starts so we never double-buy
      recordAttemptedMint(mode, mint);

      const kp = getTradingKeypair();
      let liveRes: any;
      let ownerAddr = kp?.publicKey.toBase58() || getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana')?.address || '';

      if (kp) {
        liveRes = await executeLiveSolanaBuy({
          tokenAddress: mint,
          tokenSymbol: symbol,
          tradeAmountSol: tradeSol,
          tradeAmountUsd: size,
          maxSlippageBps: Math.max(50, Math.round(c.slippage_pct * 100)),
          priorityFeeLevel: c.PRIORITY_FEE_LEVEL || 'standard',
          solPriceUsd: effectiveSolPx,
          jupiterApiKey: c.jupiter_api_key || undefined,
          onTxSent: (sig) => {
            if (!ledger.pending_buys) ledger.pending_buys = [];
            ledger.pending_buys.push({
              mint,
              symbol,
              signature: sig,
              userPublicKey: kp.publicKey.toBase58(),
              mode,
              trade_id: tradeId,
              startedAt: Date.now(),
              expiresAt: Date.now() + 120_000,
              tradeSol,
              tradeUsd: size,
              solPriceUsd: effectiveSolPx,
              url: cleanUrl,
              dex: meta?.dex || '?',
              source: meta?.source || '?',
              age_s: meta?.age_s || 0,
              decimals: meta?.decimals,
              exit_params: exitParams,
              status: 'PENDING',
            });
            saveStateToDisk();
          },
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
        ownerAddr = liveWallet.address;
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'PREPARING', detail: 'Fetching Jupiter quote...' });
        const prep = await prepareLiveBuyTransaction({
          userPublicKey: liveWallet.address,
          tokenAddress: mint,
          tokenSymbol: symbol,
          tradeAmountSol: tradeSol,
          tradeAmountUsd: size,
          maxSlippageBps: Math.max(50, Math.round(c.slippage_pct * 100)),
          priorityFeeLevel: c.PRIORITY_FEE_LEVEL || 'standard',
          jupiterApiKey: c.jupiter_api_key || undefined,
        });
        if (!prep.success || !prep.base64Tx) {
          sniperLog(`✗ [LIVE BUY FAILED] ${symbol}: ${prep.error}`, 'warn');
          broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'FAILED', error: prep.error });
          return false;
        }
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'PHANTOM_CONFIRM', detail: 'Approve swap in Phantom popup...' });
        const sigRes = await requestBrowserWalletSignature(
          {
            action: 'BUY',
            symbol,
            mint,
            base64Tx: prep.base64Tx,
            userPublicKey: liveWallet.address,
          },
          {
            action: 'BUY',
            symbol,
            mint,
            userPublicKey: liveWallet.address,
            tradeSol,
            tradeUsd: size,
            solPriceUsd: effectiveSolPx,
            estTokensOut: prep.estTokensOut,
            url: cleanUrl,
            dex: meta?.dex || '?',
            source: meta?.source || '?',
            age_s: meta?.age_s || 0,
            decimals: meta?.decimals,
            exit_params: exitParams,
            trade_id: tradeId,
          }
        );
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
          solPriceUsd: effectiveSolPx,
        });
      }

      if (!liveRes?.success) {
        if (liveRes?.timedOut) {
          // Mark PENDING and keep polling up to 120s instead of treating timeout as failure
          if (!ledger.pending_buys) ledger.pending_buys = [];
          const existing = ledger.pending_buys.find((p) => p.mint === mint && p.status === 'PENDING');
          if (!existing) {
            ledger.pending_buys.push({
              mint,
              symbol,
              signature: liveRes.signature || '',
              userPublicKey: ownerAddr,
              mode,
              trade_id: tradeId,
              startedAt: Date.now(),
              expiresAt: Date.now() + 120_000,
              tradeSol,
              tradeUsd: size,
              solPriceUsd: effectiveSolPx,
              url: cleanUrl,
              dex: meta?.dex || '?',
              source: meta?.source || '?',
              age_s: meta?.age_s || 0,
              decimals: meta?.decimals,
              exit_params: exitParams,
              status: 'PENDING',
            });
          } else {
            existing.signature = existing.signature || liveRes.signature || '';
            existing.expiresAt = Math.max(existing.expiresAt, Date.now() + 120_000);
          }
          saveStateToDisk();
          sniperLog(
            `⏳ [LIVE BUY PENDING] ${symbol}: confirmation timed out — marked PENDING and polling up to 120s.`,
            'warn'
          );
          broadcastSse('execution_progress', {
            action: 'BUY',
            token: symbol,
            step: 'PENDING',
            detail: 'Confirmation timed out; polling up to 120s...',
          });
          setTimeout(() => reconcilePendingBuys().catch(() => {}), 4000);
          return false;
        }

        // Clean up confirmed-failed pending buy
        if (Array.isArray(ledger.pending_buys)) {
          for (const p of ledger.pending_buys) {
            if (p.mint === mint && p.status === 'PENDING') p.status = 'FAILED';
          }
          saveStateToDisk();
        }
        sniperLog(`✗ [LIVE BUY FAILED] ${symbol}: ${liveRes?.error}`, 'warn');
        broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'FAILED', error: liveRes?.error });
        return false;
      }

      if (Array.isArray(ledger.pending_buys)) {
        for (const p of ledger.pending_buys) {
          if (p.mint === mint && p.status === 'PENDING') p.status = 'CONFIRMED';
        }
      }

      broadcastSse('execution_progress', { action: 'BUY', token: symbol, step: 'CONFIRMED', detail: `Tx ${liveRes.signature?.slice(0, 8)}` });
      actualSolSpent = liveRes.actualAmountIn || tradeSol;
      qty = liveRes.actualAmountOut || qty;
      actualCostUsd = actualSolSpent * effectiveSolPx;
      fill = qty > 0 && actualCostUsd > 0 ? actualCostUsd / qty : liveRes.actualEffectivePriceUsd || fill;
      buyBaseFeeSol = liveRes.baseFeeSol || 0;
      buyPriorityFeeSol = liveRes.priorityFeeSol || 0;
      buyRentPaidSol = liveRes.rentPaidSol || 0;
      txHash = liveRes.signature;
      explorerUrl = liveRes.explorerUrl;
    } else {
      ledger.cash -= size;
    }

    ledger.positions[mint] = {
      trade_id: tradeId,
      mint,
      symbol,
      qty,
      entry_price: fill,
      cost: actualCostUsd,
      cost_sol: actualSolSpent,
      buy_base_fee_sol: buyBaseFeeSol,
      buy_priority_fee_sol: buyPriorityFeeSol,
      buy_rent_paid_sol: buyRentPaidSol,
      exit_params: exitParams,
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
    recordAttemptedMint(mode, mint);
    livePrices.set(mint, fill);
    lastPriceTime = Date.now();

    const tradeRow: SniperTradeRow = {
      id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      trade_id: tradeId,
      mode,
      time: new Date().toISOString(),
      action: 'BUY',
      symbol,
      mint,
      price: fill,
      usd: actualCostUsd,
      sol_amount: Math.round(actualSolSpent * 1e6) / 1e6,
      sol_spent: Math.round(actualSolSpent * 1e6) / 1e6,
      sol_received: null,
      base_fee_sol: buyBaseFeeSol,
      priority_fee_sol: buyPriorityFeeSol,
      rent_paid_sol: buyRentPaidSol,
      pnl_usd: null,
      pnl_sol: null,
      net_pnl_sol: null,
      net_pnl_usd: null,
      pnl_pct: null,
      estimated: false,
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
      `✓ SNIPER BUY ${symbol} [${meta?.dex || '?'}/${meta?.source || '?'}] ${actualSolSpent.toFixed(4)} SOL ($${actualCostUsd.toFixed(2)}) @ $${fmtPrice(fill)}${txHash ? ` (tx: ${txHash.slice(0, 8)}...)` : ''}`,
      'buy'
    );
    saveStateToDisk();
    broadcastSse('trade_event', { action: 'BUY', mode, mint });
    return true;
  } finally {
    inFlightBuys.delete(mint);
  }
}

export async function confirmDeadLiquidityTwoSources(
  mint: string,
  cfg: SniperConfig,
  deps?: { jupFn?: typeof fetchJupiterPrices; dexFn?: typeof getJson }
): Promise<boolean> {
  try {
    const liqMap = new Map<string, number>();
    const deadSet = new Set<string>();
    const jupFn = deps?.jupFn || fetchJupiterPrices;
    const dexFn = deps?.dexFn || getJson;

    const jupPrices = await jupFn([mint], cfg, liqMap, deadSet);
    const jupLiq = liqMap.get(mint);
    const jupConfirmedDead =
      deadSet.has(mint) || (jupLiq !== undefined && jupLiq < 50) || (!jupPrices.has(mint) && (jupLiq === undefined || jupLiq < 50));

    const ds = await dexFn(`${DEX}/latest/dex/tokens/${mint}`, undefined, 5000);
    const dsPairs = Array.isArray(ds?.pairs) ? ds.pairs : [];
    const maxDsLiq = dsPairs.reduce((mx: number, p: any) => Math.max(mx, _f(p?.liquidity?.usd) || 0), 0);
    const dexConfirmedDead = ds !== null && maxDsLiq < 50;

    return jupConfirmedDead && dexConfirmedDead;
  } catch {
    return false;
  }
}

export function evaluateWriteOffEligibility(
  pos: SniperPosition,
  twoSourceDead: boolean,
  nowMs = Date.now()
): { eligible: boolean; attempts: number; elapsedMs: number } {
  const attempts = pos.failed_sell_attempts || 0;
  const firstAt = pos.first_unsellable_at || nowMs;
  const elapsedMs = Math.max(0, nowMs - firstAt);
  const eligible = attempts >= 5 && elapsedMs >= 10 * 60 * 1000 && twoSourceDead;
  return { eligible, attempts, elapsedMs };
}

export async function executeSell(mode: ExecutionMode, mint: string, price: number, reason: string): Promise<boolean> {
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
    let exactProceedsSol: number | undefined;
    let sellBaseFeeSol = 0;
    let sellPriorityFeeSol = 0;
    let sellRentPaidSol = 0;
    let sellRentReclaimedSol = 0;
    let isEstimated = false;

    const isEmergencyOrRugExit =
      reason.startsWith('rug_') ||
      reason.startsWith('stop_loss_') ||
      reason.startsWith('max_hold') ||
      reason === 'kill_switch';

    const handleFailedSellAttempt = async (errMsg: string): Promise<boolean> => {
      const now = Date.now();
      pos.failed_sell_attempts = (pos.failed_sell_attempts || 0) + 1;
      if (!pos.first_unsellable_at) pos.first_unsellable_at = now;
      const backoffMs = Math.min(300_000, 15_000 * Math.pow(2, Math.min(pos.failed_sell_attempts - 1, 4)));
      pos.next_sell_retry_at = now + backoffMs;
      saveStateToDisk();

      const twoSourceDead = await confirmDeadLiquidityTwoSources(mint, c);
      const elig = evaluateWriteOffEligibility(pos, twoSourceDead, now);
      if (elig.eligible) {
        fill = 0;
        proceeds = 0;
        exactProceedsSol = 0;
        effectiveReason = 'WRITE_OFF_UNSELLABLE';
        isEstimated = true;
        sniperLog(
          `⚠ [WRITE_OFF_UNSELLABLE] ${pos.symbol}: no route after ${elig.attempts} attempts / ${(elig.elapsedMs / 60000).toFixed(1)}m and liquidity < $50 on 2 sources — writing off at $0 (${errMsg}).`,
          'warn'
        );
        broadcastSse('execution_progress', {
          action: 'SELL',
          token: pos.symbol,
          step: 'CONFIRMED',
          detail: 'WRITE_OFF_UNSELLABLE ($0)',
        });
        return true;
      }

      sniperLog(
        `⏳ [SELL RETRY] ${pos.symbol} (${errMsg}) — attempt ${elig.attempts}/5, elapsed ${(elig.elapsedMs / 60000).toFixed(1)}/10m, 2-source dead=${twoSourceDead}; next retry in ${(backoffMs / 1000).toFixed(0)}s.`,
        'warn'
      );
      broadcastSse('execution_progress', {
        action: 'SELL',
        token: pos.symbol,
        step: 'FAILED',
        error: `${errMsg} (retrying in ${(backoffMs / 1000).toFixed(0)}s)`,
      });
      return false;
    };

    if (mode === 'live') {
      const solPriceNow = await getSolPriceUsd();
      const effectiveSolPx = solPriceNow && solPriceNow > 0 ? solPriceNow : null;

      if (reason === 'manual_review_cleared') {
        exactProceedsSol = safePrice > 0 && effectiveSolPx ? (pos.qty * safePrice) / effectiveSolPx : 0;
        proceeds = safePrice > 0 ? pos.qty * safePrice : 0;
        fill = safePrice;
        effectiveReason = 'manual_review_cleared';
        isEstimated = true;
      } else if (safePrice <= 0 && reason === 'rug_no_price_auto_clear') {
        const wroteOff = await handleFailedSellAttempt('no price quote available');
        if (!wroteOff) return false;
      } else {
        const exitSlippageBps = isEmergencyOrRugExit
          ? Math.max(2500, Math.round(c.slippage_pct * 100))
          : Math.max(50, Math.round(c.slippage_pct * 100));
        const kp = getTradingKeypair();
        const ownerAddr = kp?.publicKey.toBase58() || getLiveConnectedWallet(c.DEFAULT_CHAIN || 'solana')?.address || null;
        let sellQty = pos.qty;
        let liveRes: any;

        if (ownerAddr) {
          const bal = await getOnChainSplTokenBalance(ownerAddr, mint);
          if (bal.ok && bal.uiAmount <= 0.000001) {
            // Fix 6: Require on-chain proof from findExternalSellOnChain before clearing sold_externally
            const extSell = await findExternalSellOnChain(ownerAddr, mint, pos.opened);
            if (!extSell.found) {
              pos.needs_review = true;
              pos.needs_review_reason = 'RPC returned 0 token balance, but no on-chain sell transaction was found. Inspect wallet or manually clear.';
              saveStateToDisk();
              broadcastSse('trade_event', { action: 'NEEDS_REVIEW', mode, mint });
              sniperLog(`⚠ [NEEDS REVIEW] ${pos.symbol}: zero balance read but no on-chain sell found — keeping position open.`, 'warn');
              return false;
            }
            effectiveReason = reason.startsWith('sold_externally') ? reason : 'sold_externally_verified';
            if (extSell.actualSolReceived !== undefined) {
              exactProceedsSol = extSell.actualSolReceived;
              proceeds = effectiveSolPx ? extSell.actualSolReceived * effectiveSolPx : 0;
              fill = pos.qty > 0 && proceeds > 0 ? proceeds / pos.qty : safePrice;
              isEstimated = !effectiveSolPx;
            } else {
              fill = safePrice;
              proceeds = pos.qty * safePrice;
              isEstimated = true;
            }
            sellBaseFeeSol = extSell.baseFeeSol || 0;
            sellPriorityFeeSol = extSell.priorityFeeSol || 0;
            sellRentPaidSol = 0;
            sellRentReclaimedSol = extSell.ataRentReclaimedSol || 0;
            txHash = extSell.signature;
            explorerUrl = extSell.explorerUrl;
            sniperLog(
              `✓ [EXTERNAL EXIT VERIFIED] ${pos.symbol}: matched on-chain sell (${txHash?.slice(0, 8)}...) — received ${exactProceedsSol?.toFixed(4) ?? '?'} SOL.`,
              'info'
            );
            liveRes = { success: true, _verifiedExternal: true };
          } else if (bal.ok && bal.uiAmount > 0 && bal.uiAmount < pos.qty) {
            sellQty = bal.uiAmount;
          }
        }

        if (!liveRes?._verifiedExternal) {
          let resolvedDecimals = pos.decimals;
          if (!resolvedDecimals || resolvedDecimals <= 0) {
            resolvedDecimals = (await fetchSplMintDecimals(mint)) ?? undefined;
            if (!resolvedDecimals) {
              return await handleFailedSellAttempt('unable to resolve SPL mint decimals');
            }
            pos.decimals = resolvedDecimals;
          }

          _swapPriorityUntil = Date.now() + 8000;
          sniperLog(`⚡ [LIVE SELL START] ${pos.symbol} (${reason})...`, 'sell');
          if (kp) {
            liveRes = await executeLiveSolanaSell({
              tokenAddress: mint,
              tokenSymbol: pos.symbol,
              tokenQuantity: sellQty,
              tokenDecimals: resolvedDecimals,
              maxSlippageBps: exitSlippageBps,
              priorityFeeLevel: 'high',
              solPriceUsd: effectiveSolPx ?? undefined,
              jupiterApiKey: c.jupiter_api_key || undefined,
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
            const prep = await prepareLiveSellTransaction({
              userPublicKey: liveWallet.address,
              tokenAddress: mint,
              tokenSymbol: pos.symbol,
              tokenQuantity: sellQty,
              tokenDecimals: resolvedDecimals,
              maxSlippageBps: exitSlippageBps,
              priorityFeeLevel: 'high',
              jupiterApiKey: c.jupiter_api_key || undefined,
            });
            if (!prep.success || !prep.base64Tx) {
              const wroteOff = await handleFailedSellAttempt(prep.error || 'No swap route');
              if (!wroteOff) return false;
              liveRes = { success: true, _writeOff: true };
            } else {
              const sigRes = await requestBrowserWalletSignature(
                {
                  action: 'SELL',
                  symbol: pos.symbol,
                  mint,
                  base64Tx: prep.base64Tx,
                  userPublicKey: liveWallet.address,
                },
                {
                  action: 'SELL',
                  symbol: pos.symbol,
                  mint,
                  userPublicKey: liveWallet.address,
                  tradeSol: pos.cost_sol || 0,
                  tradeUsd: pos.cost,
                  solPriceUsd: effectiveSolPx,
                  url: pos.url,
                  dex: pos.dex,
                  source: pos.source,
                  age_s: pos.age_at_entry,
                  decimals: resolvedDecimals,
                  exit_params: pos.exit_params || snapshotExitParams(c),
                  trade_id: pos.trade_id || `trd_${pos.opened}`,
                }
              );
              if (!sigRes.signature) {
                sniperLog(`✗ [LIVE SELL CANCELLED] ${pos.symbol}: ${sigRes.error}`, 'warn');
                return false;
              }
              liveRes = await finalizeBrowserSignedTransaction({
                signature: sigRes.signature,
                targetMint: mint,
                userPubkey: liveWallet.address,
                isBuy: false,
                estSolReceived: prep.estSolReceived,
                tokenQuantity: sellQty,
                solPriceUsd: effectiveSolPx ?? undefined,
              });
            }
          }

          if (!liveRes?._writeOff) {
            if (!liveRes?.success) {
              const wroteOff = await handleFailedSellAttempt(liveRes?.error || 'Live swap failed');
              if (!wroteOff) return false;
            } else {
              broadcastSse('execution_progress', {
                action: 'SELL',
                token: pos.symbol,
                step: 'CONFIRMED',
                detail: `Tx ${liveRes.signature?.slice(0, 8)}`,
              });
              const actualSol = liveRes.actualAmountOut ?? 0;
              exactProceedsSol = actualSol;
              proceeds = effectiveSolPx ? actualSol * effectiveSolPx : 0;
              fill = sellQty > 0 && proceeds > 0 ? proceeds / sellQty : liveRes.actualEffectivePriceUsd || 0;
              sellBaseFeeSol = liveRes.baseFeeSol || 0;
              sellPriorityFeeSol = liveRes.priorityFeeSol || 0;
              sellRentPaidSol = liveRes.rentPaidSol || 0;
              sellRentReclaimedSol = liveRes.rentReclaimedSol || 0;
              txHash = liveRes.signature;
              explorerUrl = liveRes.explorerUrl;
              isEstimated = !txHash;
            }
          }
        }
      }
    } else {
      ledger.cash += proceeds;
      isEstimated = false;
    }

    const solPriceNow = await getSolPriceUsd();
    const validSolPx = solPriceNow && solPriceNow > 0 ? solPriceNow : null;
    const costSol = pos.cost_sol ?? (validSolPx ? pos.cost / validSolPx : 0);
    const proceedsSol =
      exactProceedsSol !== undefined
        ? exactProceedsSol
        : validSolPx
        ? proceeds / validSolPx
        : 0;

    const totalTxFeesSol = (pos.buy_base_fee_sol || 0) + (pos.buy_priority_fee_sol || 0) + sellBaseFeeSol + sellPriorityFeeSol;
    const netRentSol = Math.max(0, (pos.buy_rent_paid_sol || 0) + sellRentPaidSol - sellRentReclaimedSol);
    const netPnlSol = proceedsSol - costSol - totalTxFeesSol - netRentSol;
    const netPnlUsd =
      mode === 'live' && validSolPx
        ? netPnlSol * validSolPx
        : proceeds - pos.cost;
    const pnlPct =
      mode === 'live' && costSol > 0
        ? (netPnlSol / costSol) * 100
        : pos.cost > 0
        ? (netPnlUsd / pos.cost) * 100
        : 0;

    if (mode === 'live' && !txHash && effectiveReason !== 'WRITE_OFF_UNSELLABLE') {
      isEstimated = true;
    }

    delete ledger.positions[mint];
    rollDay(ledger);
    ledger.day_pnl += netPnlUsd;
    ledger.total_pnl += netPnlUsd;
    ledger.closed += 1;
    if (netPnlUsd > 0 && effectiveReason !== 'WRITE_OFF_UNSELLABLE') {
      ledger.wins += 1;
    }

    const tradeId = pos.trade_id || `trd_${pos.opened}_${mint.slice(0, 6)}`;
    const tradeRow: SniperTradeRow = {
      id: `trd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      trade_id: tradeId,
      mode,
      time: new Date().toISOString(),
      action: 'SELL',
      symbol: pos.symbol,
      mint,
      price: fill,
      usd: proceeds,
      sol_amount: Math.round(proceedsSol * 1e6) / 1e6,
      sol_spent: Math.round(costSol * 1e6) / 1e6,
      sol_received: Math.round(proceedsSol * 1e6) / 1e6,
      base_fee_sol: sellBaseFeeSol,
      priority_fee_sol: sellPriorityFeeSol,
      rent_paid_sol: Math.max(0, sellRentPaidSol - sellRentReclaimedSol),
      pnl_usd: Math.round(netPnlUsd * 10000) / 10000,
      pnl_sol: Math.round(netPnlSol * 1e6) / 1e6,
      net_pnl_sol: Math.round(netPnlSol * 1e6) / 1e6,
      net_pnl_usd: Math.round(netPnlUsd * 10000) / 10000,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      estimated: isEstimated,
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
      `✗ SELL ${pos.symbol} @ $${fmtPrice(fill)} net pnl ${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(4)} SOL ($${netPnlUsd.toFixed(2)} / ${pnlPct.toFixed(1)}%)${isEstimated ? ' [est.]' : ''} [${effectiveReason}]${txHash ? ` (tx: ${txHash.slice(0, 8)}...)` : ''}`,
      'sell'
    );
    saveStateToDisk();
    broadcastSse('trade_event', { action: 'SELL', mode, mint });
    return true;
  } finally {
    inFlightSells.delete(mint);
  }
}

const _reconciledExternalTradeIds = new Set<string>();
let _reconcileRunning = false;

async function reconcileExternalSells(ownerAddr: string): Promise<void> {
  if (!ownerAddr || _reconcileRunning) return;
  _reconcileRunning = true;
  try {
    const ledger = ledgers.live;
    if (!ledger || !Array.isArray(ledger.trades) || ledger.trades.length === 0) return;

    const candidates = ledger.trades.filter(
      (t) =>
        t.action === 'SELL' &&
        typeof t.reason === 'string' &&
        t.reason.startsWith('sold_externally') &&
        !t.tx_hash &&
        !_reconciledExternalTradeIds.has(t.id)
    );
    if (candidates.length === 0) return;

    const solPriceUsd = await getSolPriceUsd();
    if (!solPriceUsd || solPriceUsd <= 0) return;
    let changed = false;

    const localDay = (isoOrMs: string | number) => {
      const d = new Date(isoOrMs);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    for (const sellRow of candidates) {
      _reconciledExternalTradeIds.add(sellRow.id);
      const sellMs = Date.parse(sellRow.time) || Date.now();
      const buyRow = ledger.trades.find(
        (b) => b.action === 'BUY' && b.mint === sellRow.mint && (Date.parse(b.time) || 0) <= sellMs
      );
      const buyMs = buyRow ? Date.parse(buyRow.time) || 0 : Math.max(0, sellMs - 3600_000);
      const ext = await findExternalSellOnChain(ownerAddr, sellRow.mint, buyMs);
      if (!ext.found || ext.actualSolReceived === undefined) continue;

      const costSol =
        buyRow?.sol_spent ??
        buyRow?.sol_amount ??
        (buyRow ? buyRow.usd / solPriceUsd : 0);
      const oldPnlUsd = sellRow.net_pnl_usd ?? sellRow.pnl_usd ?? 0;
      const oldDay = localDay(sellRow.time);
      const newSolAmt = ext.actualSolReceived;
      const newUsd = newSolAmt * solPriceUsd;
      const totalFees =
        (buyRow?.base_fee_sol || 0) +
        (buyRow?.priority_fee_sol || 0) +
        (ext.baseFeeSol || 0) +
        (ext.priorityFeeSol || 0);
      const netRent = Math.max(0, (buyRow?.rent_paid_sol || 0) - (ext.ataRentReclaimedSol || 0));
      const newPnlSol = newSolAmt - costSol - totalFees - netRent;
      const newPnlUsd = newPnlSol * solPriceUsd;
      const newPnlPct = costSol > 0 ? (newPnlSol / costSol) * 100 : 0;

      sellRow.sol_amount = Math.round(newSolAmt * 1e6) / 1e6;
      sellRow.sol_received = Math.round(newSolAmt * 1e6) / 1e6;
      sellRow.usd = Math.round(newUsd * 10000) / 10000;
      if (ext.tokensSold && ext.tokensSold > 0) {
        sellRow.price = newUsd / ext.tokensSold;
      }
      sellRow.base_fee_sol = ext.baseFeeSol || 0;
      sellRow.priority_fee_sol = ext.priorityFeeSol || 0;
      sellRow.rent_paid_sol = 0;
      sellRow.pnl_sol = Math.round(newPnlSol * 1e6) / 1e6;
      sellRow.pnl_usd = Math.round(newPnlUsd * 10000) / 10000;
      sellRow.net_pnl_sol = Math.round(newPnlSol * 1e6) / 1e6;
      sellRow.net_pnl_usd = Math.round(newPnlUsd * 10000) / 10000;
      sellRow.pnl_pct = Math.round(newPnlPct * 100) / 100;
      sellRow.estimated = false;
      sellRow.tx_hash = ext.signature;
      sellRow.explorer_url = ext.explorerUrl;
      if (ext.blockTimeMs) {
        sellRow.time = new Date(ext.blockTimeMs).toISOString();
      }

      ledger.total_pnl += newPnlUsd - oldPnlUsd;
      const newDay = localDay(sellRow.time);
      if (oldDay === ledger.day) ledger.day_pnl -= oldPnlUsd;
      if (newDay === ledger.day) ledger.day_pnl += newPnlUsd;
      if (oldPnlUsd <= 0 && newPnlUsd > 0) {
        ledger.wins = Math.min(ledger.closed, ledger.wins + 1);
      } else if (oldPnlUsd > 0 && newPnlUsd <= 0) {
        ledger.wins = Math.max(0, ledger.wins - 1);
      }

      changed = true;
      sniperLog(
        `✓ [RECONCILED] ${sellRow.symbol} external sell matched on-chain (${ext.signature?.slice(0, 8)}...): ${newSolAmt.toFixed(4)} SOL`,
        'info'
      );
    }

    if (changed) {
      saveStateToDisk();
      broadcastSse('trade_event', { action: 'RECONCILE', mode: 'live' });
    }
  } finally {
    _reconcileRunning = false;
  }
}

export async function checkExits(
  mode: ExecutionMode,
  prices: Map<string, number>,
  liquidities: Map<string, number> = new Map()
): Promise<number> {
  const ledger = ledgers[mode];
  const cfg = botConfig;
  let exits = 0;

  for (const [mint, pos] of Object.entries(ledger.positions)) {
    // Respect retry backoff when a live sell is failing temporarily
    if (pos.next_sell_retry_at && Date.now() < pos.next_sell_retry_at) {
      continue;
    }

    // Fix 4: Always read per-position exit params snapshotted at entry
    const ep: PositionExitParams = pos.exit_params || snapshotExitParams(cfg);
    const tp = ep.take_profit_pct ?? 35;
    const trail = ep.trailing_stop_pct ?? 0;
    const sl = ep.stop_loss_pct ?? 20;
    const rugDrop = ep.rug_exit_drop_pct ?? 75;
    const maxHoldMin = ep.max_hold_minutes ?? 60;

    const price = prices.get(mint);
    const heldMin = (Date.now() - pos.opened) / 60000;
    const lastSeen = pos.last_seen_price_at || pos.opened;
    const staleMin = (Date.now() - lastSeen) / 60000;
    const liq = liquidities.get(mint) ?? pos.last_liquidity_usd;

    if (rugDrop > 0 && liq !== undefined && liq < 50 && (liq < 10 || heldMin >= 0.08)) {
      const exitPx = price ?? 0;
      const ok = await executeSell(mode, mint, exitPx, 'rug_liquidity_pulled');
      if (ok) exits += 1;
      continue;
    }

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
    } else if (trail > 0 && peakChg >= Math.min(tp > 0 ? tp : 20, 20) && (pos.peak_price / price - 1) * 100 >= trail) {
      reason = `trailing_stop_${trail}`;
    } else if (tp > 0 && change >= tp && trail <= 0) {
      reason = `take_profit_${tp}`;
    } else if (rugDrop > 0 && change <= -rugDrop) {
      reason = `rug_drop_${rugDrop}`;
    } else if (sl > 0 && change <= -sl) {
      reason = `stop_loss_${sl}`;
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
    `scan summary (60s): sources[${srcBits.join(' ') || 'none'}] new-mints=${cands} not-on-jupiter=${noPair} evaluated=${checked} rejected[${rejTxt || '-'}] rug=${rug} BOUGHT=${bought}`,
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

  const scanBatch = fresh.slice(0, 60);
  const nowMs = Date.now();
  const pairs = new Map<string, [number, any]>();
  for (let i = 0; i < scanBatch.length; i += 30) {
    if (currentLifecycleState !== 'RUNNING') return;
    const chunk = scanBatch.slice(i, i + 30);
    const data = await fetchJupiterPairSnapshots(chunk, botConfig);
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
  _stats.no_pair += Math.max(0, scanBatch.length - pairs.size);

  const ledger = ledgers[mode];
  const candidates: Array<{ mint: string; symbol: string; price: number; score: number; pair: any; ageS: number; meta: any }> = [];

  for (const [mint, [, pair]] of pairs.entries()) {
    if (currentLifecycleState !== 'RUNNING') break;
    if (ledger.positions[mint] || ledger.blacklist.includes(mint)) continue;
    if (Array.isArray(ledger.attempted_mints) && ledger.attempted_mints.includes(mint)) continue;

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

    const price = _f(pair?.priceUsd);
    if (price === null || price <= 0) continue;

    const ageS = Math.max(0.0, (nowMs - Number(pair?.pairCreatedAt || 0)) / 1000.0);
    const [rok, rwhy] = await hardRugCheck(mint, botConfig, ageS, {
      tokenPriceUsd: price,
      decimals: pair?.baseToken?.decimals,
    });
    if (!rok) {
      _stats.rug += 1;
      sniperLog(`✗ RUG REJECT ${symbol}: ${rwhy}`, 'reject');
      noteRejected(mode, mint);
      continue;
    }

    const liq = _f(pair?.liquidity?.usd) || 0;
    const m5 = pair?.txns?.m5 || {};
    const buys = Number(m5.buys || 0);
    const sells = Number(m5.sells || 0);
    const buyVol = _f(pair?.volume?.m5) || 0;
    const holders = _f(pair?.holderCount) || 10;
    const m5c = _f(pair?.priceChange?.m5) || 0;

    const score =
      liq * 0.2 +
      buyVol * 0.4 +
      holders * 3.0 +
      (buys - sells) * 15 +
      (m5c > 0 && m5c <= 150 ? 100 : m5c > 150 ? 20 : -50);

    const meta = {
      dex: pair?.dexId || '?',
      source: _srcOf.get(mint) || '?',
      age_s: ageS,
      decimals: pair?.baseToken?.decimals || 6,
    };

    candidates.push({ mint, symbol, price, score, pair, ageS, meta });
  }

  if (candidates.length === 0) return;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!canOpenPosition(mode).allowed) return;

  sniperLog(
    `🏆 Best candidate selected: ${best.symbol} (score: ${best.score.toFixed(1)}, liq: $${(_f(best.pair?.liquidity?.usd) || 0).toFixed(0)}, h: ${_f(best.pair?.holderCount) || '?'})`,
    'buy'
  );
  const bought = await executeBuy(mode, best.mint, best.symbol, best.price, best.pair?.url, best.meta);
  if (bought) _stats.bought += 1;
}

let _lastJupPriceCache: {
  key: string;
  ts: number;
  map: Map<string, number>;
  liqs: Map<string, number>;
  dead: Set<string>;
} | null = null;

async function fetchJupiterPrices(
  mints: string[],
  cfg: SniperConfig,
  outLiquidities?: Map<string, number>,
  outDeadMints?: Set<string>
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (!cfg.use_jupiter_price || mints.length === 0) return prices;
  const now = Date.now();
  const key = [...mints].sort().join(',');
  if (_lastJupPriceCache && _lastJupPriceCache.key === key && now - _lastJupPriceCache.ts < 2500) {
    if (outLiquidities) for (const [m, l] of _lastJupPriceCache.liqs.entries()) outLiquidities.set(m, l);
    if (outDeadMints) for (const m of _lastJupPriceCache.dead) outDeadMints.add(m);
    return new Map(_lastJupPriceCache.map);
  }
  if (now < _jupRateLimitUntil || now < _swapPriorityUntil) {
    if (_lastJupPriceCache) {
      if (outLiquidities) for (const [m, l] of _lastJupPriceCache.liqs.entries()) outLiquidities.set(m, l);
      if (outDeadMints) for (const m of _lastJupPriceCache.dead) outDeadMints.add(m);
      return new Map(_lastJupPriceCache.map);
    }
    return prices;
  }
  const hdrs = cfg.jupiter_api_key ? { 'x-api-key': cfg.jupiter_api_key } : undefined;
  const data = await getJson(JUP_PRICE, { ids: mints.join(',') }, 4000, hdrs);
  if (!data || typeof data !== 'object') return prices;
  const liqs = new Map<string, number>();
  const dead = new Set<string>();
  for (const [mint, quote] of Object.entries<any>(data)) {
    const p = _f(quote?.usdPrice);
    const liq = _f(quote?.liquidity);
    const chg24 = _f(quote?.priceChange24h);
    if (liq !== null) {
      liqs.set(mint, liq);
      outLiquidities?.set(mint, liq);
    }
    if (p !== null) {
      prices.set(mint, p);
    } else if ((liq !== null && liq < 50) || (chg24 !== null && chg24 <= -95 && (liq === null || liq < 100))) {
      dead.add(mint);
      outDeadMints?.add(mint);
    }
  }
  if (prices.size > 0 || liqs.size > 0 || dead.size > 0) {
    _lastJupPriceCache = { key, ts: Date.now(), map: new Map(prices), liqs, dead };
  }
  return prices;
}

let _lastLiveBalSyncAt = 0;

async function monitorPositions() {
  const mode = botConfig.EXECUTION_MODE;
  const ledger = ledgers[mode];

  if (mode === 'live') {
    await reconcilePendingBuys().catch(() => {});
  }

  const mints = Object.keys(ledger.positions);
  if (mints.length === 0) return;

  const liquidities = new Map<string, number>();
  const deadMints = new Set<string>();
  const prices = await fetchJupiterPrices(mints, botConfig, liquidities, deadMints);

  for (const [m, liq] of liquidities.entries()) {
    if (ledger.positions[m]) {
      ledger.positions[m].last_liquidity_usd = liq;
    }
  }

  const needDex = mints.filter((m) => {
    const px = prices.get(m);
    if (px === undefined || px <= 0) return true;
    const liq = liquidities.get(m);
    if (liq !== undefined && liq < 100) return true;
    const pos = ledger.positions[m];
    return pos && pos.entry_price > 0 && (px / pos.entry_price - 1) * 100 <= -40;
  });

  for (let i = 0; i < needDex.length; i += 30) {
    const chunk = needDex.slice(i, i + 30);
    const data = await fetchJupiterPairSnapshots(chunk, botConfig, { priority: true, bypassCache: true });
    if (Array.isArray(data)) {
      for (const p of data) {
        const mint = p?.baseToken?.address;
        if (!mint || !ledger.positions[mint]) continue;
        const liq = _f(p?.liquidity?.usd);
        if (liq !== null) {
          liquidities.set(mint, liq);
          ledger.positions[mint].last_liquidity_usd = liq;
        }
        if (!prices.has(mint)) {
          const px = _f(p?.priceUsd);
          if (px !== null) prices.set(mint, px);
        }
      }
    }
  }

  for (const m of mints) {
    const liq = liquidities.get(m);
    if ((deadMints.has(m) || (liq !== undefined && liq < 10)) && !prices.has(m)) {
      prices.set(m, 0);
      livePrices.set(m, 0);
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

  // Fix 6: Reconcile tokens sold manually outside the bot using THREE zero reads across TWO RPCs + on-chain proof
  if (mode === 'live' && Date.now() - _lastLiveBalSyncAt >= 15_000) {
    _lastLiveBalSyncAt = Date.now();
    const ownerAddr =
      getTradingKeypair()?.publicKey.toBase58() ||
      getLiveConnectedWallet(botConfig.DEFAULT_CHAIN || 'solana')?.address ||
      null;
    if (ownerAddr) {
      for (const mint of Object.keys(ledger.positions)) {
        const pos = ledger.positions[mint];
        if (!pos || pos.needs_review || Date.now() - pos.opened < 25_000) continue;
        const twoRpcCheck = await checkZeroBalanceAcrossTwoRpcs(ownerAddr, mint);
        if (twoRpcCheck.status === 'NON_ZERO') {
          pos.zero_bal_checks = 0;
        } else if (twoRpcCheck.status === 'ZERO') {
          pos.zero_bal_checks = (pos.zero_bal_checks || 0) + 1;
          if (pos.zero_bal_checks >= 3) {
            await executeSell(mode, mint, prices.get(mint) ?? livePrices.get(mint) ?? 0, 'sold_externally');
          }
        }
      }
    }
  }
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
    push('probe: 0 candidates -> all sources returned nothing (internet / rate limit?)');
    return lines;
  }

  const nowMs = Date.now();
  let shown = 0;

  for (let i = 0; i < cands.length; i += 30) {
    const chunk = cands.slice(i, i + 30);
    const data = await fetchJupiterPairSnapshots(chunk, botConfig, { priority: true });
    const plist = Array.isArray(data) ? data : [];
    if (plist.length === 0) {
      push(`probe: no token data on Jupiter tokens/v2 for ${chunk.length} mints (too new / not indexed yet)`);
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
      const tag = ok ? 'WOULD BUY -> rug check' : `filtered: ${code} (${detail})`;
      const holders = _f(p?.holderCount);
      push(
        `probe: ${sym} ${dex} age=${(age / 60).toFixed(1)}m liq=$${liq.toFixed(0)} ${buys}b/${sells}s h=${holders !== null ? holders : '?'} m5=${chg !== null ? chg : '?'}% -> ${tag}`
      );
      shown += 1;
      if (shown >= 25) {
        push('probe: (first 25 shown)');
        return lines;
      }
    }
  }

  if (shown === 0) {
    push('probe: 0 tokens found on Jupiter tokens/v2 for current candidates.');
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
    `Sources: gecko=${botConfig.use_gecko} jupiter=${botConfig.use_jupiter_recent} profiles=${botConfig.use_dex_profiles} boosts=${botConfig.use_promoted_feeds}`,
    'info',
    'STATE_CHANGE'
  );
  sniperLog(
    `Window: ${botConfig.min_age_minutes}m to ${botConfig.max_age_minutes}m old | TP ${botConfig.take_profit_pct}% | SL ${botConfig.stop_loss_pct}% | RugExit ${botConfig.rug_exit_drop_pct}% | Trail ${botConfig.trailing_stop_pct}% | minLiq $${botConfig.min_liquidity_usd.toFixed(0)} | rug check ${botConfig.use_rugcheck ? 'ON' : 'OFF'}`,
    'info',
    'STATE_CHANGE'
  );
  if (botConfig.EXECUTION_MODE === 'live') {
    const kpAddr = getTradingKeypair()?.publicKey.toBase58();
    sniperLog(
      kpAddr
        ? `Live signing: Autonomous server signer (${kpAddr.slice(0, 6)}...${kpAddr.slice(-4)}) active.`
        : 'Live signing: no server signer loaded.',
      kpAddr ? 'info' : 'warn',
      'STATE_CHANGE'
    );
  }
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
  stopPumpPortalStream();
  saveStateToDisk();
  sniperLog('Bot stopped.', 'warn', 'STATE_CHANGE');
  broadcastSse('status', botStatus);
}

// ---------------- ACCOUNT RESET (PRESERVES LIVE LEDGER & LIVE CSV HISTORY) ----------------
export function resetAccountPreservingLive(): { ok: boolean; error?: string } {
  if (currentLifecycleState === 'RUNNING') {
    return { ok: false, error: "Stop the bot first: press 'Stop bot', then reset the paper account." };
  }
  const solPx = cachedSolPrice.price;
  const resetBalUsd =
    botConfig.sizing_basis === 'sol' && (botConfig.start_balance_sol ?? 0) > 0 && solPx && solPx > 0
      ? botConfig.start_balance_sol * solPx
      : botConfig.start_balance_usd;
  ledgers.paper = createEmptyLedger(resetBalUsd);
  ledgers.testnet = createEmptyLedger(resetBalUsd);
  livePrices.clear();
  rewriteCsvWithLiveTrades();
  saveStateToDisk();
  sniperLog('Paper account reset (Live ledger and Live CSV trades preserved).', 'info', 'ACCOUNT_RESET');
  return { ok: true };
}

// ---------------- VIEW BUILDERS ----------------
export function buildPositionRows(mode: ExecutionMode, solPriceUsd: number | null = cachedSolPrice.price) {
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
    const costSol = p.cost_sol ?? (solPriceUsd && solPriceUsd > 0 ? p.cost / solPriceUsd : 0);
    const valueSol = value !== null && solPriceUsd && solPriceUsd > 0 ? value / solPriceUsd : null;
    const pnlSol = pnlUsd !== null && solPriceUsd && solPriceUsd > 0 ? pnlUsd / solPriceUsd : null;
    const peak = p.entry_price > 0 ? ((p.peak_price || p.entry_price) / p.entry_price - 1) * 100 : 0;
    const low = p.entry_price > 0 ? ((p.low_price || p.entry_price) / p.entry_price - 1) * 100 : 0;
    const heldMin = (nowMs - p.opened) / 60000;
    return {
      trade_id: p.trade_id,
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
      exit_params: p.exit_params,
      needs_review: Boolean(p.needs_review),
      needs_review_reason: p.needs_review_reason,
    };
  });
}

export function buildPortfolioStats(mode: ExecutionMode, solPriceUsd: number | null = cachedSolPrice.price) {
  const ledger = ledgers[mode] || ledgers.paper;
  rollDay(ledger);
  const rows = buildPositionRows(mode, solPriceUsd);
  const openPnl = rows.reduce((sum, r) => sum + (r.pnl_usd ?? 0), 0);
  const openValue = rows.reduce((sum, r) => sum + (r.value ?? r.cost), 0);
  const wins = ledger.wins;
  const closed = ledger.closed;

  let cash = ledger.cash;
  let cashSol = solPriceUsd && solPriceUsd > 0 ? cash / solPriceUsd : 0;
  if (mode === 'live') {
    const liveWallet = getLiveConnectedWallet(botConfig.DEFAULT_CHAIN || 'solana');
    cashSol = liveWallet && liveWallet.is_connected ? liveWallet.raw_balance_num || 0 : 0;
    const parsedUsd = liveWallet && liveWallet.is_connected ? parseFloat(liveWallet.balance_usd.replace(/[^0-9.]/g, '')) || 0 : 0;
    cash = cashSol > 0 && solPriceUsd && solPriceUsd > 0 ? cashSol * solPriceUsd : parsedUsd;
  }

  const totalValueUsd = cash + openValue;
  const valueSol = solPriceUsd && solPriceUsd > 0 ? totalValueUsd / solPriceUsd : 0;
  const openPnlSol = solPriceUsd && solPriceUsd > 0 ? openPnl / solPriceUsd : 0;
  const dayPnlSol = solPriceUsd && solPriceUsd > 0 ? ledger.day_pnl / solPriceUsd : 0;
  const totalPnlSol = solPriceUsd && solPriceUsd > 0 ? ledger.total_pnl / solPriceUsd : 0;

  return {
    mode,
    sol_price_usd: solPriceUsd,
    sol_price_available: Boolean(solPriceUsd && solPriceUsd > 0),
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
    pending_buys_count: (ledger.pending_buys || []).filter((p) => p.status === 'PENDING').length,
    day: ledger.day,
  };
}

// ---------------- EXPRESS SERVER FACTORY ----------------
export async function createAppServer(opts: { attachVite?: boolean } = {}) {
  const apiToken = ensureApiToken();
  ensureTradesLogFile();
  loadSettingsFromDisk();
  loadStateFromDisk();
  auditAndLoadSignerDiskState();

  const restoredKp = getTradingKeypair();
  if (restoredKp && !getLiveConnectedWallet('solana')) {
    queryOnChainBalance('solana', restoredKp.publicKey.toBase58())
      .then((bal) => {
        registerLiveWallet(
          'solana',
          restoredKp.publicKey.toBase58(),
          'Solana Trading Keypair',
          bal.formatted_balance,
          bal.formatted_usd,
          'keypair',
          true,
          'Solana Mainnet-Beta',
          bal.rpc_endpoint
        );
      })
      .catch(() => {});
  }
  if (restoredKp) {
    setTimeout(() => {
      reconcileExternalSells(restoredKp.publicKey.toBase58()).catch(() => {});
    }, 1500);
  }

  sniperLog("Window ready. Press 'Start bot' to begin trading.", 'info', 'SYSTEM_INIT');

  const app = express();
  app.use(express.json());

  // Fix 10: API Token auth middleware on all mutating /api/* routes + /api/trading-signer
  app.use('/api', (req, res, next) => {
    const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
    const isSignerRead = req.path === '/trading-signer' || req.path.startsWith('/trading-signer/');
    if (!isMutating && !isSignerRead) {
      return next();
    }
    const provided = String(req.headers['x-api-token'] || '');
    const a = Buffer.from(provided);
    const b = Buffer.from(apiToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-token header' });
    }
    return next();
  });

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
      config: {
        ...botConfig,
        jupiter_api_key: botConfig.jupiter_api_key
          ? `${botConfig.jupiter_api_key.slice(0, 2)}***${botConfig.jupiter_api_key.slice(-2)}`
          : '',
      },
      status: {
        ...botStatus,
        lifecycle_state: currentLifecycleState,
      },
      portfolio: buildPortfolioStats(mode, solPriceUsd),
      sol_price_usd: solPriceUsd,
      live_wallet: liveWallet,
      pending_buys: (ledgers[mode]?.pending_buys || []).filter((p) => p.status === 'PENDING'),
      last_confirmed_live_risk: lastConfirmedLiveRisk,
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
      const ds = await fetchJupiterPairSnapshots([mint], botConfig, { priority: true });
      if (Array.isArray(ds) && ds[0]?.priceUsd) price = _f(ds[0].priceUsd) ?? undefined;
    }
    const reason = !price || price <= 0 ? 'manual_no_price_writeoff' : 'manual';
    const finalPrice = !price || price <= 0 ? 0 : price;

    const ok = await executeSell(mode, mint, finalPrice, reason);
    if (!ok) {
      return res.status(400).json({ error: 'Could not close position yet (see Scan log for retry/review status).' });
    }
    res.json({ success: true, message: mode === 'live' ? 'Sold / cleared (live).' : 'Sold / cleared (paper trade).' });
  });

  app.post('/api/positions/:mint/manual-clear', async (req, res) => {
    const mode = botConfig.EXECUTION_MODE;
    const mint = req.params.mint;
    const ledger = ledgers[mode];
    const pos = ledger.positions[mint];
    if (!pos) {
      return res.status(404).json({ error: 'Position not found.' });
    }
    const price = livePrices.get(mint) ?? 0;
    const ok = await executeSell(mode, mint, price, 'manual_review_cleared');
    if (!ok) {
      return res.status(500).json({ error: 'Failed to manually clear position.' });
    }
    res.json({ success: true, message: 'Position manually cleared and flagged as estimated.' });
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
        const ds = await fetchJupiterPairSnapshots([mint], botConfig, { priority: true });
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

  // Fix 9: Emergency Kill Switch (immediately stops bot and attempts high-slippage exit of all open positions)
  app.post('/api/kill', async (_req, res) => {
    stopBotEngine();
    sniperLog('🛑 [KILL SWITCH ACTIVATED] Bot stopped immediately; attempting emergency exit of all open positions.', 'warn', 'KILL_SWITCH');
    const mode = botConfig.EXECUTION_MODE;
    const ledger = ledgers[mode];
    const mints = Object.keys(ledger.positions);
    let closedCount = 0;
    for (const mint of mints) {
      const price = livePrices.get(mint) ?? 0;
      const ok = await executeSell(mode, mint, price, 'kill_switch');
      if (ok) closedCount += 1;
    }
    broadcastSse('status', botStatus);
    res.json({ success: true, stopped: true, closed_positions: closedCount, remaining_positions: Object.keys(ledger.positions).length });
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
    const result = validateAndApplySettings(req.body || {});
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    broadcastSse('status', botStatus);
    res.json({ success: true, config: botConfig, changes: result.changes });
  });

  // ---------------- CONTROL & PROBE ----------------
  app.post('/api/control', async (req, res) => {
    const { action } = req.body || {};
    switch (action) {
      case 'start_bot': {
        const liveCheck = validateLiveStart();
        if (!liveCheck.ok) {
          return res.status(400).json({ error: liveCheck.error });
        }
        startBotEngine();
        break;
      }
      case 'stop_bot': {
        stopBotEngine();
        break;
      }
      case 'scan_once': {
        const liveCheck = validateLiveStart();
        if (!liveCheck.ok) {
          return res.status(400).json({ error: liveCheck.error });
        }
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
        const resetRes = resetAccountPreservingLive();
        if (!resetRes.ok) {
          return res.status(400).json({ error: resetRes.error });
        }
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
    const resetRes = resetAccountPreservingLive();
    if (!resetRes.ok) {
      return res.status(400).json({ error: resetRes.error });
    }
    res.json({ success: true });
  });

  // ---------------- WALLET & SIGNER ROUTES ----------------
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
        : solPrice && solPrice > 0
        ? botConfig.trade_size_usd / solPrice
        : 0;
    const minGasReserve = botConfig.MIN_GAS_RESERVE_SOL;
    const minRequired = tradeSol + minGasReserve;
    const currentBal = live ? live.raw_balance_num : 0;
    const hasServerSigner = Boolean(getTradingKeypair());

    let readinessStatus = 'READY_PAPER';
    let readinessReason = `Running in ${mode.toUpperCase()} mode. Simulated account active.`;

    if (mode === 'live') {
      if (!hasServerSigner) {
        readinessStatus = 'SIGNER_REQUIRED';
        readinessReason =
          'Autonomous server-side signer required for Live exits (browser popups cannot automate stop-loss or rug exits).';
      } else if (!live || !live.is_connected || !live.address) {
        readinessStatus = 'DISCONNECTED';
        readinessReason = 'No verified live wallet connected for SOLANA.';
      } else if (currentBal < minRequired) {
        readinessStatus = 'INSUFFICIENT_FUNDS';
        readinessReason = `On-chain balance (${currentBal.toFixed(5)} SOL) is below trade size (~${tradeSol.toFixed(4)} SOL) + gas reserve (${minGasReserve} SOL).`;
      } else {
        readinessStatus = 'LIVE_READY';
        readinessReason = `Server-side signer ready (${currentBal.toFixed(5)} SOL) for live sniper execution.`;
      }
    }

    res.json({
      mode,
      chain,
      is_live: mode === 'live',
      has_server_signer: hasServerSigner,
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
    if (chain === 'solana') {
      reconcileExternalSells(address).catch(() => {});
    }

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
      const solPx = await getSolPriceUsd();
      res.json(
        await getTradingSignerStatus(solPx, {
          encryptedOnDisk: encryptedSignerOnDisk,
          locked: encryptedSignerOnDisk && !getTradingKeypair(),
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/trading-signer', async (req, res) => {
    const { secretKey, passphrase } = req.body || {};
    if (!secretKey) return res.status(400).json({ error: 'secretKey is required' });
    const result = setTradingKeypair(secretKey);
    if (!result.success) return res.status(400).json({ error: result.error });

    if (typeof passphrase === 'string' && passphrase.trim().length > 0) {
      saveEncryptedSignerToDisk(secretKey, passphrase.trim());
    } else {
      // Keep in process memory only — never write plaintext key to disk
      clearSignerFromDisk();
    }

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
      reconcileExternalSells(result.address).catch(() => {});
    }
    const solPx = await getSolPriceUsd();
    res.json({
      success: true,
      persistedEncrypted: Boolean(typeof passphrase === 'string' && passphrase.trim().length > 0),
      signer: await getTradingSignerStatus(solPx, {
        encryptedOnDisk: encryptedSignerOnDisk,
        locked: false,
      }),
    });
  });

  app.post('/api/trading-signer/unlock', async (req, res) => {
    const { passphrase } = req.body || {};
    if (!passphrase || typeof passphrase !== 'string') {
      return res.status(400).json({ error: 'passphrase is required' });
    }
    if (!fs.existsSync(SIGNER_FILE)) {
      return res.status(404).json({ error: 'No encrypted signer file found on disk.' });
    }
    try {
      const payload = JSON.parse(fs.readFileSync(SIGNER_FILE, 'utf-8'));
      const secretKey = decryptSignerPayload(payload, passphrase.trim());
      if (!secretKey) {
        return res.status(403).json({ error: 'Invalid passphrase.' });
      }
      const result = setTradingKeypair(secretKey);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
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
      const solPx = await getSolPriceUsd();
      res.json({
        success: true,
        signer: await getTradingSignerStatus(solPx, { encryptedOnDisk: true, locked: false }),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to decrypt signer.' });
    }
  });

  app.delete('/api/trading-signer', (_req, res) => {
    clearTradingKeypair();
    clearSignerFromDisk();
    disconnectLiveWallet('solana');
    res.json({ success: true, message: 'Trading signer cleared' });
  });

  app.post('/api/live-tx/:id/complete', (req, res) => {
    const id = req.params.id;
    const { signature, error } = req.body || {};
    const entry = pendingBrowserTxs.get(id);
    if (entry) {
      pendingBrowserTxs.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ signature, error });
      return res.json({ success: true });
    }

    // Fix 5: Reconcile browser-signed (Phantom) transactions approved after the 65s popup timeout
    const late = lateBrowserTxs.get(id);
    if (late) {
      lateBrowserTxs.delete(id);
      if (signature && late.action === 'BUY') {
        const ledger = ledgers.live;
        if (!ledger.pending_buys) ledger.pending_buys = [];
        ledger.pending_buys.push({
          mint: late.mint,
          symbol: late.symbol,
          signature,
          userPublicKey: late.userPublicKey,
          mode: 'live',
          trade_id: late.trade_id,
          startedAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          tradeSol: late.tradeSol,
          tradeUsd: late.tradeUsd,
          solPriceUsd: late.solPriceUsd,
          estTokensOut: late.estTokensOut,
          url: late.url,
          dex: late.dex,
          source: late.source,
          age_s: late.age_s,
          decimals: late.decimals,
          exit_params: late.exit_params,
          status: 'PENDING',
        });
        saveStateToDisk();
        sniperLog(
          `⏳ [LATE PHANTOM TX] ${late.symbol} signed after timeout (${signature.slice(0, 8)}...) — reconciling on-chain.`,
          'warn'
        );
        reconcilePendingBuys().catch(() => {});
        return res.json({ success: true, reconciled: 'pending' });
      }
      return res.json({ success: true, ignored: true });
    }

    return res.status(404).json({ error: 'Pending transaction expired or not found.' });
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
  const injectTokenMeta = (html: string) =>
    html.includes('name="sniper-api-token"')
      ? html
      : html.replace('</head>', `  <meta name="sniper-api-token" content="${apiToken}" />\n  </head>`);

  if (opts.attachVite !== false) {
    if (process.env.NODE_ENV === 'production') {
      const distDir = path.resolve(__dirname, 'dist');
      app.get(['/', '/index.html'], (_req, res) => {
        const html = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html').send(injectTokenMeta(html));
      });
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        const html = fs.readFileSync(path.resolve(distDir, 'index.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html').send(injectTokenMeta(html));
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
      app.get(['/', '/index.html'], async (req, res, next) => {
        try {
          const rawHtml = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
          const transformed = await vite.transformIndexHtml(req.originalUrl, rawHtml);
          res.status(200).setHeader('Content-Type', 'text/html').send(injectTokenMeta(transformed));
        } catch (e) {
          next(e);
        }
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}

export async function startServer() {
  const app = await createAppServer({ attachVite: true });
  const PORT = Number(process.env.PORT || 3000);
  const HOST = (process.env.HOST || '127.0.0.1').trim();
  const server = app.listen(PORT, HOST, () => {
    console.log(`◈ Solana Launch Sniper running at http://${HOST}:${PORT}`);
  });
  return { app, server };
}

const isTestEnv =
  Boolean(process.env.VITEST) ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.env.DISABLE_AUTO_START === '1';

if (!isTestEnv) {
  startServer().catch((err) => {
    console.error('Fatal startup error in server.ts:', err);
    process.exit(1);
  });
}
