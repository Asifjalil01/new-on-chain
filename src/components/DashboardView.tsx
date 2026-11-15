import React, { useState } from 'react';
import { Copy, Check, ExternalLink, Play, ShieldAlert, X, AlertTriangle, Clock } from 'lucide-react';
import { useBot } from '../context/BotContext';
import { fmtPrice, fmtMoney, fmtPct, fmtHeld } from '../utils/formatters';

export const DashboardView: React.FC = () => {
  const {
    positions,
    pendingBuys,
    config,
    isBotStopped,
    handleStartStop,
    handleSellPosition,
    handleManualClearPosition,
    handleSellAll,
    handleProbe,
    say,
  } = useBot();

  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [confirmSellMint, setConfirmSellMint] = useState<string | null>(null);
  const [confirmSellAll, setConfirmSellAll] = useState(false);
  const [copiedMint, setCopiedMint] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const selectedPos = positions.find((p) => p.mint === selectedMint) || null;
  const activeMint = selectedPos?.mint || null;
  const mode = config.EXECUTION_MODE || 'paper';

  const handleCopyKey = () => {
    if (!activeMint) {
      say('Select a coin in the table first.', 'neutral');
      return;
    }
    navigator.clipboard.writeText(activeMint);
    setCopiedMint(activeMint);
    say('Coin key copied.', 'success');
    setTimeout(() => setCopiedMint(null), 1500);
  };

  const requestSellSelected = () => {
    if (!activeMint) {
      say('Select an open position first.', 'neutral');
      return;
    }
    setConfirmSellAll(false);
    setConfirmSellMint(activeMint);
  };

  const executeConfirmSell = async () => {
    if (!confirmSellMint) return;
    setIsBusy(true);
    try {
      await handleSellPosition(confirmSellMint);
      setConfirmSellMint(null);
    } finally {
      setIsBusy(false);
    }
  };

  const executeConfirmSellAll = async () => {
    setIsBusy(true);
    try {
      await handleSellAll();
      setConfirmSellAll(false);
    } finally {
      setIsBusy(false);
    }
  };

  const confirmTarget = positions.find((p) => p.mint === confirmSellMint);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 p-4 gap-3 bg-[var(--bg)]">
      {/* Pending On-Chain Confirmation Banner */}
      {pendingBuys.length > 0 && (
        <div className="px-4 py-2.5 rounded-lg border border-[var(--orange)]/50 bg-[var(--orange)]/10 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-[var(--orange)] font-semibold">
            <Clock size={14} className="shrink-0" />
            <span>
              Pending on-chain confirmation ({pendingBuys.length}):{' '}
              {pendingBuys.map((p) => `${p.symbol} (${p.signature.slice(0, 8)}...)`).join(', ')} — polling before treating as failed.
            </span>
          </div>
        </div>
      )}

      {/* Inline Sell Confirmation Banner (replaces forbidden window.confirm in iFrame) */}
      {(confirmTarget || confirmSellAll) && (
        <div className="px-4 py-2.5 rounded-lg border border-[var(--red)]/50 bg-[var(--red)]/10 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-[var(--text)] font-medium">
            <ShieldAlert size={15} className="text-[var(--red)] shrink-0" />
            <span>
              {confirmSellAll
                ? `Close all ${positions.length} open ${mode} position(s) at current market prices?`
                : `Close the ${mode} position in ${confirmTarget?.symbol} at the current price (${fmtPrice(confirmTarget?.now)})?`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isBusy}
              onClick={confirmSellAll ? executeConfirmSellAll : executeConfirmSell}
              className="px-3 py-1 rounded bg-[var(--red)] text-white font-semibold cursor-pointer hover:brightness-110 disabled:opacity-50 whitespace-nowrap"
            >
              {isBusy ? 'Selling...' : 'Confirm sell'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmSellMint(null);
                setConfirmSellAll(false);
              }}
              className="px-3 py-1 rounded border border-[var(--border-bright)] bg-[var(--card)] text-[var(--text)] cursor-pointer hover:bg-[var(--card-hover)] flex items-center gap-1 whitespace-nowrap"
            >
              <X size={12} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {/* Open Positions Table */}
      <div className="flex-1 min-h-0 bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col">
        {positions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3">
            <p className="text-sm font-semibold text-[var(--text)]">No open positions</p>
            <p className="text-xs text-[var(--muted)] max-w-md leading-relaxed">
              The sniper monitors GeckoTerminal, Jupiter, DexScreener, and PumpPortal for tokens inside your {config.min_age_minutes ?? 30}m–{config.max_age_minutes ?? 720}m maturity window that pass liquidity, fail-closed RugCheck, on-chain holder concentration, and sell-route checks.
            </p>
            <div className="flex items-center gap-2 mt-1">
              {isBotStopped ? (
                <button
                  type="button"
                  onClick={handleStartStop}
                  className="px-4 py-2 rounded-lg bg-[var(--green)] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer hover:brightness-110"
                >
                  <Play size={13} />
                  <span>Start bot</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleProbe}
                  className="px-4 py-2 rounded-lg border border-[var(--border-bright)] bg-[var(--panel)] text-[var(--text)] text-xs font-semibold cursor-pointer hover:border-[var(--teal)]"
                >
                  Probe market now
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-[var(--panel)] border-b border-[var(--border)] text-[11px] font-semibold text-[var(--dim)] z-10">
                <tr>
                  <th className="py-2.5 px-3">Coin</th>
                  <th className="py-2.5 px-3 text-right">Size (SOL / $)</th>
                  <th className="py-2.5 px-3 text-right">PnL %</th>
                  <th className="py-2.5 px-3 text-right">PnL (SOL / $)</th>
                  <th className="py-2.5 px-3 text-right">Entry price</th>
                  <th className="py-2.5 px-3 text-right">Price now</th>
                  <th className="py-2.5 px-3 text-right">Peak %</th>
                  <th className="py-2.5 px-3 text-right">Low %</th>
                  <th className="py-2.5 px-3 text-right">Entry TP / SL</th>
                  <th className="py-2.5 px-3 text-right">Held</th>
                  <th className="py-2.5 px-3">Source</th>
                  <th className="py-2.5 px-3">Coin key (token address)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] font-mono tabular-nums">
                {positions.map((r) => {
                  const isSelected = r.mint === activeMint;
                  const chg = r.chg;
                  const toneClass =
                    chg === null
                      ? 'text-[var(--muted)]'
                      : chg > 0
                      ? 'text-[var(--green)] font-semibold'
                      : chg < 0
                      ? 'text-[var(--red)] font-semibold'
                      : 'text-[var(--text)]';

                  return (
                    <tr
                      key={r.mint}
                      onClick={() => setSelectedMint(r.mint)}
                      className={`h-[40px] cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-[var(--teal)]/12'
                          : r.needs_review
                          ? 'bg-[var(--orange)]/8 hover:bg-[var(--orange)]/15'
                          : 'hover:bg-[var(--card-hover)]'
                      }`}
                    >
                      <td className="py-2 px-3 font-sans font-semibold text-[var(--text)] whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span>{r.symbol}</span>
                          {r.needs_review && (
                            <>
                              <span
                                title={r.needs_review_reason || 'Zero balance read without confirmed on-chain sell'}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--orange)]/20 border border-[var(--orange)]/50 text-[var(--orange)] text-[10px] font-bold"
                              >
                                <AlertTriangle size={10} />
                                NEEDS REVIEW
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleManualClearPosition(r.mint);
                                }}
                                className="px-1.5 py-0.5 rounded border border-[var(--red)]/50 bg-[var(--red)]/10 text-[var(--red)] hover:bg-[var(--red)] hover:text-white text-[10px] font-semibold cursor-pointer"
                              >
                                Clear
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--text)] whitespace-nowrap">
                        {r.cost_sol !== undefined ? `${r.cost_sol.toFixed(4)} SOL · ` : ''}
                        <span className="text-[var(--muted)]">{fmtMoney(r.cost)}</span>
                      </td>
                      <td className={`py-2 px-3 text-right whitespace-nowrap ${toneClass}`}>
                        {fmtPct(r.chg)}
                      </td>
                      <td className={`py-2 px-3 text-right whitespace-nowrap ${toneClass}`}>
                        {r.pnl_sol !== undefined && r.pnl_sol !== null
                          ? `${r.pnl_sol >= 0 ? '+' : ''}${r.pnl_sol.toFixed(4)} SOL · `
                          : ''}
                        {fmtMoney(r.pnl_usd, true)}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--text)] whitespace-nowrap">
                        {fmtPrice(r.entry)}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--text)] whitespace-nowrap">
                        {r.now !== null ? fmtPrice(r.now) : '...'}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--green)] whitespace-nowrap">
                        {fmtPct(r.peak)}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--red)] whitespace-nowrap">
                        {fmtPct(r.low)}
                      </td>
                      <td className="py-2 px-3 text-right text-[11px] text-[var(--muted)] whitespace-nowrap">
                        {r.exit_params
                          ? `+${r.exit_params.take_profit_pct}% / -${r.exit_params.stop_loss_pct}%`
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--muted)] whitespace-nowrap">
                        {fmtHeld(r.held)}
                      </td>
                      <td className="py-2 px-3 font-sans text-[11px] text-[var(--muted)] whitespace-nowrap">
                        {r.dex} / {r.source}
                      </td>
                      <td className="py-2 px-3 text-[11px] text-[var(--muted)] max-w-[340px] truncate">
                        {r.mint}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bottom Action Row matching gui.py */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopyKey}
            className="px-3 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:bg-[var(--card-hover)] text-xs font-medium text-[var(--text)] flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            {copiedMint && copiedMint === activeMint ? (
              <Check size={13} className="text-[var(--green)]" />
            ) : (
              <Copy size={13} />
            )}
            <span>Copy coin key</span>
          </button>

          {activeMint ? (
            <a
              href={`https://dexscreener.com/solana/${activeMint}`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:bg-[var(--card-hover)] text-xs font-medium text-[var(--text)] flex items-center gap-1.5 whitespace-nowrap"
            >
              <ExternalLink size={13} />
              <span>Open chart on DexScreener</span>
            </a>
          ) : (
            <button
              type="button"
              onClick={() => say('Select a coin in the table first.', 'neutral')}
              className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-xs font-medium text-[var(--dim)] flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <ExternalLink size={13} />
              <span>Open chart on DexScreener</span>
            </button>
          )}

          <button
            type="button"
            onClick={requestSellSelected}
            className="px-3 py-1.5 rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/10 hover:bg-[var(--red)]/20 text-xs font-semibold text-[var(--red)] cursor-pointer whitespace-nowrap"
          >
            Sell now ({mode === 'live' ? 'live' : 'paper'})
          </button>

          {positions.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setConfirmSellMint(null);
                setConfirmSellAll(true);
              }}
              className="px-3 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:border-[var(--red)] text-xs font-medium text-[var(--muted)] hover:text-[var(--red)] cursor-pointer whitespace-nowrap"
            >
              Sell all ({positions.length})
            </button>
          )}
        </div>

        <div className="text-xs font-medium text-[var(--dim)] tabular-nums">
          {positions.length > 0
            ? `${positions.length} of ${config.max_open_positions || 2} slots in use`
            : 'No open positions'}
        </div>
      </div>
    </div>
  );
};
