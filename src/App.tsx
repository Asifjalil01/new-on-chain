import React from 'react';
import { BotProvider, useBot, SniperTabId } from './context/BotContext';
import { HeaderBar } from './components/HeaderBar';
import { DashboardView } from './components/DashboardView';
import { HistoryView } from './components/HistoryView';
import { ScanLogView } from './components/ScanLogView';
import { SettingsView } from './components/SettingsView';
import { WalletsView } from './components/WalletsView';
import { WalletConnectModal } from './components/WalletConnectModal';
import { LiveConfirmModal } from './components/LiveConfirmModal';
import { fmtMoney, fmtSol } from './utils/formatters';

function BotAppContent() {
  const {
    currentTab,
    navigateToTab,
    positions,
    portfolio,
    status,
    config,
    toastMessage,
    executionProgress,
    isWalletModalOpen,
    setIsWalletModalOpen,
    selectActiveWallet,
  } = useBot();

  const solPrice = Number(status?.sol_price_usd || portfolio?.sol_price_usd || 145);
  const cashSol = portfolio.cash_sol ?? (solPrice > 0 ? portfolio.cash / solPrice : 0);
  const valueSol = portfolio.value_sol ?? (solPrice > 0 ? portfolio.value / solPrice : 0);
  const openPnlSol = portfolio.open_pnl_sol ?? (solPrice > 0 ? portfolio.open_pnl / solPrice : 0);
  const dayPnlSol = portfolio.day_pnl_sol ?? (solPrice > 0 ? portfolio.day_pnl / solPrice : 0);
  const totalPnlSol = portfolio.total_pnl_sol ?? (solPrice > 0 ? portfolio.total_pnl / solPrice : 0);
  const isLiveMode = config.EXECUTION_MODE === 'live';

  const tradeSizeSol =
    config.sizing_basis === 'sol' && Number(config.trade_size_sol) > 0
      ? Number(config.trade_size_sol)
      : Number(config.trade_size_usd || 5) / solPrice;
  const tradeSizeUsd =
    config.sizing_basis === 'sol' && Number(config.trade_size_sol) > 0
      ? Number(config.trade_size_sol) * solPrice
      : Number(config.trade_size_usd || 5);

  const kpiCards = [
    {
      key: 'cash',
      label: isLiveMode ? 'Wallet cash' : 'Cash',
      value: isLiveMode ? fmtSol(cashSol) : fmtMoney(portfolio.cash),
      sub: isLiveMode ? fmtMoney(portfolio.cash) : fmtSol(cashSol),
      tone: 'neutral' as const,
    },
    {
      key: 'value',
      label: 'Est. total value',
      value: isLiveMode ? fmtSol(valueSol) : fmtMoney(portfolio.value),
      sub: isLiveMode ? fmtMoney(portfolio.value) : fmtSol(valueSol),
      tone: 'neutral' as const,
    },
    {
      key: 'open_pnl',
      label: 'Open PnL (est.)',
      value: isLiveMode ? fmtSol(openPnlSol, true) : fmtMoney(portfolio.open_pnl, true),
      sub: isLiveMode ? fmtMoney(portfolio.open_pnl, true) : fmtSol(openPnlSol, true),
      tone: portfolio.open_pnl > 0 ? 'green' : portfolio.open_pnl < 0 ? 'red' : 'neutral',
    },
    {
      key: 'day',
      label: "Today's PnL",
      value: isLiveMode ? fmtSol(dayPnlSol, true) : fmtMoney(portfolio.day_pnl, true),
      sub: isLiveMode ? fmtMoney(portfolio.day_pnl, true) : fmtSol(dayPnlSol, true),
      tone: portfolio.day_pnl > 0 ? 'green' : portfolio.day_pnl < 0 ? 'red' : 'neutral',
    },
    {
      key: 'total',
      label: 'Realized PnL',
      value: isLiveMode ? fmtSol(totalPnlSol, true) : fmtMoney(portfolio.total_pnl, true),
      sub: isLiveMode ? fmtMoney(portfolio.total_pnl, true) : fmtSol(totalPnlSol, true),
      tone: portfolio.total_pnl > 0 ? 'green' : portfolio.total_pnl < 0 ? 'red' : 'neutral',
    },
    {
      key: 'winrate',
      label: 'Win rate',
      value: portfolio.winrate || 'no closed trades',
      sub: `SOL: $${solPrice.toFixed(2)}`,
      tone: 'neutral' as const,
    },
  ];

  const tabs: { id: SniperTabId; label: string; count?: number }[] = [
    { id: 'open_positions', label: 'Open positions', count: positions.length },
    { id: 'trade_history', label: 'Trade history' },
    { id: 'scan_log', label: 'Scan log' },
    { id: 'settings', label: 'Settings' },
    { id: 'wallets', label: 'Wallets' },
  ];

  return (
    <div className="w-screen h-screen flex flex-col bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      {/* Top HeaderBar matching gui.py */}
      <HeaderBar />

      {/* 6 KPI Cards Row matching gui.py (SOL & $ side by side) */}
      <section className="px-5 pt-4 pb-2 shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {kpiCards.map((card) => (
            <div
              key={card.key}
              className="bg-[var(--card)] border border-[var(--border)] rounded-lg px-3.5 py-2.5 flex flex-col justify-between"
            >
              <span className="text-[11px] font-medium text-[var(--dim)] whitespace-nowrap truncate">
                {card.label}
              </span>
              <div className="flex items-baseline justify-between gap-2 mt-0.5 min-w-0">
                <span
                  className={`text-base font-bold font-mono tabular-nums whitespace-nowrap truncate ${
                    card.tone === 'green'
                      ? 'text-[var(--green)]'
                      : card.tone === 'red'
                      ? 'text-[var(--red)]'
                      : 'text-[var(--text)]'
                  }`}
                >
                  {card.value}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-[var(--muted)] whitespace-nowrap shrink-0">
                  {card.sub}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Live Swap Progress Banner */}
      {executionProgress && (
        <div className="mx-5 mt-1 px-3.5 py-2 rounded-lg border border-[var(--teal)]/50 bg-[var(--teal)]/10 text-xs flex items-center justify-between gap-2 shrink-0">
          <span className="font-semibold text-[var(--text)]">
            Live {executionProgress.action} · {executionProgress.token} · {executionProgress.step}
            {executionProgress.detail ? ` — ${executionProgress.detail}` : ''}
            {executionProgress.error ? ` — ${executionProgress.error}` : ''}
          </span>
        </div>
      )}

      {/* Clean 5-Tab Workspace Bar matching gui.py + Wallets */}
      <nav className="px-5 pt-2 border-b border-[var(--border)] flex items-center gap-1 shrink-0 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => navigateToTab(tab.id)}
              className={`px-4 py-2 text-xs font-semibold rounded-t-lg border-t border-x transition-colors cursor-pointer whitespace-nowrap shrink-0 -mb-px flex items-center gap-2 ${
                isActive
                  ? 'bg-[var(--card)] text-[var(--text)] border-[var(--border)] border-b-[var(--card)]'
                  : 'bg-transparent text-[var(--muted)] border-transparent hover:text-[var(--text)]'
              }`}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 && (
                <span className="font-mono text-[11px] text-[var(--teal)] tabular-nums">
                  ({tab.count})
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Active Tab Content Viewport */}
      <main className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        {currentTab === 'open_positions' && <DashboardView />}
        {currentTab === 'trade_history' && <HistoryView />}
        {currentTab === 'scan_log' && <ScanLogView />}
        {currentTab === 'settings' && <SettingsView />}
        {currentTab === 'wallets' && <WalletsView />}
      </main>

      {/* Bottom Status Message Bar matching gui.py self.msg */}
      <footer className="h-[28px] px-5 bg-[var(--panel)] border-t border-[var(--border)] flex items-center justify-between text-[11px] shrink-0">
        <span
          className={`truncate ${
            toastMessage?.tone === 'error'
              ? 'text-[var(--red)] font-semibold'
              : toastMessage?.tone === 'success'
              ? 'text-[var(--green)] font-semibold'
              : 'text-[var(--dim)]'
          }`}
        >
          {toastMessage ? toastMessage.text : 'Ready'}
        </span>
        <span className="text-[var(--dim)] font-mono whitespace-nowrap shrink-0 tabular-nums">
          Mode: {(config.EXECUTION_MODE || 'paper').toUpperCase()} · Max slots: {config.max_open_positions || 3} · Trade size: {fmtSol(tradeSizeSol)} ({fmtMoney(tradeSizeUsd)})
        </span>
      </footer>

      {/* Multi-Wallet Modal */}
      <WalletConnectModal
        isOpen={isWalletModalOpen}
        onClose={() => setIsWalletModalOpen(false)}
        onWalletSelected={(w) => selectActiveWallet(w.id)}
      />

      {/* Live Mode Confirmation Modal */}
      <LiveConfirmModal />
    </div>
  );
}

export function App() {
  return (
    <BotProvider>
      <BotAppContent />
    </BotProvider>
  );
}

export default App;
