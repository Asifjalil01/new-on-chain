import React, { useState } from 'react';
import { AlertTriangle, ShieldAlert, X, Lock, CheckCircle2 } from 'lucide-react';
import { useBot } from '../context/BotContext';

export const LiveConfirmModal: React.FC = () => {
  const { isLiveConfirmOpen, setIsLiveConfirmOpen, confirmLiveMode, config } = useBot();
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isLiveConfirmOpen) return null;

  const normalized = confirmText.trim().toUpperCase().replace(/\s+/g, ' ');
  const isMatch = normalized === 'ENABLE LIVE' || normalized === 'LIVE' || normalized === 'ENABLE';

  const handleConfirm = async () => {
    if (!isMatch || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const ok = await confirmLiveMode();
      if (ok) {
        setConfirmText('');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setConfirmText('');
    setIsLiveConfirmOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg bg-[var(--card)] border border-[var(--red)] rounded-xl shadow-2xl overflow-hidden flex flex-col text-xs">
        <div className="h-[48px] px-4 bg-[var(--red)]/15 border-b border-[var(--red)]/40 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[var(--red)] font-bold tracking-wide">
            <ShieldAlert size={18} />
            <span>SWITCH TO LIVE ON-CHAIN EXECUTION</span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-1 rounded text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 bg-[var(--panel)]/40">
          <div className="p-3 bg-[var(--red)]/10 border border-[var(--red)]/30 rounded-lg text-[var(--red)] flex items-start gap-2.5">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">CAUTION: REAL CAPITAL ENGAGEMENT</p>
              <p className="text-[11px] leading-relaxed text-[var(--text)]">
                You are switching from paper simulation to <strong>LIVE MAINNET EXECUTION</strong>. Real SOL swaps will execute on Solana via Jupiter using your connected Phantom wallet and configured live trading signer.
              </p>
            </div>
          </div>

          <div className="space-y-2 text-[11px] text-[var(--muted)] border-t border-[var(--border)] pt-3">
            <p className="font-semibold text-[var(--text)]">Mandatory Security Controls Applied:</p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>Bot will be <strong>STOPPED</strong> immediately until you review Live settings and press Start bot.</li>
              <li>Paper account ledger is isolated from your real Solana wallet.</li>
              <li>A connected Phantom/Solflare wallet with gas above {config.MIN_GAS_RESERVE_SOL || 0.01} SOL is required before starting Live mode (Phantom asks to confirm swaps in your browser, or you can optionally set an autonomous keypair in Wallets).</li>
              <li>
                Sniper risk limits active: trade size {config.trade_size_sol || 0.035} SOL (${config.trade_size_usd || 5}), max cap {config.MAX_POSITION_SIZE_SOL || 0.7} SOL (${config.MAX_POSITION_SIZE_USD || 100}), daily loss limit {config.daily_loss_limit_sol || 0.07} SOL (${config.daily_loss_limit_usd || 10}), TP +{config.take_profit_pct || 50}%, SL -{config.stop_loss_pct || 35}%.
              </li>
            </ul>
          </div>

          <div className="pt-2">
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-[var(--text)]">
                Type <span className="text-[var(--red)] font-mono font-bold">ENABLE LIVE</span> to confirm:
              </label>
              <button
                type="button"
                onClick={() => setConfirmText('ENABLE LIVE')}
                className="text-[11px] text-[var(--teal)] hover:underline cursor-pointer font-semibold"
              >
                Auto-fill
              </button>
            </div>
            <div className="relative">
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isMatch) handleConfirm();
                }}
                placeholder="Type ENABLE LIVE"
                className={`w-full bg-[var(--bg)] border rounded-lg px-3 py-2 text-xs font-mono uppercase tracking-wider outline-none transition-colors ${
                  isMatch
                    ? 'border-[var(--green)] text-[var(--green)]'
                    : 'border-[var(--border-bright)] focus:border-[var(--red)] text-[var(--text)]'
                }`}
                autoFocus
              />
              {isMatch && (
                <div className="absolute right-2.5 top-2 flex items-center gap-1 text-[var(--green)] text-[10px] font-bold">
                  <CheckCircle2 size={13} />
                  <span>MATCHED</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="p-3 bg-[var(--panel)] border-t border-[var(--border)] flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] text-[var(--text)] hover:bg-[var(--card-hover)] cursor-pointer text-xs whitespace-nowrap"
          >
            Cancel / stay in Paper
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!isMatch || isSubmitting}
            className={`px-4 py-1.5 rounded-lg font-bold text-xs flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap ${
              isMatch && !isSubmitting
                ? 'bg-[var(--red)] text-white hover:brightness-110'
                : 'bg-[var(--card)] text-[var(--dim)] border border-[var(--border)] opacity-50 cursor-not-allowed'
            }`}
          >
            <Lock size={12} />
            <span>{isSubmitting ? 'Switching...' : 'Confirm Live Mode'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
