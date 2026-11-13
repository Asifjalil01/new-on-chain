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
import { fmtMoney } from './utils/formatters';

function BotAppContent() {
  const {
    currentTab,
    navigateToTab,
    positions,
    portfolio,
    config,
    toastMessage,
    executionProgress,
    isWalletModalOpen,
    setIsWalletModalOpen,
    selectActiveWallet,
  } = useBot();

  const kpiCards = [
    {
      key: 'cash',
      label: config.EXECUTION_MODE === 'live' ? 'Wallet cash' : 'Cash',
      value: fmtMoney(portfolio.cash),
      tone: 'neutral' as const,
    },
    {
      key: 'value',
      label: 'Est. total value',
      value: fmtMoney(portfolio.value),
      tone: 'neutral' as const,
    },
    {
      key: 'open_pnl',
      label: 'Open PnL (est.)',
      value: fmtMoney(portfolio.open_pnl, true),
      tone: portfolio.open_pnl > 0 ? 'green' : portfolio.open_pnl < 0 ? 'red' : 'neutral',
    },
    {
      key: 'day',
      label: "Today's PnL",
      value: fmtMoney(portfolio.day_pnl, true),
      tone: portfolio.day_pnl > 0 ? 'green' : portfolio.day_pnl < 0 ? 'red' : 'neutral',
    },
    {
      key: 'total',
      label: 'Realized PnL',
      value: fmtMoney(portfolio.total_pnl, true),
      tone: portfolio.total_pnl > 0 ? 'green' : portfolio.total_pnl < 0 ? 'red' : 'neutral',
    },
    {
      key: 'winrate',
      label: 'Win rate',
      value: portfolio.winrate || 'no closed trades',
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

      {/* 6 KPI Cards Row matching gui.py */}
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
              <span
                className={`text-lg font-bold font-mono tabular-nums mt-0.5 whitespace-nowrap truncate ${
                  card.tone === 'green'
                    ? 'text-[var(--green)]'
                    : card.tone === 'red'
                    ? 'text-[var(--red)]'
                    : 'text-[var(--text)]'
                }`}
              >
                {card.value}
              </span>
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
          Mode: {(config.EXECUTION_MODE || 'paper').toUpperCase()} · Max slots: {config.max_open_positions || 3} · Trade size: ${config.trade_size_usd || 5}
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
