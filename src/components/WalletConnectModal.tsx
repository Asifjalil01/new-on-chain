import React, { useState, useEffect } from 'react';
import {
  X,
  Wallet,
  AlertCircle,
  ShieldCheck,
  Power,
  RefreshCw,
  Search,
  KeyRound,
  Trash2,
} from 'lucide-react';
import { walletManager, WalletInfo, WalletId } from '../wallets/WalletManager';
import { formatUsd } from '../utils/formatters';
import { useBot } from '../context/BotContext';

interface WalletConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWalletSelected?: (wallet: WalletInfo) => void;
}

export const WalletConnectModal: React.FC<WalletConnectModalProps> = ({
  isOpen,
  onClose,
  onWalletSelected,
}) => {
  const { signerStatus, saveTradingSigner, clearTradingSigner } = useBot();
  const [wallets, setWallets] = useState<WalletInfo[]>(walletManager.getAllWallets());
  const [activeWallet, setActiveWallet] = useState<WalletInfo>(walletManager.getActiveWallet());
  const [loadingId, setLoadingId] = useState<WalletId | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDesktop = typeof window !== 'undefined' && Boolean(window.desktopAPI?.isDesktop);
  const hasBrowserSolana =
    typeof window !== 'undefined' &&
    Boolean(window.phantom?.solana || window.solana?.isPhantom || window.solflare?.isSolflare);

  // Desktop / local keypair signer input
  const [showKeypairBox, setShowKeypairBox] = useState<boolean>(isDesktop || !hasBrowserSolana);
  const [signerKeyInput, setSignerKeyInput] = useState<string>('');
  const [signerBusy, setSignerBusy] = useState<boolean>(false);
  const [signerNotice, setSignerNotice] = useState<string | null>(null);

  // Manual watch-only input state
  const [isWatchOnlyMode, setIsWatchOnlyMode] = useState<boolean>(false);
  const [manualAddress, setManualAddress] = useState<string>('');
  const [manualWalletId, setManualWalletId] = useState<WalletId>('phantom');
  const [isVerifyingManual, setIsVerifyingManual] = useState<boolean>(false);

  useEffect(() => {
    return walletManager.subscribe(() => {
      setWallets(walletManager.getAllWallets());
      setActiveWallet(walletManager.getActiveWallet());
    });
  }, []);

  if (!isOpen) return null;

  const handleConnect = async (walletId: WalletId) => {
    setLoadingId(walletId);
    setErrorMessage(null);
    try {
      const ok = await walletManager.connectWallet(walletId);
      if (ok) {
        const updated = walletManager.getActiveWallet();
        if (onWalletSelected) {
          onWalletSelected(updated);
        }
      } else {
        const target = walletManager.getAllWallets().find((w) => w.id === walletId);
        setErrorMessage(
          target?.errorReason ||
            `Could not connect to ${walletId.toUpperCase()}. In desktop mode, use the Desktop Signer keypair section below.`
        );
      }
    } finally {
      setLoadingId(null);
    }
  };

  const handleSelectActive = (walletId: WalletId) => {
    walletManager.setActiveWallet(walletId);
    if (onWalletSelected) {
      onWalletSelected(walletManager.getActiveWallet());
    }
  };

  const handleDisconnect = (walletId: WalletId) => {
    walletManager.disconnectWallet(walletId);
  };

  const handleRefreshBalance = async (walletId: WalletId) => {
    setLoadingId(walletId);
    try {
      await walletManager.refreshOnChainBalance(walletId);
      await walletManager.syncToBackend(walletId);
    } finally {
      setLoadingId(null);
    }
  };

  const handleSaveDesktopSigner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signerKeyInput.trim()) return;
    setSignerBusy(true);
    setErrorMessage(null);
    setSignerNotice(null);
    try {
      const res = await saveTradingSigner(signerKeyInput.trim());
      if (res.success) {
        setSignerKeyInput('');
        setSignerNotice('Desktop Live Signer connected in local engine memory.');
      } else {
        setErrorMessage(res.error || 'Invalid Solana private key.');
      }
    } finally {
      setSignerBusy(false);
    }
  };

  const handleClearDesktopSigner = async () => {
    setSignerBusy(true);
    setSignerNotice(null);
    try {
      const ok = await clearTradingSigner();
      if (ok) setSignerNotice('Desktop Live Signer cleared.');
    } finally {
      setSignerBusy(false);
    }
  };

  const handleVerifyManualAddress = async () => {
    if (!manualAddress.trim()) return;
    setIsVerifyingManual(true);
    setErrorMessage(null);
    try {
      const ok = await walletManager.connectWatchOnlyAddress(
        manualWalletId,
        manualAddress.trim(),
        `${manualWalletId === 'phantom' ? 'Phantom' : 'Solana'} (Live On-Chain)`
      );
      if (ok) {
        setIsWatchOnlyMode(false);
        setManualAddress('');
        if (onWalletSelected) {
          onWalletSelected(walletManager.getActiveWallet());
        }
      } else {
        setErrorMessage('Failed to verify on-chain balance for address.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error querying blockchain RPC');
    } finally {
      setIsVerifyingManual(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none">
      <div className="w-full max-w-xl bg-[var(--card)] border border-[var(--border-bright)] rounded shadow-2xl overflow-hidden flex flex-col font-mono text-xs max-h-[92vh]">
        {/* Header */}
        <div className="h-[48px] px-4 bg-[var(--panel)] border-b border-[var(--border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-[var(--teal)]" />
            <span className="font-bold text-[var(--text)] tracking-wider">
              {isDesktop ? 'DESKTOP WALLET & ON-CHAIN SIGNER' : 'CONNECT & AUDIT BLOCKCHAIN WALLET'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--card)] cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Notice */}
        <div className="p-3 bg-[var(--panel)]/60 border-b border-[var(--border)] flex items-start gap-2.5 text-[11px] text-[var(--muted)] shrink-0">
          <ShieldCheck size={16} className="text-[var(--teal)] shrink-0 mt-0.5" />
          <span>
            Real on-chain balance verification. Local desktop signer keypairs are held strictly in local process memory for autonomous swap signing and never sent externally.
          </span>
        </div>

        {/* Error Alert if any */}
        {errorMessage && (
          <div className="p-3 bg-[var(--red)]/15 border-b border-[var(--red)]/40 text-[var(--red)] flex items-start gap-2 text-[11px] shrink-0">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-bold">WALLET CONNECTION NOTICE</p>
              <p>{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Desktop / Direct Signer Section */}
        <div className="p-3 bg-[var(--panel)]/40 border-b border-[var(--border)] space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowKeypairBox((prev) => !prev)}
              className="flex items-center gap-2 text-[11px] font-bold text-[var(--teal)] cursor-pointer hover:underline"
            >
              <KeyRound size={14} />
              <span>
                {isDesktop
                  ? 'Desktop Live Signer (Import Phantom Private Key — No Browser Extension Needed)'
                  : 'Autonomous Keypair Signer (For Desktop App / Unattended Live Mode)'}
              </span>
            </button>
            {signerStatus?.configured && signerStatus?.address && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--green)]/15 text-[var(--green)] font-bold">
                CONNECTED: {signerStatus.address.slice(0, 4)}...{signerStatus.address.slice(-4)} (
                {(signerStatus.balanceSol ?? 0).toFixed(4)} SOL)
              </span>
            )}
          </div>

          {signerNotice && (
            <div className="text-[11px] text-[var(--green)] font-semibold">{signerNotice}</div>
          )}

          {showKeypairBox && (
            <form onSubmit={handleSaveDesktopSigner} className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={signerKeyInput}
                  onChange={(e) => setSignerKeyInput(e.target.value)}
                  placeholder="Paste Phantom Base58 private key or [byte array]..."
                  className="flex-1 bg-[var(--card)] border border-[var(--border-bright)] rounded px-2.5 py-1.5 text-xs text-[var(--text)] font-mono focus:border-[var(--teal)] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={signerBusy || !signerKeyInput.trim()}
                  className="px-3 py-1.5 rounded bg-[var(--teal)] text-[var(--bg)] font-bold text-xs hover:brightness-110 disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {signerBusy ? 'SAVING...' : 'CONNECT SIGNER'}
                </button>
                {signerStatus?.configured && (
                  <button
                    type="button"
                    disabled={signerBusy}
                    onClick={handleClearDesktopSigner}
                    className="px-2.5 py-1.5 rounded border border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)] hover:bg-[var(--red)]/20 cursor-pointer shrink-0 flex items-center gap-1"
                    title="Clear Desktop Signer"
                  >
                    <Trash2 size={12} />
                    <span>CLEAR</span>
                  </button>
                )}
              </div>
              <p className="text-[10px] text-[var(--dim)]">
                Because desktop windows do not run Chrome extensions, paste your Phantom trading wallet private key here to execute real Live SOL swaps directly from the desktop software.
              </p>
            </form>
          )}
        </div>

        {/* Wallets List */}
        <div className="p-3 overflow-y-auto space-y-2 flex-1 min-h-0">
          {wallets.map((w) => {
            const isActive = activeWallet.id === w.id;
            const isConnected = w.connected && Boolean(w.address);
            const isLoading = loadingId === w.id;

            return (
              <div
                key={w.id}
                onClick={() => isConnected && handleSelectActive(w.id)}
                className={`p-3 rounded border transition-all flex items-center justify-between gap-3 ${
                  isActive
                    ? 'border-[var(--teal)] bg-[var(--panel)] ring-1 ring-[var(--teal)]/40'
                    : 'border-[var(--border)] bg-[var(--bg)] hover:border-[var(--border-bright)]'
                } ${isConnected ? 'cursor-pointer' : ''}`}
              >
                {/* Left: Icon & Names */}
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded bg-[var(--card)] border border-[var(--border)] flex items-center justify-center text-lg">
                    {w.icon}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[var(--text)] text-sm">{w.name}</span>
                      {isActive && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-[var(--teal)] text-[var(--bg)]">
                          ACTIVE TRADING WALLET
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--dim)] uppercase">[{w.type}]</span>
                      <span className="text-[9px] font-mono px-1 rounded bg-[var(--card)] border border-[var(--border)] text-[var(--yellow)]">
                        Fee: {w.id === 'phantom' ? '0.85%' : w.id === 'solflare' ? '0.50%' : w.id === 'metamask' ? '0.875%' : w.id === 'trustwallet' ? '1.00%' : w.id === 'coinbase' ? '1.00%' : w.id === 'ledger' ? '0.00%' : '0.30%'}
                      </span>
                    </div>

                    <div className="text-[11px] text-[var(--muted)] flex items-center gap-2 mt-0.5">
                      {w.address ? (
                        <span className="font-mono text-[var(--teal)] font-bold">
                          {w.address.slice(0, 6)}...{w.address.slice(-4)}
                        </span>
                      ) : (
                        <span className="text-[var(--dim)] italic">Not connected</span>
                      )}
                      <span>·</span>
                      <span className="text-[var(--text)] font-semibold font-mono">
                        {w.nativeBalance.toFixed(5)} {w.nativeSymbol} ({formatUsd(w.balanceUsd)})
                      </span>
                    </div>
                  </div>
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {isConnected ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRefreshBalance(w.id);
                        }}
                        disabled={isLoading}
                        className="p-1 rounded text-[var(--muted)] hover:text-[var(--teal)] hover:bg-[var(--card)] cursor-pointer"
                        title="Refresh On-Chain Balance"
                      >
                        <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
                      </button>
                      {!isActive && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectActive(w.id);
                          }}
                          className="px-2.5 py-1 rounded border border-[var(--border-bright)] bg-[var(--card)] text-[var(--muted)] hover:text-[var(--teal)] hover:border-[var(--teal)] text-[11px] cursor-pointer"
                        >
                          SELECT
                        </button>
                      )}
                      {w.id !== 'paper' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDisconnect(w.id);
                          }}
                          className="p-1 rounded text-[var(--dim)] hover:text-[var(--red)] cursor-pointer"
                          title="Disconnect"
                        >
                          <Power size={13} />
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => handleConnect(w.id)}
                      disabled={isLoading}
                      className="px-3 py-1 rounded border border-[var(--teal)] bg-[var(--teal)] text-[var(--bg)] font-bold text-[11px] hover:brightness-110 cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {isLoading ? 'CONNECTING...' : 'CONNECT'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Manual Address Input Accordion */}
        <div className="px-3 py-2 bg-[var(--panel)]/40 border-t border-[var(--border)] shrink-0">
          {!isWatchOnlyMode ? (
            <button
              onClick={() => setIsWatchOnlyMode(true)}
              className="text-[11px] text-[var(--teal)] hover:underline flex items-center gap-1.5 cursor-pointer"
            >
              <Search size={13} />
              <span>Or connect via Public Address (Watch-Only &amp; Balance Audit)</span>
            </button>
          ) : (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-bold text-[var(--text)]">ENTER PUBLIC ON-CHAIN ADDRESS</span>
                <button
                  onClick={() => setIsWatchOnlyMode(false)}
                  className="text-[10px] text-[var(--dim)] hover:text-[var(--text)] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={manualWalletId}
                  onChange={(e) => setManualWalletId(e.target.value as WalletId)}
                  className="bg-[var(--card)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text)] focus:outline-none"
                >
                  <option value="phantom">Solana (Phantom)</option>
                  <option value="solflare">Solana (Solflare)</option>
                  <option value="metamask">Ethereum (MetaMask)</option>
                </select>
                <input
                  type="text"
                  value={manualAddress}
                  onChange={(e) => setManualAddress(e.target.value)}
                  placeholder="e.g. 7xKXtg...JosgAsU"
                  className="flex-1 bg-[var(--card)] border border-[var(--border)] rounded px-2.5 py-1.5 text-xs text-[var(--text)] font-mono focus:border-[var(--teal)] focus:outline-none"
                />
                <button
                  onClick={handleVerifyManualAddress}
                  disabled={isVerifyingManual || !manualAddress.trim()}
                  className="px-3 py-1.5 rounded bg-[var(--teal)] text-[var(--bg)] font-bold text-xs hover:brightness-110 disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {isVerifyingManual ? 'VERIFYING...' : 'VERIFY ON-CHAIN'}
                </button>
              </div>
              <p className="text-[10px] text-[var(--dim)]">
                The bot queries the public Solana RPC for the exact live balance.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 bg-[var(--panel)] border-t border-[var(--border)] flex items-center justify-between text-[11px] shrink-0">
          <span className="text-[var(--dim)]">
            Active:{' '}
            <span className="font-bold text-[var(--teal)]">
              {signerStatus?.configured && activeWallet.id === 'paper'
                ? 'Desktop Live Signer'
                : activeWallet.name}
            </span>{' '}
            ({activeWallet.nativeSymbol})
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded border border-[var(--border-bright)] bg-[var(--card)] text-[var(--text)] hover:border-[var(--teal)] cursor-pointer"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
};
