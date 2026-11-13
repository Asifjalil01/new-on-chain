import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, RotateCcw, Save, X } from 'lucide-react';
import { useBot } from '../context/BotContext';

interface SettingField {
  key: string;
  label: string;
  kind: 'float' | 'int' | 'bool' | 'string';
}

const SETTING_FIELDS: SettingField[] = [
  { key: 'start_balance_usd', label: 'Start balance $ (used on reset)', kind: 'float' },
  { key: 'trade_size_usd', label: 'Trade size $', kind: 'float' },
  { key: 'max_open_positions', label: 'Max open positions', kind: 'int' },
  { key: 'daily_loss_limit_usd', label: 'Daily loss limit $', kind: 'float' },
  { key: 'take_profit_pct', label: 'Take profit % (0 = off)', kind: 'float' },
  { key: 'trailing_stop_pct', label: 'Trailing stop % from peak (0 = off)', kind: 'float' },
  { key: 'max_hold_minutes', label: 'Max hold (minutes)', kind: 'int' },
  { key: 'max_age_minutes', label: 'Sniper window: max coin age (minutes)', kind: 'float' },
  { key: 'ultra_early_grace_sec', label: 'Ultra-early grace (sec)', kind: 'int' },
  { key: 'scan_interval_sec', label: 'Scan for new coins every (sec)', kind: 'int' },
  { key: 'monitor_interval_sec', label: 'Price check every (sec)', kind: 'float' },
  { key: 'min_liquidity_usd', label: 'Min liquidity $', kind: 'float' },
  { key: 'min_buys_m5', label: 'Min buys last 5 min', kind: 'int' },
  { key: 'min_buy_sell_ratio_m5', label: 'Min buy/sell ratio (5 min)', kind: 'float' },
  { key: 'max_price_change_m5_pct', label: 'Skip if pumped +X% in 5 min', kind: 'float' },
  { key: 'min_volume_m5_usd', label: 'Min 5-min volume $ (0 = off)', kind: 'float' },
  { key: 'min_holders', label: 'Min buys in last 1h (0 = off)', kind: 'int' },
  { key: 'use_rugcheck', label: 'Hard RugCheck (score + risks)', kind: 'bool' },
  { key: 'strict_rugcheck', label: 'Strict: reject ANY danger risk', kind: 'bool' },
  { key: 'rugcheck_max_score', label: 'Max RugCheck risk score (0-100)', kind: 'float' },
  { key: 'max_top10_holder_pct', label: 'Max top-10 holders %', kind: 'float' },
  { key: 'rug_recheck_minutes', label: 'Recheck rug score every (min)', kind: 'int' },
  { key: 'use_gecko', label: 'Source: GeckoTerminal new pools (all DEXes)', kind: 'bool' },
  { key: 'use_jupiter_recent', label: 'Source: Jupiter recent tokens', kind: 'bool' },
  { key: 'use_jupiter_price', label: 'Use Jupiter live prices', kind: 'bool' },
  { key: 'use_dex_profiles', label: 'Source: DexScreener token profiles', kind: 'bool' },
  { key: 'use_pumpportal', label: 'Source: PumpPortal new launches', kind: 'bool' },
  { key: 'use_promoted_feeds', label: 'Source: DexScreener boosted (promoted)', kind: 'bool' },
  { key: 'slippage_pct', label: 'Simulated slippage %', kind: 'float' },
  { key: 'fee_pct', label: 'Simulated fee %', kind: 'float' },
  { key: 'log_rejects', label: 'Log filtered-out coins (debug)', kind: 'bool' },
];

const LIMITS: Record<string, [number, number]> = {
  start_balance_usd: [1, 1e7],
  trade_size_usd: [0.5, 1e6],
  max_open_positions: [1, 50],
  daily_loss_limit_usd: [0, 1e7],
  take_profit_pct: [0, 1e5],
  trailing_stop_pct: [0, 1000],
  max_hold_minutes: [1, 1e5],
  max_age_minutes: [0.05, 60],
  ultra_early_grace_sec: [0, 300],
  scan_interval_sec: [1, 3600],
  monitor_interval_sec: [0.2, 60],
  min_liquidity_usd: [0, 1e9],
  min_buys_m5: [0, 1e6],
  min_buy_sell_ratio_m5: [0, 100],
  max_price_change_m5_pct: [0, 1e6],
  min_volume_m5_usd: [0, 1e9],
  min_holders: [0, 1e6],
  rugcheck_max_score: [0, 100],
  max_top10_holder_pct: [0, 100],
  rug_recheck_minutes: [1, 1440],
  slippage_pct: [0, 50],
  fee_pct: [0, 50],
};

export const SettingsView: React.FC = () => {
  const { config, isBotStopped, handleSaveConfig, handleResetAccount, say } = useBot();

  const [values, setValues] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const next: Record<string, any> = {};
    for (const f of SETTING_FIELDS) {
      const v = config[f.key];
      next[f.key] = f.kind === 'bool' ? Boolean(v) : v !== undefined && v !== null ? String(v) : '';
    }
    next.jupiter_api_key = config.jupiter_api_key || '';
    next.MAX_POSITION_SIZE_USD = String(config.MAX_POSITION_SIZE_USD ?? 100);
    next.MIN_GAS_RESERVE_SOL = String(config.MIN_GAS_RESERVE_SOL ?? 0.01);
    next.PRIORITY_FEE_LEVEL = config.PRIORITY_FEE_LEVEL || 'standard';
    setValues(next);
  }, [config]);

  const handleFieldChange = (key: string, val: any) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors([]);
    setSavedBanner(null);

    const errs: string[] = [];
    const payload: Record<string, any> = {};

    for (const f of SETTING_FIELDS) {
      const rawVal = values[f.key];
      if (f.kind === 'bool') {
        payload[f.key] = Boolean(rawVal);
        continue;
      }
      const num = Number(rawVal);
      if (rawVal === '' || rawVal === undefined || isNaN(num)) {
        errs.push(`${f.label}: not a valid number`);
        continue;
      }
      const converted = f.kind === 'int' ? Math.trunc(num) : num;
      const bounds = LIMITS[f.key];
      if (bounds && (converted < bounds[0] || converted > bounds[1])) {
        errs.push(`${f.label}: must be between ${bounds[0]} and ${bounds[1]}`);
        continue;
      }
      payload[f.key] = converted;
    }

    const maxPosUsd = Number(values.MAX_POSITION_SIZE_USD);
    if (!isNaN(maxPosUsd) && maxPosUsd > 0) payload.MAX_POSITION_SIZE_USD = maxPosUsd;
    const minGasSol = Number(values.MIN_GAS_RESERVE_SOL);
    if (!isNaN(minGasSol) && minGasSol >= 0) payload.MIN_GAS_RESERVE_SOL = minGasSol;
    payload.PRIORITY_FEE_LEVEL = values.PRIORITY_FEE_LEVEL || 'standard';

    if (typeof values.jupiter_api_key === 'string' && !values.jupiter_api_key.includes('***')) {
      payload.jupiter_api_key = values.jupiter_api_key.trim();
    }

    if (errs.length > 0) {
      setErrors(errs);
      return;
    }

    setIsSaving(true);
    try {
      const res = await handleSaveConfig(payload);
      if (res.success) {
        setSavedBanner('Settings applied and saved.');
        say('Settings applied and saved.', 'success');
      } else if (res.error) {
        setErrors(res.error.split('\n'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const requestReset = () => {
    if (!isBotStopped) {
      say("Stop the bot first: press 'Stop bot', then reset the paper account.", 'error', 5000);
      return;
    }
    setConfirmReset(true);
  };

  const executeReset = async () => {
    const ok = await handleResetAccount();
    if (ok) {
      setConfirmReset(false);
    }
  };

  const half = Math.ceil(SETTING_FIELDS.length / 2);
  const leftFields = SETTING_FIELDS.slice(0, half);
  const rightFields = SETTING_FIELDS.slice(half);

  const renderField = (field: SettingField) => {
    const val = values[field.key];
    return (
      <div
        key={field.key}
        className="flex items-center justify-between gap-4 py-1.5 border-b border-[var(--border)]/60 last:border-b-0"
      >
        <label htmlFor={`setting-${field.key}`} className="text-xs text-[var(--text)] leading-snug">
          {field.label}
        </label>
        {field.kind === 'bool' ? (
          <input
            id={`setting-${field.key}`}
            type="checkbox"
            checked={Boolean(val)}
            onChange={(e) => handleFieldChange(field.key, e.target.checked)}
            className="w-4 h-4 accent-[var(--teal)] cursor-pointer shrink-0"
          />
        ) : (
          <input
            id={`setting-${field.key}`}
            type="text"
            inputMode="decimal"
            value={val ?? ''}
            onChange={(e) => handleFieldChange(field.key, e.target.value)}
            className="w-28 bg-[var(--panel)] border border-[var(--border-bright)] rounded px-2.5 py-1 text-xs font-mono text-right text-[var(--text)] focus:outline-none focus:border-[var(--teal)] tabular-nums shrink-0"
          />
        )}
      </div>
    );
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex-1 flex flex-col min-h-0 min-w-0 overflow-y-auto p-4 gap-4 bg-[var(--bg)]"
    >
      {/* Validation Errors */}
      {errors.length > 0 && (
        <div className="p-3 rounded-lg border border-[var(--red)] bg-[var(--red)]/10 text-xs text-[var(--red)] space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={14} />
            <span>Check your settings:</span>
          </div>
          <ul className="list-disc list-inside space-y-0.5 pl-1">
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Saved Confirmation */}
      {savedBanner && (
        <div className="p-2.5 rounded-lg border border-[var(--green)]/40 bg-[var(--green)]/10 text-xs text-[var(--green)] flex items-center gap-2 font-medium">
          <CheckCircle2 size={14} />
          <span>{savedBanner}</span>
        </div>
      )}

      {/* Inline Reset Confirmation */}
      {confirmReset && (
        <div className="p-3 rounded-lg border border-[var(--red)]/50 bg-[var(--red)]/10 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="font-medium text-[var(--text)]">
            Reset paper account: this deletes all open paper positions and trade history. Continue?
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={executeReset}
              className="px-3 py-1 rounded bg-[var(--red)] text-white font-semibold cursor-pointer hover:brightness-110 whitespace-nowrap"
            >
              Confirm reset
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="px-3 py-1 rounded border border-[var(--border-bright)] bg-[var(--card)] text-[var(--text)] cursor-pointer flex items-center gap-1 whitespace-nowrap"
            >
              <X size={12} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}

      {/* Two-Column Settings Grid matching gui.py */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-5">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-1">
          <div>{leftFields.map(renderField)}</div>
          <div>{rightFields.map(renderField)}</div>
        </div>

        {/* Live Mode & API Optional Fields */}
        <div className="mt-5 pt-4 border-t border-[var(--border)] grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-[11px] font-medium text-[var(--dim)] mb-1">
              Jupiter API key (optional)
            </label>
            <input
              type="password"
              value={values.jupiter_api_key ?? ''}
              placeholder="Optional x-api-key"
              onChange={(e) => handleFieldChange('jupiter_api_key', e.target.value)}
              className="w-full bg-[var(--panel)] border border-[var(--border-bright)] rounded px-2.5 py-1.5 text-xs font-mono text-[var(--text)] focus:outline-none focus:border-[var(--teal)]"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[var(--dim)] mb-1">
              Live max position size ($)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={values.MAX_POSITION_SIZE_USD ?? '100'}
              onChange={(e) => handleFieldChange('MAX_POSITION_SIZE_USD', e.target.value)}
              className="w-full bg-[var(--panel)] border border-[var(--border-bright)] rounded px-2.5 py-1.5 text-xs font-mono text-[var(--text)] focus:outline-none focus:border-[var(--teal)] tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[var(--dim)] mb-1">
              Live min gas reserve (SOL)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={values.MIN_GAS_RESERVE_SOL ?? '0.01'}
              onChange={(e) => handleFieldChange('MIN_GAS_RESERVE_SOL', e.target.value)}
              className="w-full bg-[var(--panel)] border border-[var(--border-bright)] rounded px-2.5 py-1.5 text-xs font-mono text-[var(--text)] focus:outline-none focus:border-[var(--teal)] tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[var(--dim)] mb-1">
              Live priority fee level
            </label>
            <select
              value={values.PRIORITY_FEE_LEVEL || 'standard'}
              onChange={(e) => handleFieldChange('PRIORITY_FEE_LEVEL', e.target.value)}
              className="w-full bg-[var(--panel)] border border-[var(--border-bright)] rounded px-2.5 py-1.5 text-xs font-medium text-[var(--text)] focus:outline-none focus:border-[var(--teal)] cursor-pointer"
            >
              <option value="standard">Standard</option>
              <option value="high">High</option>
              <option value="ultra">Ultra</option>
            </select>
          </div>
        </div>
      </div>

      {/* Action Buttons matching gui.py */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <button
          type="submit"
          disabled={isSaving}
          className="px-4 py-2 rounded-lg bg-[var(--teal)] text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer hover:brightness-110 disabled:opacity-50 whitespace-nowrap"
        >
          <Save size={13} />
          <span>{isSaving ? 'Saving...' : 'Apply and save'}</span>
        </button>

        <button
          type="button"
          onClick={requestReset}
          className="px-4 py-2 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:bg-[var(--card-hover)] text-xs font-medium text-[var(--text)] flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
        >
          <RotateCcw size={13} />
          <span>Reset paper account...</span>
        </button>
      </div>
    </form>
  );
};
