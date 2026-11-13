import React, { useState, useEffect } from 'react';
import {
  X,
  Wallet,
  Check,
  AlertCircle,
  ExternalLink,
  ShieldCheck,
  Power,
  RefreshCw,
  Search,
  Key,
  Lock,
} from 'lucide-react';
import { walletManager, WalletInfo, WalletId } from '../wallets/WalletManager';
import { formatUsd, formatCryptoAmount } from '../utils/formatters';

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
  const [wallets, setWallets] = useState<WalletInfo[]>(walletManager.getAllWallets());
  const [activeWallet, setActiveWallet] = useState<WalletInfo>(walletManager.getActiveWallet());
  const [loadingId, setLoadingId] = useState<WalletId | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
            `Could not connect to ${walletId.toUpperCase()}. Ensure the browser extension is installed and unlocked.`
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
      <div className="w-full max-w-xl bg-[var(--card)] border border-[var(--border-bright)] rounded shadow-2xl overflow-hidden flex flex-col font-mono text-xs">
        {/* Header */}
        <div className="h-[48px] px-4 bg-[var(--panel)] border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-[var(--teal)]" />
            <span className="font-bold text-[var(--text)] tracking-wider">
              CONNECT & AUDIT BLOCKCHAIN WALLET
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
        <div className="p-3 bg-[var(--panel)]/60 border-b border-[var(--border)] flex items-start gap-2.5 text-[11px] text-[var(--muted)]">
          <ShieldCheck size={16} className="text-[var(--teal)] shrink-0 mt-0.5" />
          <span>
            Real on-chain balance verification. Zero mock balances. Private keys or seed phrases are{' '}
            <strong className="text-[var(--text)]">NEVER</strong> requested or stored.
          </span>
        </div>

        {/* Error Alert if any */}
        {errorMessage && (
          <div className="p-3 bg-[var(--red)]/15 border-b border-[var(--red)]/40 text-[var(--red)] flex items-start gap-2 text-[11px]">
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-bold">WALLET CONNECTION NOTICE</p>
              <p>{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Wallets List */}
        <div className="p-3 max-h-[380px] overflow-y-auto space-y-2">
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

        {/* Manual Address Input Accordion (For headless/preview environments or custom public address verification) */}
        <div className="px-3 py-2 bg-[var(--panel)]/40 border-t border-[var(--border)]">
          {!isWatchOnlyMode ? (
            <button
              onClick={() => setIsWatchOnlyMode(true)}
              className="text-[11px] text-[var(--teal)] hover:underline flex items-center gap-1.5 cursor-pointer"
            >
              <Search size={13} />
              <span>Or connect via Public Address (Watch-Only & Balance Audit)</span>
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
        <div className="p-3 bg-[var(--panel)] border-t border-[var(--border)] flex items-center justify-between text-[11px]">
          <span className="text-[var(--dim)]">
            Active:{' '}
            <span className="font-bold text-[var(--teal)]">{activeWallet.name}</span> (
            {activeWallet.nativeSymbol})
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
