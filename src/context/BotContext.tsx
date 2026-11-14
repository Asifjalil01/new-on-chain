import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { walletManager, WalletInfo, WalletId } from '../wallets/WalletManager';

export type SniperTabId = 'open_positions' | 'trade_history' | 'scan_log' | 'settings' | 'wallets';
export type ExecutionMode = 'paper' | 'testnet' | 'live';

export interface PositionRow {
  mint: string;
  symbol: string;
  entry: number;
  now: number | null;
  chg: number | null;
  pnl_usd: number | null;
  value: number | null;
  cost: number;
  peak: number;
  low: number;
  held: number;
  dex: string;
  source: string;
  age_at_entry: number;
  url: string;
  tx_hash_buy?: string;
  explorer_url?: string;
  mode: ExecutionMode;
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
  pnl_usd: number | null;
  pnl_pct: number | null;
  reason: string;
  dexscreener: string;
  age_s?: number;
  dex?: string;
  source?: string;
  tx_hash?: string;
  explorer_url?: string;
}

export interface SniperLog {
  id: string;
  timestamp: number;
  time_str: string;
  tag: 'buy' | 'sell' | 'reject' | 'warn' | 'summary' | 'info';
  type: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  line: string;
  message: string;
}

export interface PortfolioStats {
  mode: ExecutionMode;
  cash: number;
  value: number;
  open_pnl: number;
  day_pnl: number;
  total_pnl: number;
  closed: number;
  wins: number;
  win_rate_pct: number;
  winrate: string;
  open_positions_count: number;
  day: string;
}

export interface ExecutionProgressEvent {
  action: 'BUY' | 'SELL';
  token: string;
  step: string;
  detail?: string;
  error?: string;
  timestamp: number;
}

export interface SignerStatus {
  configured: boolean;
  address: string | null;
  balanceSol?: number;
  balanceUsd?: number;
}

export interface BotContextType {
  // Navigation
  currentTab: SniperTabId;
  navigateToTab: (tabId: SniperTabId) => void;

  // Bot & Telemetry
  status: any;
  botStatus: {
    lifecycle_state: string;
    is_running: boolean;
    last_price_time: number;
    started_at: number | null;
    scan_cycle_count: number;
  };
  config: Record<string, any>;
  portfolio: PortfolioStats;
  srcStats: Record<string, { items: number; ok_at: number }>;
  isBotStopped: boolean;
  lifecycleState: string;
  executionProgress: ExecutionProgressEvent | null;

  // Data Collections
  positions: PositionRow[];
  trades: SniperTradeRow[];
  logs: SniperLog[];
  wallets: any[];

  // Toast / Status message bar (gui.py self.msg)
  toastMessage: { text: string; tone: 'neutral' | 'success' | 'error' } | null;
  say: (text: string, tone?: 'neutral' | 'success' | 'error', ms?: number) => void;

  // Multi-Wallet & Live Signer
  activeWallet: WalletInfo;
  walletDiagnostics: any;
  signerStatus: SignerStatus | null;
  isWalletModalOpen: boolean;
  setIsWalletModalOpen: (open: boolean) => void;
  connectWallet: (id: WalletId) => Promise<boolean>;
  connectWatchOnlyAddress: (id: WalletId, address: string, name?: string) => Promise<boolean>;
  selectActiveWallet: (id: WalletId) => void;
  disconnectWallet: (id: WalletId) => void;
  refreshWalletBalance: () => Promise<void>;
  refreshSignerStatus: () => Promise<void>;
  saveTradingSigner: (secretKey: string) => Promise<{ success: boolean; error?: string }>;
  clearTradingSigner: () => Promise<boolean>;

  // Mode Switch
  isLiveConfirmOpen: boolean;
  setIsLiveConfirmOpen: (open: boolean) => void;
  requestModeChange: (targetMode: ExecutionMode) => Promise<void>;
  confirmLiveMode: () => Promise<boolean>;

  // Theme
  theme: 'dark' | 'light';
  toggleTheme: () => void;

  // Actions
  handleStartStop: () => Promise<void>;
  handleControlAction: (action: string) => Promise<{ success: boolean; error?: string; data?: any }>;
  handleSaveConfig: (newConfig: any) => Promise<{ success: boolean; error?: string }>;
  handleSellPosition: (mint: string) => Promise<boolean>;
  handleSellAll: () => Promise<boolean>;
  handleProbe: () => Promise<boolean>;
  handleResetAccount: () => Promise<boolean>;
  handleClearLogs: () => Promise<void>;
  refreshTelemetry: (includeLogs?: boolean) => Promise<void>;
  refreshTrades: () => Promise<void>;
}

const BotContext = createContext<BotContextType | null>(null);

const SAVED_TAB_KEY = 'sniper_active_tab_v1';
const THEME_KEY = 'onchain_spot_theme';

const VALID_TABS: SniperTabId[] = ['open_positions', 'trade_history', 'scan_log', 'settings', 'wallets'];

function mapHashToTab(raw: string): SniperTabId | null {
  const clean = raw.toLowerCase();
  if (clean === 'dashboard' || clean === 'open_positions') return 'open_positions';
  if (clean === 'history' || clean === 'trade_history') return 'trade_history';
  if (clean === 'scanner' || clean === 'scan_log' || clean === 'logs') return 'scan_log';
  if (clean === 'settings') return 'settings';
  if (clean === 'wallets') return 'wallets';
  return null;
}

const DEFAULT_PORTFOLIO: PortfolioStats = {
  mode: 'paper',
  cash: 50,
  value: 50,
  open_pnl: 0,
  day_pnl: 0,
  total_pnl: 0,
  closed: 0,
  wins: 0,
  win_rate_pct: 0,
  winrate: 'no closed trades',
  open_positions_count: 0,
  day: '',
};

const DEFAULT_CLIENT_CONFIG = {
  start_balance_usd: 50.0,
  trade_size_usd: 5.0,
  max_open_positions: 3,
  daily_loss_limit_usd: 10.0,
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
  EXECUTION_MODE: 'paper' as ExecutionMode,
  DEFAULT_CHAIN: 'solana',
  MAX_POSITION_SIZE_USD: 100.0,
  MIN_GAS_RESERVE_SOL: 0.01,
  PRIORITY_FEE_LEVEL: 'standard',
  THEME: 'dark',
};

export const BotProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // ---------------- NAVIGATION ----------------
  const getInitialTab = (): SniperTabId => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace(/^#\/?/, '').split('/')[0];
      const mapped = mapHashToTab(hash);
      if (mapped) return mapped;
      const saved = localStorage.getItem(SAVED_TAB_KEY);
      if (saved && VALID_TABS.includes(saved as SniperTabId)) return saved as SniperTabId;
    }
    return 'open_positions';
  };

  const [currentTab, setCurrentTabState] = useState<SniperTabId>(getInitialTab);

  const navigateToTab = useCallback((tabId: SniperTabId) => {
    setCurrentTabState(tabId);
    if (typeof window !== 'undefined') {
      localStorage.setItem(SAVED_TAB_KEY, tabId);
      window.location.hash = `#/${tabId}`;
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#\/?/, '').split('/')[0];
      const mapped = mapHashToTab(hash);
      if (mapped && mapped !== currentTab) setCurrentTabState(mapped);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [currentTab]);

  // ---------------- THEME ----------------
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(THEME_KEY) as 'dark' | 'light' | null;
      return saved === 'light' ? 'light' : 'dark';
    }
    return 'dark';
  });

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  // ---------------- TOAST BAR ----------------
  const [toastMessage, setToastMessage] = useState<{ text: string; tone: 'neutral' | 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((text: string, tone: 'neutral' | 'success' | 'error' = 'neutral', ms = 4500) => {
    setToastMessage({ text, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), ms);
  }, []);

  // ---------------- CORE STATE ----------------
  const [status, setStatus] = useState<any>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [trades, setTrades] = useState<SniperTradeRow[]>([]);
  const [logs, setLogs] = useState<SniperLog[]>([]);
  const [wallets, setWallets] = useState<any[]>([]);
  const [signerStatus, setSignerStatus] = useState<SignerStatus | null>(null);
  const [executionProgress, setExecutionProgress] = useState<ExecutionProgressEvent | null>(null);

  const config = useMemo(() => ({ ...DEFAULT_CLIENT_CONFIG, ...(status?.config || {}) }), [status?.config]);
  const botStatus = useMemo(
    () =>
      status?.status || {
        lifecycle_state: 'STOPPED',
        is_running: false,
        last_price_time: 0,
        started_at: null,
        scan_cycle_count: 0,
      },
    [status?.status]
  );
  const portfolio: PortfolioStats = useMemo(() => ({ ...DEFAULT_PORTFOLIO, ...(status?.portfolio || {}) }), [status?.portfolio]);
  const srcStats = useMemo(() => status?.src_stats || {}, [status?.src_stats]);

  const lifecycleState = botStatus.lifecycle_state || (botStatus.is_running ? 'RUNNING' : 'STOPPED');
  const isBotStopped = lifecycleState === 'STOPPED' || !botStatus.is_running;

  // ---------------- DATA FETCHERS ----------------
  const refreshTelemetry = useCallback(async (includeLogs = false) => {
    try {
      const reqs: Promise<Response>[] = [fetch('/api/status'), fetch('/api/positions')];
      if (includeLogs) reqs.push(fetch('/api/logs'));
      const [sRes, pRes, lRes] = await Promise.all(reqs);
      if (sRes?.ok) setStatus(await sRes.json());
      if (pRes?.ok) setPositions(await pRes.json());
      if (includeLogs && lRes?.ok) setLogs(await lRes.json());
    } catch {}
  }, []);

  const refreshTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/trades');
      if (res.ok) setTrades(await res.json());
    } catch {}
  }, []);

  const refreshWallets = useCallback(async () => {
    try {
      const res = await fetch(`/api/wallets?mode=${config.EXECUTION_MODE || 'paper'}`);
      if (res.ok) setWallets(await res.json());
    } catch {}
  }, [config.EXECUTION_MODE]);

  const refreshSignerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/trading-signer');
      if (res.ok) setSignerStatus(await res.json());
    } catch {}
  }, []);

  // Initial load
  useEffect(() => {
    refreshTelemetry(true);
    refreshTrades();
    refreshWallets();
    refreshSignerStatus();
  }, []);

  // Tab switch load
  useEffect(() => {
    if (currentTab === 'trade_history') refreshTrades();
    if (currentTab === 'wallets') {
      refreshWallets();
      refreshSignerStatus();
    }
    if (currentTab === 'scan_log') {
      fetch('/api/logs')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setLogs(d))
        .catch(() => {});
    }
  }, [currentTab, refreshTrades, refreshWallets, refreshSignerStatus]);

  // Fast 500ms tick loop matching gui.py while running
  useEffect(() => {
    if (isBotStopped) return;
    const timer = setInterval(() => {
      refreshTelemetry(false);
    }, 500);
    return () => clearInterval(timer);
  }, [isBotStopped, refreshTelemetry]);

  // SSE stream
  useEffect(() => {
    let evtSource: EventSource | null = null;
    try {
      evtSource = new EventSource('/api/events');
      evtSource.addEventListener('status', (e) => {
        try {
          const updated = JSON.parse(e.data);
          setStatus((prev: any) => (prev ? { ...prev, status: updated } : prev));
        } catch {}
      });
      evtSource.addEventListener('log', (e) => {
        try {
          const newLog: SniperLog = JSON.parse(e.data);
          setLogs((prev) => {
            const next = [...prev, newLog];
            return next.length > 2500 ? next.slice(-2000) : next;
          });
        } catch {}
      });
      evtSource.addEventListener('trade_event', () => {
        refreshTelemetry(false);
        refreshTrades();
      });
      evtSource.addEventListener('execution_progress', (e) => {
        try {
          const prog = JSON.parse(e.data);
          setExecutionProgress({ ...prog, timestamp: Date.now() });
          if (prog.step === 'CONFIRMED' || prog.step === 'FAILED') {
            setTimeout(() => setExecutionProgress(null), 6000);
          }
        } catch {}
      });
      evtSource.addEventListener('pending_browser_sign', async (e) => {
        try {
          const req = JSON.parse(e.data);
          if (!req?.id || !req?.base64Tx) return;
          say(`Phantom confirmation required: ${req.action} ${req.symbol}`, 'neutral', 10000);
          const signRes = await walletManager.signAndSendSolanaTransaction(req.base64Tx);
          await fetch(`/api/live-tx/${encodeURIComponent(req.id)}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signRes),
          });
          if (signRes.success) {
            say(`${req.action} ${req.symbol} signed in Phantom! Confirming on-chain...`, 'success');
          } else {
            say(`${req.action} ${req.symbol} cancelled: ${signRes.error}`, 'error', 6000);
          }
        } catch {}
      });
    } catch {}
    return () => {
      if (evtSource) evtSource.close();
    };
  }, [refreshTelemetry, refreshTrades, say]);

  // ---------------- WALLETS (PRESERVED PHANTOM INTEGRATION) ----------------
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [activeWallet, setActiveWallet] = useState<WalletInfo>(() => walletManager.getActiveWallet());
  const [walletDiagnostics, setWalletDiagnostics] = useState<any>(() =>
    walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana')
  );

  useEffect(() => {
    walletManager.setMode((config.EXECUTION_MODE || 'paper') as ExecutionMode);
    walletManager.setChain(config.DEFAULT_CHAIN || 'solana');
    return walletManager.subscribe(() => {
      setActiveWallet(walletManager.getActiveWallet());
      setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
    });
  }, [config.EXECUTION_MODE, config.DEFAULT_CHAIN]);

  useEffect(() => {
    const syncBalance = async () => {
      const active = walletManager.getActiveWallet();
      if (active.address && active.id !== 'paper') {
        await walletManager.refreshOnChainBalance(active.id);
        await walletManager.syncToBackend(active.id);
        setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
      }
    };
    syncBalance();
    const interval = setInterval(syncBalance, 15000);
    return () => clearInterval(interval);
  }, [config.DEFAULT_CHAIN, config.EXECUTION_MODE]);

  const refreshWalletBalance = useCallback(async () => {
    const active = walletManager.getActiveWallet();
    if (active.address && active.id !== 'paper') {
      await walletManager.refreshOnChainBalance(active.id);
      await walletManager.syncToBackend(active.id);
      setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
      await refreshWallets();
      await refreshTelemetry();
    }
  }, [config.DEFAULT_CHAIN, refreshWallets, refreshTelemetry]);

  const connectWallet = async (id: WalletId): Promise<boolean> => {
    const ok = await walletManager.connectWallet(id);
    if (ok) {
      setActiveWallet(walletManager.getActiveWallet());
      setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
      await refreshWallets();
      await refreshTelemetry();
      say(`Connected ${walletManager.getActiveWallet().name}.`, 'success');
    }
    return ok;
  };

  const connectWatchOnlyAddress = async (id: WalletId, address: string, name?: string): Promise<boolean> => {
    const ok = await walletManager.connectWatchOnlyAddress(id, address, name);
    if (ok) {
      setActiveWallet(walletManager.getActiveWallet());
      setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
      await refreshWallets();
      await refreshTelemetry();
    }
    return ok;
  };

  const selectActiveWallet = (id: WalletId) => {
    walletManager.setActiveWallet(id);
    setActiveWallet(walletManager.getActiveWallet());
    setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
  };

  const disconnectWallet = (id: WalletId) => {
    walletManager.disconnectWallet(id);
    setActiveWallet(walletManager.getActiveWallet());
    setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
    fetch('/api/wallets/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: config.DEFAULT_CHAIN || 'solana' }),
    }).catch(() => {});
  };

  const saveTradingSigner = async (secretKey: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/trading-signer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretKey }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error || 'Invalid private key' };
      await refreshSignerStatus();
      await refreshWallets();
      await refreshTelemetry();
      say('Autonomous live trading signer configured.', 'success');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };

  const clearTradingSigner = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/trading-signer', { method: 'DELETE' });
      if (res.ok) {
        await refreshSignerStatus();
        await refreshWallets();
        await refreshTelemetry();
        say('Autonomous live trading signer cleared.', 'neutral');
        return true;
      }
    } catch {}
    return false;
  };

  // ---------------- MODE SWITCH & ACTIONS ----------------
  const [isLiveConfirmOpen, setIsLiveConfirmOpen] = useState(false);

  const handleSaveConfig = async (newConfig: any): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      const data = await res.json();
      if (res.ok) {
        await refreshTelemetry();
        return { success: true };
      }
      return { success: false, error: data.error || 'Failed to save settings.' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error' };
    }
  };

  const requestModeChange = async (targetMode: ExecutionMode) => {
    if (targetMode === 'live') {
      setIsLiveConfirmOpen(true);
      return;
    }
    const res = await handleSaveConfig({ ...config, EXECUTION_MODE: targetMode });
    if (res.success) {
      walletManager.setMode(targetMode);
      await refreshTelemetry();
      await refreshTrades();
      say(`Switched to ${targetMode.toUpperCase()} mode.`, 'neutral');
    } else if (res.error) {
      say(res.error, 'error', 6000);
    }
  };

  const confirmLiveMode = async (): Promise<boolean> => {
    await handleControlAction('stop_bot');
    const res = await handleSaveConfig({ ...config, EXECUTION_MODE: 'live' });
    if (res.success) {
      walletManager.setMode('live');
      setIsLiveConfirmOpen(false);
      await refreshTelemetry();
      await refreshWallets();
      await refreshTrades();
      say('Switched to LIVE mode. Verify Phantom wallet and signer keypair before pressing Start bot.', 'error', 6000);
      return true;
    }
    say(res.error || 'Could not enable Live mode.', 'error', 6000);
    return false;
  };

  const handleControlAction = async (action: string): Promise<{ success: boolean; error?: string; data?: any }> => {
    try {
      if (action === 'start_bot' && config.EXECUTION_MODE === 'live') {
        const active = walletManager.getActiveWallet();
        if (active.id !== 'paper' && active.address) {
          await walletManager.refreshOnChainBalance(active.id);
          await walletManager.syncToBackend(active.id);
          setWalletDiagnostics(walletManager.getWalletDiagnostics(config.DEFAULT_CHAIN || 'solana'));
        }
      }
      const res = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || 'Action failed';
        say(msg, 'error', 6000);
        return { success: false, error: msg };
      }
      await refreshTelemetry(true);
      return { success: true, data };
    } catch (err: any) {
      say(err.message || 'Control error', 'error');
      return { success: false, error: err.message };
    }
  };

  const handleStartStop = async () => {
    if (isBotStopped) {
      const res = await handleControlAction('start_bot');
      if (res.success) say('Bot started.', 'success');
    } else {
      const res = await handleControlAction('stop_bot');
      if (res.success) say('Bot stopped.', 'neutral');
    }
  };

  const handleSellPosition = async (mint: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/positions/${encodeURIComponent(mint)}/sell`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        say(data.error || 'Sell failed.', 'error', 5000);
        return false;
      }
      say(data.message || 'Position sold.', 'success');
      await refreshTelemetry(true);
      await refreshTrades();
      return true;
    } catch (err: any) {
      say(err.message || 'Sell failed.', 'error');
      return false;
    }
  };

  const handleSellAll = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/positions/sell-all', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        say(data.error || 'Sell all failed.', 'error');
        return false;
      }
      say(`Closed ${data.sold_count ?? 0} position(s).`, 'success');
      await refreshTelemetry(true);
      await refreshTrades();
      return true;
    } catch {
      return false;
    }
  };

  const handleProbe = async (): Promise<boolean> => {
    say('Probing all candidate sources now...', 'neutral', 3000);
    const res = await handleControlAction('probe');
    if (res.success) {
      say('Market probe complete — check Scan log.', 'success');
      return true;
    }
    return false;
  };

  const handleResetAccount = async (): Promise<boolean> => {
    const res = await handleControlAction('reset_account');
    if (res.success) {
      setTrades([]);
      await refreshTelemetry(true);
      say('Paper account reset.', 'success');
      return true;
    }
    return false;
  };

  const handleClearLogs = async () => {
    try {
      await fetch('/api/logs/clear', { method: 'POST' });
      setLogs([]);
      say('Scan log cleared.', 'neutral');
    } catch {}
  };

  return (
    <BotContext.Provider
      value={{
        currentTab,
        navigateToTab,
        status,
        botStatus,
        config,
        portfolio,
        srcStats,
        isBotStopped,
        lifecycleState,
        executionProgress,
        positions,
        trades,
        logs,
        wallets,
        toastMessage,
        say,
        activeWallet,
        walletDiagnostics,
        signerStatus,
        isWalletModalOpen,
        setIsWalletModalOpen,
        connectWallet,
        connectWatchOnlyAddress,
        selectActiveWallet,
        disconnectWallet,
        refreshWalletBalance,
        refreshSignerStatus,
        saveTradingSigner,
        clearTradingSigner,
        isLiveConfirmOpen,
        setIsLiveConfirmOpen,
        requestModeChange,
        confirmLiveMode,
        theme,
        toggleTheme,
        handleStartStop,
        handleControlAction,
        handleSaveConfig,
        handleSellPosition,
        handleSellAll,
        handleProbe,
        handleResetAccount,
        handleClearLogs,
        refreshTelemetry,
        refreshTrades,
      }}
    >
      {children}
    </BotContext.Provider>
  );
};

export const useBot = () => {
  const ctx = useContext(BotContext);
  if (!ctx) throw new Error('useBot must be used within BotProvider');
  return ctx;
};
