import React, { useEffect, useState } from 'react';
import { Wallet, Lock, Sun, Moon, Play, Square } from 'lucide-react';
import { useBot } from '../context/BotContext';

export const HeaderBar: React.FC = () => {
  const {
    config,
    status,
    botStatus,
    positions,
    activeWallet,
    signerStatus,
    setIsWalletModalOpen,
    requestModeChange,
    theme,
    toggleTheme,
    isBotStopped,
    handleStartStop,
  } = useBot();

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (isBotStopped) return;
    const t = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [isBotStopped]);

  const mode = config.EXECUTION_MODE || 'paper';
  const isLive = mode === 'live';
  const isTestnet = mode === 'testnet';
  const isPaper = mode === 'paper';

  const browserWalletConnected = Boolean(activeWallet.address && activeWallet.id !== 'paper');
  const signerConnected = Boolean(signerStatus?.configured && signerStatus?.address);
  const serverWallet = status?.live_wallet;
  const connectedLiveAddress = browserWalletConnected
    ? activeWallet.address
    : signerConnected
    ? signerStatus!.address
    : serverWallet?.address || null;
  const connectedLiveBalanceSol = browserWalletConnected
    ? activeWallet.nativeBalance
    : signerConnected && typeof signerStatus?.balanceSol === 'number'
    ? signerStatus.balanceSol
    : null;
  const connectedLiveSymbol = browserWalletConnected ? activeWallet.nativeSymbol : 'SOL';

  const priceAgeSec = botStatus.last_price_time
    ? Math.max(0, (nowMs - botStatus.last_price_time) / 1000)
    : null;

  let statusText = 'STOPPED';
  let statusColorClass = 'text-[var(--dim)]';

  if (!isBotStopped) {
    if (positions.length > 0 && (priceAgeSec === null || priceAgeSec > 15)) {
      statusText = 'RUNNING · waiting for prices';
      statusColorClass = 'text-[var(--orange)]';
    } else if (positions.length > 0 && priceAgeSec !== null) {
      statusText = `RUNNING · prices updated ${priceAgeSec.toFixed(1)}s ago`;
      statusColorClass = 'text-[var(--green)]';
    } else {
      statusText = `RUNNING · scanning every ${config.scan_interval_sec || 1}s`;
      statusColorClass = 'text-[var(--green)]';
    }
  }

  return (
    <header className="bg-[var(--bg)] border-b border-[var(--border)] px-5 py-3 flex flex-wrap items-center justify-between gap-4 shrink-0">
      {/* Left: Brand Title & Unboxed Subtitle */}
      <div className="min-w-0">
        <h1 className="text-lg font-bold tracking-tight text-[var(--text)] whitespace-nowrap">
          Solana Launch Sniper
        </h1>
        <p className="text-xs text-[var(--dim)] mt-0.5 whitespace-nowrap">
          {isLive
            ? 'All DEXes · brand-new coins only · hard rug screen · LIVE MODE (real SOL)'
            : isTestnet
            ? 'All DEXes · brand-new coins only · hard rug screen · TESTNET MODE'
            : 'All DEXes · brand-new coins only · hard rug screen · PAPER MODE (no real money)'}
        </p>
      </div>

      {/* Right: Mode Switcher, Wallet, Status Readout, Start/Stop CTA, Theme Toggle */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        {/* Mode Switcher */}
        <div
          className="flex items-center p-0.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] text-xs font-semibold"
          role="group"
          aria-label="Execution Mode"
        >
          <button
            type="button"
            onClick={() => requestModeChange('paper')}
            className={`px-2.5 py-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              isPaper
                ? 'bg-[var(--teal)] text-white font-semibold'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            Paper
          </button>
          <button
            type="button"
            onClick={() => requestModeChange('testnet')}
            className={`px-2.5 py-1.5 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              isTestnet
                ? 'bg-[var(--blue)] text-white font-semibold'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            Testnet
          </button>
          <button
            type="button"
            onClick={() => requestModeChange('live')}
            className={`px-2.5 py-1.5 rounded-md transition-colors cursor-pointer flex items-center gap-1 whitespace-nowrap shrink-0 ${
              isLive
                ? 'bg-[var(--red)] text-white font-semibold'
                : 'text-[var(--muted)] hover:text-[var(--red)]'
            }`}
          >
            {isLive && <Lock size={11} />}
            <span>Live</span>
          </button>
        </div>

        {/* Wallet / Desktop Signer Button */}
        <button
          type="button"
          onClick={() => setIsWalletModalOpen(true)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
            isLive && !connectedLiveAddress
              ? 'border-[var(--red)] bg-[var(--red)]/10 text-[var(--red)]'
              : 'border-[var(--border-bright)] bg-[var(--card)] text-[var(--text)] hover:border-[var(--teal)]'
          }`}
          title={
            connectedLiveAddress
              ? `${browserWalletConnected ? activeWallet.name : 'Desktop Live Signer'}: ${connectedLiveAddress}`
              : 'Connect Phantom / Import Desktop Signer Key'
          }
        >
          <Wallet size={14} className={isLive ? 'text-[var(--red)]' : 'text-[var(--teal)]'} />
          <span>
            {browserWalletConnected && connectedLiveAddress
              ? `${activeWallet.name.split(' ')[0]} · ${connectedLiveAddress.slice(0, 4)}...${connectedLiveAddress.slice(-4)}`
              : connectedLiveAddress
              ? `Signer · ${connectedLiveAddress.slice(0, 4)}...${connectedLiveAddress.slice(-4)}`
              : isLive
              ? 'Connect Wallet'
              : 'Phantom / Keypair'}
          </span>
          {connectedLiveBalanceSol !== null && (
            <span className="font-mono text-[var(--muted)] border-l border-[var(--border)] pl-2 tabular-nums">
              {connectedLiveBalanceSol.toFixed(4)} {connectedLiveSymbol}
              {status?.sol_price_usd ? ` ($${(connectedLiveBalanceSol * Number(status.sol_price_usd)).toFixed(2)})` : ''}
            </span>
          )}
        </button>

        {/* Live Engine Status Readout */}
        <div className={`text-xs font-semibold font-mono px-2 whitespace-nowrap shrink-0 ${statusColorClass}`}>
          {statusText}
        </div>

        {/* Primary CTA: Start / Stop Bot */}
        <button
          type="button"
          onClick={handleStartStop}
          className={`px-5 py-2 rounded-lg text-sm font-bold text-white flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
            isBotStopped
              ? 'bg-[var(--green)] hover:brightness-110'
              : 'bg-[var(--red)] hover:brightness-110'
          }`}
        >
          {isBotStopped ? <Play size={14} /> : <Square size={14} />}
          <span>{isBotStopped ? 'Start bot' : 'Stop bot'}</span>
        </button>

        {/* Theme Toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="p-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border-bright)] cursor-pointer transition-colors shrink-0"
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
};
