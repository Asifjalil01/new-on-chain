/**
 * Exact fmt_price helper matching bot.py precision rules.
 */
export function fmtPrice(x: number | undefined | null): string {
  if (x === undefined || x === null || isNaN(x)) return '...';
  const n = Number(x);
  if (n === 0) return '$0.00';
  if (Math.abs(n) >= 1) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
  }
  const decimals = Math.min(10, Math.max(2, -Math.floor(Math.log10(Math.abs(n))) + 5));
  return `$${n.toFixed(decimals)}`;
}

/**
 * Exact money formatter matching gui.py (`money(x, sign)`).
 */
export function fmtMoney(x: number | undefined | null, sign = false): string {
  if (x === undefined || x === null || isNaN(x)) return '...';
  const abs = Math.abs(x);
  const formatted = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (sign) return `${x >= 0 ? '+' : '-'}${formatted}`;
  return `${x < 0 ? '-' : ''}${formatted}`;
}

/**
 * Formats SOL amounts cleanly with dynamic precision for tiny values (e.g. 0.00467 SOL).
 */
export function fmtSol(x: number | undefined | null, sign = false, decimals?: number): string {
  if (x === undefined || x === null || isNaN(x)) return '...';
  const n = Number(x);
  const abs = Math.abs(n);
  const dec =
    decimals !== undefined
      ? decimals
      : abs > 0 && abs < 0.01
      ? 5
      : abs < 1
      ? 4
      : 3;
  const formatted = `${abs.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(dec, 4),
    maximumFractionDigits: dec,
  })} SOL`;
  if (sign) return `${n >= 0 ? '+' : '-'}${formatted}`;
  return `${n < 0 ? '-' : ''}${formatted}`;
}

/**
 * Exact percentage formatter matching gui.py (`pct(x)`).
 */
export function fmtPct(x: number | undefined | null): string {
  if (x === undefined || x === null || isNaN(x)) return '...';
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
}

/**
 * Exact duration formatter matching gui.py (`fmt_held(minutes)`).
 */
export function fmtHeld(minutes: number | undefined | null): string {
  if (minutes === undefined || minutes === null || isNaN(minutes)) return '0m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Formats token price cleanly for wallets & legacy views.
 */
export function formatPrice(price: number | undefined | null): string {
  return fmtPrice(price);
}

/**
 * Formats financial values with full comma separators and exact decimal amounts.
 */
export function formatUsd(amount: number | undefined | null, forceDecimals?: number): string {
  if (amount === undefined || amount === null || isNaN(amount)) return '$0.00';

  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (forceDecimals !== undefined) {
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: forceDecimals, maximumFractionDigits: forceDecimals })}`;
  }

  if (abs > 0 && abs < 0.01) {
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 })}`;
  }

  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCryptoAmount(amount: number | undefined | null, symbol: string = 'SOL', maxDecimals: number = 4): string {
  if (amount === undefined || amount === null || isNaN(amount)) return `0.0000 ${symbol}`;
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxDecimals })} ${symbol}`;
}

export function formatTimeAgo(timestampMs: number): string {
  const elapsed = Math.floor((Date.now() - timestampMs) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
  return `${Math.floor(elapsed / 86400)}d`;
}
