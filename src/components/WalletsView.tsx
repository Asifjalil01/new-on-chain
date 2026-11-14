import React, { useState } from 'react';
import {
  Wallet,
  ShieldCheck,
  Copy,
  Check,
  ArrowRightLeft,
  Lock,
  AlertTriangle,
  RefreshCw,
  Activity,
  CheckCircle2,
  XCircle,
  KeyRound,
  Trash2,
} from 'lucide-react';
import { useBot } from '../context/BotContext';
import { formatUsd } from '../utils/formatters';

export const WalletsView: React.FC = () => {
  const {
    wallets,
    activeWallet,
    walletDiagnostics,
    signerStatus,
    setIsWalletModalOpen,
    refreshWalletBalance,
    saveTradingSigner,
    clearTradingSigner,
    config,
  } = useBot();

  const [copiedChain, setCopiedChain] = useState<string | null>(null);
  const [copiedDiagAddress, setCopiedDiagAddress] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [signerKeyInput, setSignerKeyInput] = useState('');
  const [signerBusy, setSignerBusy] = useState(false);
  const [signerMessage, setSignerMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const mode = config.EXECUTION_MODE || 'paper';
  const isLive = mode === 'live';
  const isTestnet = mode === 'testnet';

  const handleCopy = (address: string, chain: string) => {
    navigator.clipboard.writeText(address);
    setCopiedChain(chain);
    setTimeout(() => setCopiedChain(null), 1500);
  };

  const handleCopyDiag = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedDiagAddress(true);
    setTimeout(() => setCopiedDiagAddress(false), 1500);
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshWalletBalance();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSaveSigner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signerKeyInput.trim()) return;
    setSignerBusy(true);
    setSignerMessage(null);
    try {
      const res = await saveTradingSigner(signerKeyInput.trim());
      if (res.success) {
        setSignerKeyInput('');
        setSignerMessage({ type: 'ok', text: 'Autonomous Solana trading signer configured in server memory.' });
      } else {
        setSignerMessage({ type: 'err', text: res.error || 'Failed to parse private key.' });
      }
    } finally {
      setSignerBusy(false);
    }
  };

  const handleClearSigner = async () => {
    setSignerBusy(true);
    setSignerMessage(null);
    try {
      const ok = await clearTradingSigner();
      if (ok) {
        setSignerMessage({ type: 'ok', text: 'Autonomous trading signer removed from server memory.' });
      }
    } finally {
      setSignerBusy(false);
    }
  };

  const signerConnected = Boolean(signerStatus?.configured && signerStatus?.address);
  const browserConnected = activeWallet.connected && Boolean(activeWallet.address) && activeWallet.id !== 'paper';
  const hasLiveConnected = isLive && (browserConnected || signerConnected);
  const effectiveAddress = browserConnected ? activeWallet.address : signerConnected ? signerStatus!.address : activeWallet.address;
  const effectiveName = browserConnected
    ? activeWallet.name
    : signerConnected
    ? 'Solana Trading Keypair (Desktop)'
    : activeWallet.name;
  const effectiveBalanceSol = browserConnected
    ? activeWallet.nativeBalance
    : signerConnected && typeof signerStatus?.balanceSol === 'number'
    ? signerStatus.balanceSol
    : activeWallet.nativeBalance;
  const effectiveBalanceUsd = browserConnected
    ? activeWallet.balanceUsd
    : signerConnected && typeof signerStatus?.balanceUsd === 'number'
    ? signerStatus.balanceUsd
    : activeWallet.balanceUsd;
  const effectiveReady =
    walletDiagnostics?.liveTradingReadiness === 'READY' ||
    (signerConnected && (signerStatus?.balanceSol ?? 0) >= Number(config.MIN_GAS_RESERVE_SOL || 0.01));
  const startBal = Number(config.start_balance_usd ?? 50);
  const startBalSol = Number(config.start_balance_sol ?? Number((startBal / 145).toFixed(4)));

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-y-auto bg-[var(--bg)] p-4 space-y-4">
      {/* Mode Resolution Banner */}
      <div
        className={`p-3 rounded-lg border flex flex-wrap items-center justify-between gap-2 text-xs ${
          isLive
            ? 'bg-[var(--red)]/10 border-[var(--red)]/40 text-[var(--red)]'
            : isTestnet
            ? 'bg-[var(--blue)]/10 border-[var(--blue)]/40 text-[var(--blue)]'
            : 'bg-[var(--teal)]/10 border-[var(--teal)]/40 text-[var(--teal)]'
        }`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          {isLive ? <Lock size={15} /> : <Wallet size={15} />}
          <span className="font-bold">Active mode: {mode.toUpperCase()}</span>
          <span aria-hidden="true">·</span>
          <span className="text-[var(--text)]">
            {isLive
              ? 'Real on-chain Solana mainnet wallet execution. Paper vault isolated.'
              : isTestnet
              ? 'Testnet / devnet RPC context.'
              : `Paper trading simulation active (${startBalSol.toFixed(4)} SOL / $${startBal.toFixed(2)} starting balance). Connect Phantom or set a Desktop Signer anytime for Live trading.`}
          </span>
        </div>
      </div>

      {/* Live Mode Warning if no real wallet or signer connected */}
      {isLive && !hasLiveConnected && (
        <div className="bg-[var(--red)]/10 border border-[var(--red)] rounded-lg p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-[var(--red)] shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-[var(--red)] text-sm">Real Solana wallet required for Live mode</p>
              <p className="text-[var(--text)] mt-1">
                Import your Phantom private key in the Desktop Live Signer section below (or connect a Phantom browser wallet) before starting Live mode.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsWalletModalOpen(true)}
            className="px-4 py-2 rounded-lg bg-[var(--red)] text-white font-semibold hover:brightness-110 flex items-center gap-2 cursor-pointer shrink-0 whitespace-nowrap"
          >
            <Wallet size={14} />
            <span>Connect wallet / keypair</span>
          </button>
        </div>
      )}

      {/* Wallet Diagnostics & On-Chain RPC Status */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden text-xs">
        <div className="px-4 py-2.5 bg-[var(--panel)] border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-[var(--text)]">
            <Activity size={15} className="text-[var(--teal)]" />
            <span>Wallet diagnostics &amp; on-chain RPC status</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-[var(--dim)] font-mono">
              Updated: <strong className="text-[var(--text)]">{walletDiagnostics?.lastUpdated || 'Never'}</strong>
            </span>
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              className="px-3 py-1 rounded-md border border-[var(--border-bright)] bg-[var(--card)] text-[var(--teal)] hover:bg-[var(--panel)] flex items-center gap-1.5 cursor-pointer text-[11px] font-medium whitespace-nowrap"
            >
              <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
              <span>{isRefreshing ? 'Querying RPC...' : 'Refresh balance'}</span>
            </button>
          </div>
        </div>

        <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="p-3 bg-[var(--panel)]/60 border border-[var(--border)] rounded-lg flex flex-col justify-between">
            <div className="text-[11px] text-[var(--dim)] font-medium">Provider &amp; network</div>
            <div className="mt-1">
              <div className="text-sm font-bold text-[var(--text)]">{effectiveName}</div>
              <div className="text-[11px] text-[var(--teal)] mt-0.5">
                {signerConnected && !browserConnected ? 'Solana Mainnet-Beta' : activeWallet.network}
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-[var(--border)] text-[10px] text-[var(--muted)] font-mono truncate">
              RPC: {walletDiagnostics?.rpcEndpoint || 'https://api.mainnet-beta.solana.com'}
            </div>
          </div>

          <div className="p-3 bg-[var(--panel)]/60 border border-[var(--border)] rounded-lg flex flex-col justify-between">
            <div className="text-[11px] text-[var(--dim)] font-medium">Connected address</div>
            <div className="mt-1">
              {effectiveAddress ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-[var(--teal)] font-mono">
                    {effectiveAddress.slice(0, 6)}...{effectiveAddress.slice(-4)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyDiag(effectiveAddress)}
                    className="p-1 rounded text-[var(--dim)] hover:text-[var(--teal)] cursor-pointer"
                    title="Copy public key"
                  >
                    {copiedDiagAddress ? <Check size={12} className="text-[var(--green)]" /> : <Copy size={12} />}
                  </button>
                </div>
              ) : (
                <span className="text-xs font-semibold text-[var(--dim)]">Not connected</span>
              )}
              <div className="text-[11px] text-[var(--muted)] mt-0.5">
                {browserConnected || signerConnected ? 'Connected' : 'Disconnected'}
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-[var(--border)] text-[11px] text-[var(--muted)] flex items-center justify-between font-mono">
              <span>Backend sync</span>
              <span className={walletDiagnostics?.backendSync === 'SYNCED' || signerConnected ? 'text-[var(--green)] font-semibold' : 'text-[var(--yellow)] font-semibold'}>
                {signerConnected ? 'SYNCED' : walletDiagnostics?.backendSync || 'NOT SYNCED'}
              </span>
            </div>
          </div>

          <div className="p-3 bg-[var(--panel)]/60 border border-[var(--border)] rounded-lg flex flex-col justify-between">
            <div className="text-[11px] text-[var(--dim)] font-medium">On-chain balance</div>
            <div className="mt-1 font-mono tabular-nums">
              <div className="text-base font-bold text-[var(--text)]">
                {effectiveBalanceSol.toFixed(5)} {browserConnected ? activeWallet.nativeSymbol : 'SOL'}
              </div>
              <div className="text-[11px] text-[var(--green)] font-semibold mt-0.5">
                {formatUsd(effectiveBalanceUsd)} USD
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-[var(--border)] text-[11px] text-[var(--dim)] flex items-center justify-between font-mono tabular-nums">
              <span>Gas reserve</span>
              <span>{config.MIN_GAS_RESERVE_SOL || activeWallet.gasReserved} {browserConnected ? activeWallet.nativeSymbol : 'SOL'}</span>
            </div>
          </div>

          <div className="p-3 bg-[var(--panel)]/60 border border-[var(--border)] rounded-lg flex flex-col justify-between">
            <div className="text-[11px] text-[var(--dim)] font-medium">Live readiness</div>
            <div className="mt-1">
              <div className="flex items-center gap-1.5">
                {effectiveReady ? (
                  <CheckCircle2 size={15} className="text-[var(--green)] shrink-0" />
                ) : (
                  <XCircle size={15} className="text-[var(--red)] shrink-0" />
                )}
                <span className={`text-xs font-bold ${effectiveReady ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                  {effectiveReady ? 'READY' : walletDiagnostics?.liveTradingReadiness || 'NOT READY'}
                </span>
              </div>
              <div className="text-[11px] text-[var(--muted)] mt-1 line-clamp-2">
                {signerConnected
                  ? 'Desktop/local keypair configured. Ready for autonomous live execution.'
                  : walletDiagnostics?.readinessReason || 'Checking prerequisites...'}
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-[var(--border)] text-[11px] text-[var(--dim)] flex items-center justify-between font-mono">
              <span>Signing</span>
              <span className="font-semibold text-[var(--teal)]">
                {signerConnected ? 'Local keypair' : activeWallet.signingAvailable ? 'Browser prompt' : 'Read-only'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Active Wallet Switcher Card */}
      <div
        className={`bg-[var(--card)] border rounded-lg p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 ${
          isLive ? 'border-[var(--red)]/50' : 'border-[var(--border)]'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--panel)] border border-[var(--border)] flex items-center justify-center text-xl shrink-0">
            {activeWallet.icon}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-[var(--text)] text-sm">{effectiveName}</span>
              <span className="text-[11px] text-[var(--dim)] font-mono">
                {isLive ? '· Live wallet' : `· ${signerConnected && !browserConnected ? 'keypair' : activeWallet.type}`}
              </span>
            </div>
            <div className="text-xs text-[var(--muted)] flex items-center gap-2 mt-0.5 font-mono flex-wrap tabular-nums">
              <span>
                {effectiveAddress
                  ? `${effectiveAddress.slice(0, 10)}...${effectiveAddress.slice(-6)}`
                  : isLive
                  ? 'Disconnected'
                  : 'Simulated paper account'}
              </span>
              <span aria-hidden="true">·</span>
              <span className={`font-bold ${isLive ? 'text-[var(--red)]' : 'text-[var(--teal)]'}`}>
                {effectiveBalanceSol.toFixed(5)} {browserConnected ? activeWallet.nativeSymbol : 'SOL'} ({formatUsd(effectiveBalanceUsd)})
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsWalletModalOpen(true)}
          className="px-4 py-2 rounded-lg font-semibold bg-[var(--teal)] text-white hover:brightness-110 flex items-center gap-2 cursor-pointer text-xs whitespace-nowrap shrink-0"
        >
          <ArrowRightLeft size={13} />
          <span>Switch / connect wallet</span>
        </button>
      </div>

      {/* Autonomous Live Signer Keypair (required for unattended live sniper buys/sells) */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-4 space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2">
          <div className="flex items-center gap-2 font-semibold text-[var(--text)]">
            <KeyRound size={15} className="text-[var(--teal)]" />
            <span>Autonomous Live Swap Signer (Optional — Unattended Mode)</span>
          </div>
          <span className={`font-mono font-semibold ${signerStatus?.configured ? 'text-[var(--green)]' : 'text-[var(--muted)]'}`}>
            {signerStatus?.configured
              ? `Configured (${signerStatus.address?.slice(0, 6)}...${signerStatus.address?.slice(-4)})`
              : 'Optional (Phantom browser popup active)'}
          </span>
        </div>

        <p className="text-[var(--muted)] leading-relaxed">
          By default, Live mode works directly with your connected <strong>Phantom / Solflare</strong> browser extension and prompts you to approve each swap in Phantom. Only paste a dedicated trading keypair below (or set <code className="text-[var(--text)]">SOLANA_PRIVATE_KEY</code>) if you want unattended auto-signing without Phantom popups.
        </p>

        {signerMessage && (
          <div
            className={`p-2.5 rounded-lg border text-xs ${
              signerMessage.type === 'ok'
                ? 'border-[var(--green)]/40 bg-[var(--green)]/10 text-[var(--green)]'
                : 'border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)]'
            }`}
          >
            {signerMessage.text}
          </div>
        )}

        <form onSubmit={handleSaveSigner} className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={signerKeyInput}
            onChange={(e) => setSignerKeyInput(e.target.value)}
            placeholder="Paste dedicated Solana trading Base58 private key or [byte array]..."
            className="flex-1 min-w-[260px] bg-[var(--panel)] border border-[var(--border-bright)] rounded-lg px-3 py-2 text-xs font-mono text-[var(--text)] focus:outline-none focus:border-[var(--teal)]"
          />
          <button
            type="submit"
            disabled={signerBusy || !signerKeyInput.trim()}
            className="px-4 py-2 rounded-lg bg-[var(--teal)] text-white font-semibold cursor-pointer hover:brightness-110 disabled:opacity-50 whitespace-nowrap"
          >
            {signerBusy ? 'Saving...' : 'Set live signer'}
          </button>
          {signerStatus?.configured && (
            <button
              type="button"
              disabled={signerBusy}
              onClick={handleClearSigner}
              className="px-3 py-2 rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)] font-semibold cursor-pointer hover:bg-[var(--red)]/20 flex items-center gap-1.5 whitespace-nowrap"
            >
              <Trash2 size={13} />
              <span>Clear signer</span>
            </button>
          )}
        </form>
      </div>

      {/* Mode-Scoped Wallets Table */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-4">
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-2 mb-3">
          <div className="flex items-center gap-2 font-semibold text-xs text-[var(--text)]">
            <ShieldCheck size={14} className="text-[var(--teal)]" />
            <span>Mode-scoped wallets ({mode.toUpperCase()})</span>
          </div>
          <span className="text-[11px] text-[var(--dim)]">Separate ledger per mode</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead className="bg-[var(--panel)] border-b border-[var(--border)] text-[11px] text-[var(--dim)] font-sans">
              <tr>
                <th className="p-2.5">Chain</th>
                <th className="p-2.5">Wallet</th>
                <th className="p-2.5">Public address</th>
                <th className="p-2.5 text-right">Balance</th>
                <th className="p-2.5 text-right">USD value</th>
                <th className="p-2.5 text-center">Gas status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {wallets.map((w) => (
                <tr key={w.chain} className="hover:bg-[var(--card-hover)]">
                  <td className="p-2.5 font-bold text-[var(--text)] uppercase">{w.chain}</td>
                  <td className="p-2.5 font-sans text-[var(--muted)]">{w.name || `${w.chain.toUpperCase()} Wallet`}</td>
                  <td className="p-2.5">
                    {w.address ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[var(--muted)]">{w.address}</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(w.address, w.chain)}
                          className="hover:text-[var(--teal)] cursor-pointer"
                          title="Copy address"
                        >
                          {copiedChain === w.chain ? (
                            <Check size={11} className="text-[var(--green)]" />
                          ) : (
                            <Copy size={11} />
                          )}
                        </button>
                      </div>
                    ) : (
                      <span className="text-[var(--dim)] font-sans">Not connected</span>
                    )}
                  </td>
                  <td className="p-2.5 text-right font-bold text-[var(--text)]">{w.native_balance}</td>
                  <td className="p-2.5 text-right text-[var(--muted)]">{w.balance_usd || w.usd_value}</td>
                  <td className="p-2.5 text-center font-sans">
                    <span
                      className={`text-[11px] font-semibold ${
                        w.gas_status === 'HEALTHY'
                          ? 'text-[var(--green)]'
                          : w.gas_status === 'LOW'
                          ? 'text-[var(--yellow)]'
                          : 'text-[var(--dim)]'
                      }`}
                    >
                      {w.gas_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
