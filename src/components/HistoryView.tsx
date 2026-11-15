import React, { useState } from 'react';
import { Copy, Check, ExternalLink, Download, RefreshCw } from 'lucide-react';
import { useBot, SniperTradeRow } from '../context/BotContext';
import { fmtPrice, fmtMoney } from '../utils/formatters';

interface HistoryViewProps {
  trades?: SniperTradeRow[];
}

export const HistoryView: React.FC<HistoryViewProps> = ({ trades: propTrades }) => {
  const { trades: ctxTrades, refreshTrades, say } = useBot();
  const trades = propTrades ?? ctxTrades;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedMint, setCopiedMint] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const selectedTrade = trades.find((t) => t.id === selectedId) || null;
  const activeMint = selectedTrade?.mint || null;

  const totalBaseFeesSol = trades.reduce((s, t) => s + Number(t.base_fee_sol || 0), 0);
  const totalPriorityFeesSol = trades.reduce((s, t) => s + Number(t.priority_fee_sol || 0), 0);
  const totalRentSol = trades.reduce((s, t) => s + Number(t.rent_paid_sol || 0), 0);
  const totalFeesAndRentSol = totalBaseFeesSol + totalPriorityFeesSol + totalRentSol;

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

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshTrades();
    } finally {
      setIsRefreshing(false);
    }
  };

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 p-4 gap-3 bg-[var(--bg)]">
      {/* Fees & Rent Summary Strip */}
      <div className="px-4 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] flex flex-wrap items-center justify-between gap-4 text-xs font-mono tabular-nums shrink-0">
        <div className="flex flex-wrap items-center gap-5">
          <div>
            <span className="font-sans text-[var(--dim)] mr-1.5">Base fees:</span>
            <strong className="text-[var(--text)]">{totalBaseFeesSol.toFixed(6)} SOL</strong>
          </div>
          <div>
            <span className="font-sans text-[var(--dim)] mr-1.5">Priority fees:</span>
            <strong className="text-[var(--text)]">{totalPriorityFeesSol.toFixed(6)} SOL</strong>
          </div>
          <div>
            <span className="font-sans text-[var(--dim)] mr-1.5">Token-account rent:</span>
            <strong className="text-[var(--text)]">{totalRentSol.toFixed(6)} SOL</strong>
          </div>
        </div>
        <div>
          <span className="font-sans text-[var(--dim)] mr-1.5">Total fees &amp; rent:</span>
          <strong className="text-[var(--orange)]">{totalFeesAndRentSol.toFixed(6)} SOL</strong>
        </div>
      </div>

      {/* Trades Table */}
      <div className="flex-1 min-h-0 bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col">
        {trades.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-2">
            <p className="text-sm font-semibold text-[var(--text)]">No trades recorded yet</p>
            <p className="text-xs text-[var(--muted)] max-w-md">
              All BUY and SELL executions (simulated or live) appear here and are logged to trades_log.csv.
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-[var(--panel)] border-b border-[var(--border)] text-[11px] font-semibold text-[var(--dim)] z-10">
                <tr>
                  <th className="py-2.5 px-3">Time</th>
                  <th className="py-2.5 px-3">Action</th>
                  <th className="py-2.5 px-3">Coin</th>
                  <th className="py-2.5 px-3 text-right">Price</th>
                  <th className="py-2.5 px-3 text-right">Amount (SOL / $)</th>
                  <th className="py-2.5 px-3 text-right">Fees / Rent</th>
                  <th className="py-2.5 px-3 text-right">Net PnL (SOL / $)</th>
                  <th className="py-2.5 px-3 text-right">PnL %</th>
                  <th className="py-2.5 px-3">Exit reason</th>
                  <th className="py-2.5 px-3">Coin key</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] font-mono tabular-nums">
                {trades.map((t) => {
                  const isSelected = t.id === selectedId;
                  const isBuy = t.action === 'BUY';
                  const pnlUsd = t.net_pnl_usd ?? t.pnl_usd;
                  const pnlSol = t.net_pnl_sol ?? t.pnl_sol;
                  const rowFeeRentSol =
                    Number(t.base_fee_sol || 0) +
                    Number(t.priority_fee_sol || 0) +
                    Number(t.rent_paid_sol || 0);
                  const toneClass = isBuy
                    ? 'text-[var(--blue)] font-semibold'
                    : pnlUsd !== null && pnlUsd > 0
                    ? 'text-[var(--green)] font-semibold'
                    : pnlUsd !== null && pnlUsd < 0
                    ? 'text-[var(--red)] font-semibold'
                    : 'text-[var(--text)]';

                  return (
                    <tr
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className={`h-[38px] cursor-pointer transition-colors ${
                        isSelected ? 'bg-[var(--teal)]/12' : 'hover:bg-[var(--card-hover)]'
                      }`}
                    >
                      <td className="py-2 px-3 text-[var(--muted)] whitespace-nowrap">
                        {formatTime(t.time)}
                      </td>
                      <td className={`py-2 px-3 whitespace-nowrap ${toneClass}`}>
                        {t.action}
                      </td>
                      <td className="py-2 px-3 font-sans font-semibold text-[var(--text)] whitespace-nowrap">
                        <div>{t.symbol}</div>
                        {t.trade_id && (
                          <div className="font-mono text-[10px] font-normal text-[var(--dim)]">
                            #{t.trade_id.slice(0, 8)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--text)] whitespace-nowrap">
                        {fmtPrice(t.price)}
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--text)] whitespace-nowrap">
                        {t.sol_amount !== undefined ? `${t.sol_amount.toFixed(4)} SOL · ` : ''}
                        <span className="text-[var(--muted)]">{fmtMoney(t.usd)}</span>
                      </td>
                      <td className="py-2 px-3 text-right text-[var(--muted)] whitespace-nowrap">
                        {rowFeeRentSol > 0 ? `${rowFeeRentSol.toFixed(5)} SOL` : '—'}
                      </td>
                      <td className={`py-2 px-3 text-right whitespace-nowrap ${toneClass}`}>
                        {pnlSol !== undefined && pnlSol !== null
                          ? `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL · `
                          : ''}
                        {pnlUsd !== null && pnlUsd !== undefined ? fmtMoney(pnlUsd, true) : ''}
                        {t.estimated && (
                          <span
                            title="Estimated valuation (not settled from a confirmed on-chain swap fill)"
                            className="ml-1.5 px-1 py-0.2 rounded bg-[var(--orange)]/20 text-[var(--orange)] text-[10px] font-bold"
                          >
                            est.
                          </span>
                        )}
                      </td>
                      <td className={`py-2 px-3 text-right whitespace-nowrap ${toneClass}`}>
                        {t.pnl_pct !== null && t.pnl_pct !== undefined
                          ? `${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(2)}%`
                          : ''}
                      </td>
                      <td className="py-2 px-3 font-sans text-[11px] text-[var(--muted)] whitespace-nowrap">
                        <span>{t.reason}</span>
                        {t.explorer_url && (
                          <a
                            href={t.explorer_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="ml-2 text-[var(--teal)] hover:underline font-mono"
                          >
                            tx
                          </a>
                        )}
                      </td>
                      <td className="py-2 px-3 text-[11px] text-[var(--muted)] max-w-[320px] truncate">
                        {t.mint}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bottom Action Bar */}
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

          <a
            href="/api/export/trades_log.csv"
            download="trades_log.csv"
            className="px-3 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:bg-[var(--card-hover)] text-xs font-medium text-[var(--text)] flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download size={13} />
            <span>Download CSV</span>
          </a>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="px-3 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:bg-[var(--card-hover)] text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="text-xs font-medium text-[var(--dim)] tabular-nums">
          {trades.length} trade row{trades.length === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  );
};
