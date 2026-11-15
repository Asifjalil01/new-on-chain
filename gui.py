#!/usr/bin/env python3
"""
Solana Spot & Sniper Bot Desktop GUI.
Features:
- Side-by-side Dual Input Fields for SOL ⇆ $ (Start balance, Trade size, Daily loss limit).
- Real-time bidirectional auto-conversion between SOL and USD using live market price.
- Dual Modes: Paper Trading (Simulation) & Live Trading (Phantom Wallet via Browser Bridge).
- One-click Phantom Wallet pairing with live SOL balance.
- Live Jupiter swap execution and signature prompts.
- Real-time PnL tracking, DexScreener charts, and Solscan explorer links.
- Graceful Rug write-off for dead pools with zero liquidity (NO_ROUTES_FOUND fix).
"""

import csv
import json
import os
import queue
import sys
import threading
import time
import webbrowser
from datetime import datetime

try:
    import tkinter as tk
    from tkinter import messagebox, ttk
except ImportError:
    tk = ttk = messagebox = None

import bot

SETTINGS_FILE = "sniper_settings.json"

# Dual paired settings (rendered side-by-side as in the screenshot)
DUAL_SETTINGS = [
    ("start_balance", "start_balance_sol", "start_balance_usd", "Start balance (used on reset)", 0.3448, 50.0),
    ("trade_size", "trade_size_sol", "trade_size_usd", "Trade size per coin", 0.020, 5.0),
    ("daily_loss_limit", "daily_loss_limit_sol", "daily_loss_limit_usd", "Daily loss limit", 0.069, 10.0),
]

# Standard settings
STANDARD_SETTINGS = [
    ("execution_mode", "Trading Mode (paper / live)", "str"),
    ("sizing_basis", "Sizing Basis (sol / usd)", "str"),
    ("max_open_positions", "Max Open Positions", "int"),
    ("take_profit_pct", "Take Profit % (0 = off)", "float"),
    ("trailing_profit_mode", "Trail Peak after TP reached (Let runners pump)", "bool"),
    ("trailing_stop_pct", "Trailing Stop % from peak", "float"),
    ("stop_loss_pct", "Stop Loss % (protects down-draws)", "float"),
    ("rug_exit_drop_pct", "Emergency Rug Exit on peak drop %", "float"),
    ("max_hold_minutes", "Max Hold Time (minutes)", "int"),
    ("max_age_minutes", "Sniper Window: Max Coin Age (minutes)", "float"),
    ("ultra_early_grace_sec", "Ultra-Early Grace (sec, skips floors)", "int"),
    ("scan_interval_sec", "Scan Interval (sec)", "int"),
    ("monitor_interval_sec", "Price Check Interval (sec)", "float"),
    ("min_liquidity_usd", "Min Liquidity ($)", "float"),
    ("min_buys_m5", "Min Buys in 5m", "int"),
    ("min_buy_sell_ratio_m5", "Min Buy/Sell Ratio (5m)", "float"),
    ("max_price_change_m5_pct", "Skip if pumped > +X% (5m)", "float"),
    ("min_volume_m5_usd", "Min 5m Volume ($)", "float"),
    ("min_holders", "Min 1h Buys (0 = off)", "int"),
    ("use_rugcheck", "Enable RugCheck score screen", "bool"),
    ("strict_rugcheck", "Strict RugCheck (reject danger risks)", "bool"),
    ("rugcheck_max_score", "Max RugCheck Risk Score (0-100)", "float"),
    ("max_top10_holder_pct", "Max Top-10 Holders %", "float"),
    ("rug_recheck_minutes", "Recheck Rug Score Every (min)", "int"),
    ("use_gecko", "Source: GeckoTerminal New Pools", "bool"),
    ("use_jupiter_recent", "Source: Jupiter Recent Tokens", "bool"),
    ("use_dex_profiles", "Source: DexScreener Profiles", "bool"),
    ("use_pumpportal", "Source: PumpPortal (currently disabled)", "bool"),
    ("use_promoted_feeds", "Source: DexScreener Boosted Feeds", "bool"),
    ("use_jupiter_price", "Use Jupiter live prices", "bool"),
    ("slippage_pct", "Slippage %", "float"),
    ("priority_fee_lamports", "Solana Priority Fee (lamports)", "int"),
    ("min_gas_reserve_sol", "Min Gas Reserve (SOL)", "float"),
    ("log_rejects", "Log Filtered Coins (Debug)", "bool"),
]

LIMITS = {
    "start_balance_sol": (0.0001, 1e6),
    "start_balance_usd": (0.01, 1e7),
    "trade_size_sol": (0.0001, 100.0),
    "trade_size_usd": (0.01, 1e6),
    "daily_loss_limit_sol": (0.0001, 500.0),
    "daily_loss_limit_usd": (0.01, 1e7),
    "max_open_positions": (1, 50),
    "take_profit_pct": (0, 1e5),
    "trailing_stop_pct": (0, 1000),
    "stop_loss_pct": (0, 100),
    "rug_exit_drop_pct": (10, 100),
    "max_hold_minutes": (1, 1e5),
    "max_age_minutes": (0.05, 120),
    "ultra_early_grace_sec": (0, 300),
    "scan_interval_sec": (1, 3600),
    "monitor_interval_sec": (0.2, 60),
    "min_liquidity_usd": (0, 1e9),
    "min_buys_m5": (0, 1e6),
    "min_buy_sell_ratio_m5": (0, 100),
    "max_price_change_m5_pct": (0, 1e6),
    "min_volume_m5_usd": (0, 1e9),
    "min_holders": (0, 1e6),
    "rugcheck_max_score": (0, 100),
    "max_top10_holder_pct": (0, 100),
    "rug_recheck_minutes": (1, 1440),
    "slippage_pct": (0.1, 50),
    "priority_fee_lamports": (0, 10000000),
    "min_gas_reserve_sol": (0.0005, 1.0),
}

def convert(value, kind):
    if kind == "bool":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if kind == "int":
        return int(float(value))
    if kind == "str":
        return str(value).strip().lower()
    return float(value)

def parse_settings(raw):
    parsed, errors = {}, []

    # Check Dual settings
    for _, sol_k, usd_k, label, _, _ in DUAL_SETTINGS:
        for k in (sol_k, usd_k):
            if k in raw:
                try:
                    val = convert(raw[k], "float")
                    lo, hi = LIMITS[k]
                    if not (lo <= val <= hi):
                        errors.append(f"{label} ({k}): must be between {lo:g} and {hi:g}")
                    else:
                        parsed[k] = val
                except (ValueError, TypeError):
                    errors.append(f"{label} ({k}): invalid number")

    # Check Standard settings
    for key, label, kind in STANDARD_SETTINGS:
        if key not in raw:
            continue
        try:
            val = convert(raw[key], kind)
        except (KeyError, ValueError, TypeError):
            errors.append(f"{label}: not a valid value")
            continue
        if kind in ("float", "int") and key in LIMITS:
            lo, hi = LIMITS[key]
            if not (lo <= val <= hi):
                errors.append(f"{label}: must be between {lo:g} and {hi:g}")
                continue
        if key == "execution_mode" and val not in ("paper", "live"):
            errors.append("Trading Mode must be either 'paper' or 'live'")
            continue
        parsed[key] = val

    return parsed, errors

def load_settings():
    if not os.path.exists(SETTINGS_FILE):
        return
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            bot.CONFIG.update(data)
    except Exception:
        pass

def save_settings():
    try:
        keys_to_save = {}
        for _, sol_k, usd_k, _, _, _ in DUAL_SETTINGS:
            keys_to_save[sol_k] = bot.CONFIG.get(sol_k)
            keys_to_save[usd_k] = bot.CONFIG.get(usd_k)
        for key, _, _ in STANDARD_SETTINGS:
            keys_to_save[key] = bot.CONFIG.get(key)

        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(keys_to_save, f, indent=2)
    except Exception:
        pass

def money(x, sign=False, unit="$"):
    if x is None:
        return "..."
    if unit == "SOL":
        s = f"{abs(x):.4f} SOL"
    else:
        s = f"${abs(x):,.2f}"
    if sign:
        return ("+" if x >= 0 else "-") + s
    return ("-" if x < 0 else "") + s

def pct(x):
    return "..." if x is None else f"{x:+.2f}%"

def fmt_held(minutes):
    if minutes < 60:
        return f"{minutes:.0f}m"
    return f"{int(minutes // 60)}h {int(minutes % 60):02d}m"

def position_rows(acct, prices):
    cfg = acct.cfg
    with acct.lock:
        items = [(m, dict(p)) for m, p in acct.state["positions"].items()]
    rows = []
    for mint, p in items:
        entry = p["entry_price"]
        price = prices.get(mint)
        chg = pnl = value = None
        is_live = p.get("is_live", False)
        cost_unit = p.get("cost_unit", "SOL" if is_live else "USD")

        if price:
            chg = (price / entry - 1) * 100
            if is_live:
                pnl = (chg / 100.0) * p["cost"]
                value = p["cost"] + pnl
            else:
                value = p["qty"] * price * (1 - cfg["slippage_pct"] / 100) * (1 - cfg["fee_pct"] / 100)
                pnl = value - p["cost"]

        rows.append({
            "mint": mint,
            "symbol": p["symbol"],
            "entry": entry,
            "now": price,
            "chg": chg,
            "pnl": pnl,
            "value": value,
            "cost": p["cost"],
            "cost_unit": cost_unit,
            "is_live": is_live,
            "peak": (p.get("peak_price", entry) / entry - 1) * 100,
            "low": (p.get("low_price", entry) / entry - 1) * 100,
            "held": (time.time() - p["opened"]) / 60,
            "buy_sig": p.get("buy_sig", ""),
        })
    return rows

def account_stats(acct, rows):
    s = acct.state
    cfg = acct.cfg
    mode = cfg.get("execution_mode", "paper")
    open_pnl = sum(r["pnl"] for r in rows if r["pnl"] is not None)
    open_value = sum(r["value"] if r["value"] is not None else r["cost"] for r in rows)
    wins, closed = s.get("wins", 0), s.get("closed", 0)

    sol_price = bot.get_sol_price(cfg)

    if mode == "live":
        sol_bal = bot.BRIDGE.sol_balance if bot.BRIDGE.is_connected() else 0.0
        sol_usd = sol_bal * sol_price
        return {
            "mode": "LIVE (Phantom)",
            "cash": f"{sol_bal:.4f} SOL (${sol_usd:.2f})",
            "value": f"{sol_bal + open_value:.4f} SOL",
            "open_pnl": f"{open_pnl:+.4f} SOL" if rows else "0.0000 SOL",
            "open_pnl_num": open_pnl,
            "day": f"{s.get('day_pnl', 0.0):+.4f} SOL",
            "day_num": s.get('day_pnl', 0.0),
            "total": f"{s.get('total_pnl', 0.0):+.4f} SOL",
            "total_num": s.get('total_pnl', 0.0),
            "winrate": f"{wins / closed * 100:.0f}% ({wins}/{closed})" if closed else "no trades",
        }
    else:
        cash_val = s.get("cash", 50.0)
        cash_sol = cash_val / max(sol_price, 1.0)
        return {
            "mode": "PAPER (Simulation)",
            "cash": f"{money(cash_val)} ({cash_sol:.4f} SOL)",
            "value": money(cash_val + open_value),
            "open_pnl": money(open_pnl, True),
            "open_pnl_num": open_pnl,
            "day": money(s.get("day_pnl", 0.0), True),
            "day_num": s.get('day_pnl', 0.0),
            "total": money(s.get("total_pnl", 0.0), True),
            "total_num": s.get('total_pnl', 0.0),
            "winrate": f"{wins / closed * 100:.0f}% ({wins}/{closed})" if closed else "no trades",
        }

def read_trades(path, limit=500):
    if not os.path.exists(path):
        return []
    out = []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) < 9 or row[0] == "time":
                    continue
                try:
                    when = datetime.fromisoformat(row[0]).astimezone().strftime("%m-%d %H:%M:%S")
                except Exception:
                    when = row[0][:16]
                action = row[1]
                symbol = row[2]
                mint = row[3]
                price = row[4]
                amount = row[5]
                pnl = row[6]
                pnl_pct = f"{row[7]}%" if row[7] else ""
                reason = row[8]
                explorer = row[9] if len(row) > 9 else ""
                mode_col = row[12] if len(row) > 12 else ("live" if "solscan" in explorer else "paper")
                out.append((when, mode_col.upper(), action, symbol, price, amount, pnl, pnl_pct, reason, explorer, mint))
    except Exception:
        pass
    return out[-limit:][::-1]


# ==============================================================================
# DUAL SOL ⇆ USD COMPONENT (SIDE-BY-SIDE AS IN SCREENSHOT)
# ==============================================================================

class DualSolUsdRow(tk.Frame if tk else object):
    """
    Renders an exact side-by-side Dual Input row:
    Label  [  0.035 SOL ]  ⇆  [ $  5.00 ]
    with real-time bidirectional automatic price conversion!
    """
    def __init__(self, parent, label_text, sol_var, usd_var, get_sol_price_fn, bg="#0f111a"):
        if tk:
            super().__init__(parent, bg=bg)
        self.sol_var = sol_var
        self.usd_var = usd_var
        self.get_sol_price = get_sol_price_fn
        self._updating = False

        # Left: Setting Label
        lbl = tk.Label(self, text=label_text, bg=bg, fg="#e2e8f0", font=("Segoe UI", 10), anchor="w")
        lbl.pack(side="left", fill="x", expand=True, pady=4)

        # Right: Dual Input Box Container
        box_wrap = tk.Frame(self, bg=bg)
        box_wrap.pack(side="right", pady=4)

        # 1. SOL Box: [ 0.0350  SOL ]
        sol_frame = tk.Frame(box_wrap, bg="#161926", highlightbackground="#2e3550", highlightthickness=1)
        sol_frame.pack(side="left", padx=(0, 6))

        self.sol_entry = tk.Entry(
            sol_frame, textvariable=self.sol_var, width=10,
            font=("Consolas", 10, "bold"), bg="#161926", fg="#f3f4f6",
            bd=0, justify="right", insertbackground="#f3f4f6"
        )
        self.sol_entry.pack(side="left", padx=(8, 4), pady=5)

        sol_tag = tk.Label(sol_frame, text="SOL", bg="#161926", fg="#10b981", font=("Segoe UI", 9, "bold"))
        sol_tag.pack(side="left", padx=(0, 8))

        # 2. Swap Icon: ⇆
        arrow_lbl = tk.Label(box_wrap, text="⇆", bg=bg, fg="#94a3b8", font=("Segoe UI", 12))
        arrow_lbl.pack(side="left", padx=4)

        # 3. USD Box: [ $  5.00 ]
        usd_frame = tk.Frame(box_wrap, bg="#161926", highlightbackground="#2e3550", highlightthickness=1)
        usd_frame.pack(side="left", padx=(6, 0))

        usd_tag = tk.Label(usd_frame, text="$", bg="#161926", fg="#94a3b8", font=("Segoe UI", 10, "bold"))
        usd_tag.pack(side="left", padx=(8, 2))

        self.usd_entry = tk.Entry(
            usd_frame, textvariable=self.usd_var, width=10,
            font=("Consolas", 10, "bold"), bg="#161926", fg="#f3f4f6",
            bd=0, justify="right", insertbackground="#f3f4f6"
        )
        self.usd_entry.pack(side="left", padx=(2, 8), pady=5)

        # Real-time Bidirectional Key Listeners
        self.sol_entry.bind("<KeyRelease>", self._on_sol_typed)
        self.usd_entry.bind("<KeyRelease>", self._on_usd_typed)

    def _on_sol_typed(self, event=None):
        if self._updating:
            return
        try:
            self._updating = True
            text = self.sol_var.get().strip()
            if not text:
                return
            sol_val = float(text)
            price = self.get_sol_price()
            if price > 0:
                usd_val = sol_val * price
                if usd_val >= 10:
                    self.usd_var.set(f"{usd_val:.1f}")
                else:
                    self.usd_var.set(f"{usd_val:.2f}")
        except ValueError:
            pass
        finally:
            self._updating = False

    def _on_usd_typed(self, event=None):
        if self._updating:
            return
        try:
            self._updating = True
            text = self.usd_var.get().strip()
            if not text:
                return
            usd_val = float(text)
            price = self.get_sol_price()
            if price > 0:
                sol_val = usd_val / price
                self.sol_var.set(f"{sol_val:.4f}")
        except ValueError:
            pass
        finally:
            self._updating = False

    def sync_from_sol(self):
        self._on_sol_typed()


# ==============================================================================
# ENGINE & APP CONTROLLER
# ==============================================================================

class Engine:
    def __init__(self):
        self.acct = bot.PaperAccount(bot.CONFIG)
        self.prices = {}
        self.last_price_time = 0.0
        self.running = False
        self._stop = None

    def start(self):
        if self.running:
            return
        stop = threading.Event()
        self._stop = stop
        self.running = True

        mode = bot.CONFIG.get("execution_mode", "paper").upper()
        if mode == "LIVE":
            bot.BRIDGE.start()
            if not bot.BRIDGE.is_connected():
                bot.BRIDGE.open_browser()
            bot.log("Bot started [LIVE TRADING MODE] — Phantom transactions will prompt in browser.")
        else:
            bot.log("Bot started [PAPER MODE] — Simulated execution.")

        threading.Thread(target=self._scan_loop, args=(stop,), daemon=True).start()
        threading.Thread(target=self._monitor_loop, args=(stop,), daemon=True).start()

    def stop_bot(self):
        if self._stop:
            self._stop.set()
        if self.running:
            bot.log("Bot stopped.")
            self.running = False
            self.acct.save()

    def shutdown(self):
        self.stop_bot()
        bot.BRIDGE.stop()

    def _scan_loop(self, stop):
        while not stop.is_set():
            started = time.time()
            try:
                bot.scan_and_buy(self.acct, bot.CONFIG)
            except Exception as e:
                bot.log(f"scan error: {e}")
            stop.wait(max(0.1, bot.CONFIG["scan_interval_sec"] - (time.time() - started)))

    def _monitor_loop(self, stop):
        last_save = time.time()
        while not stop.is_set():
            started = time.time()
            try:
                prices = bot.monitor(self.acct)
                if prices:
                    self.prices.update(prices)
                    self.last_price_time = time.time()
                if time.time() - last_save >= 10:
                    self.acct.save()
                    last_save = time.time()
            except Exception as e:
                bot.log(f"monitor error: {e}")
            stop.wait(max(0.1, bot.CONFIG["monitor_interval_sec"] - (time.time() - started)))

    def sell_now(self, mint):
        with self.acct.lock:
            if mint not in self.acct.state["positions"]:
                return "That position is already closed."
            price = self.prices.get(mint)
            if not price:
                price = self.acct.state["positions"][mint].get("entry_price", 0.0)

        threading.Thread(target=lambda: self.acct.sell(mint, price, "manual_sell"), daemon=True).start()
        return "Sell initiated. Approve in Phantom browser if in Live mode."

    def write_off_rugged(self, mint):
        with self.acct.lock:
            if mint not in self.acct.state["positions"]:
                return "Position already closed."
            self.acct.write_off_rugged_position(mint, reason="manual_user_writeoff")
        return "Rugged position written off and slot freed."

    def reset_account(self):
        for path in (bot.CONFIG["state_file"], bot.CONFIG["trades_csv"]):
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass
        self.prices.clear()
        self.acct = bot.PaperAccount(bot.CONFIG)


# Theme styling constants
BG, CARD, LINE = "#0f111a", "#161926", "#23283b"
GREEN, RED, GREY, BLUE, ORANGE, PURPLE = "#10b981", "#ef4444", "#8b949e", "#3b82f6", "#f59e0b", "#ab9ff2"
TEXT_MAIN = "#f3f4f6"

class App:
    def __init__(self, root, engine, logq):
        self.root, self.engine, self.logq = root, engine, logq
        self.pos_items = set()
        self.csv_sig = None
        self.msg_job = None
        self.dual_rows = []

        root.title("Solana Launch Sniper & Live Trader (Dual SOL ⇆ $ Sync)")
        root.geometry("1240x840")
        root.minsize(1050, 680)
        root.configure(bg=BG)

        self.build_style()
        self.build_header()
        self.build_cards()
        self.build_tabs()

        self.msg = tk.Label(root, text="", anchor="w", bg=BG, fg=GREY, font=("Segoe UI", 9))
        self.msg.pack(fill="x", padx=14, pady=(0, 6))

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.tick()

    def build_style(self):
        st = ttk.Style()
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass

        st.configure("TFrame", background=BG)
        st.configure("TNotebook", background=BG, borderwidth=0)
        st.configure("TNotebook.Tab", padding=(16, 7), font=("Segoe UI", 10, "bold"), background=CARD, foreground=GREY)
        st.map("TNotebook.Tab", background=[("selected", "#22273d"), ("!selected", CARD)], foreground=[("selected", TEXT_MAIN), ("!selected", GREY)])

        st.configure("Treeview", rowheight=28, font=("Segoe UI", 10), background=CARD, fieldbackground=CARD, foreground=TEXT_MAIN, bordercolor=LINE)
        st.configure("Treeview.Heading", font=("Segoe UI", 9, "bold"), padding=(6, 5), background="#1d2133", foreground="#cbd5e1")

        st.configure("TButton", font=("Segoe UI", 10), padding=(10, 5), background="#24293e", foreground=TEXT_MAIN)
        st.map("TButton", background=[("active", "#313854")])

        st.configure("Start.TButton", background=GREEN, foreground="white", font=("Segoe UI", 10, "bold"), padding=(18, 7))
        st.map("Start.TButton", background=[("active", "#059669")])

        st.configure("Stop.TButton", background=RED, foreground="white", font=("Segoe UI", 10, "bold"), padding=(18, 7))
        st.map("Stop.TButton", background=[("active", "#dc2626")])

        st.configure("Phantom.TButton", background="#512da8", foreground="white", font=("Segoe UI", 10, "bold"), padding=(14, 7))
        st.map("Phantom.TButton", background=[("active", "#5e35b1")])

    def build_header(self):
        bar = tk.Frame(self.root, bg=BG)
        bar.pack(fill="x", padx=14, pady=(12, 6))

        left = tk.Frame(bar, bg=BG)
        left.pack(side="left")

        title_row = tk.Frame(left, bg=BG)
        title_row.pack(anchor="w")

        tk.Label(title_row, text="⚡ Solana Sniper & Spot Trader", bg=BG, fg=TEXT_MAIN, font=("Segoe UI", 17, "bold")).pack(side="left")

        self.mode_badge = tk.Label(title_row, text="[PAPER MODE]", bg="#22273d", fg=PURPLE, font=("Segoe UI", 10, "bold"), padx=8, pady=2)
        self.mode_badge.pack(side="left", padx=12)

        tk.Label(left, text="Jupiter DEX Routing · On-Chain Authority Guard · RugCheck · Phantom Browser Bridge", bg=BG, fg=GREY, font=("Segoe UI", 9)).pack(anchor="w", pady=(2, 0))

        right = tk.Frame(bar, bg=BG)
        right.pack(side="right")

        self.phantom_btn = ttk.Button(right, text="Connect Phantom", style="Phantom.TButton", command=self.open_phantom_bridge)
        self.phantom_btn.pack(side="right", padx=(8, 0))

        self.btn = ttk.Button(right, text="Start bot", style="Start.TButton", command=self.toggle)
        self.btn.pack(side="right", padx=8)

        self.status = tk.Label(right, text="● STOPPED", bg=BG, fg=GREY, font=("Segoe UI", 10, "bold"))
        self.status.pack(side="right", padx=12)

    def build_cards(self):
        wrap = tk.Frame(self.root, bg=BG)
        wrap.pack(fill="x", padx=14, pady=8)
        self.cards = {}
        spec = [
            ("cash", "Wallet / Cash"),
            ("value", "Est. Portfolio Value"),
            ("open_pnl", "Open Position PnL"),
            ("day", "Today's PnL"),
            ("total", "Realized PnL"),
            ("winrate", "Win Rate"),
        ]
        for i, (key, caption) in enumerate(spec):
            wrap.columnconfigure(i, weight=1, uniform="card")
            box = tk.Frame(wrap, bg=CARD, highlightbackground=LINE, highlightthickness=1)
            box.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            tk.Label(box, text=caption, bg=CARD, fg=GREY, font=("Segoe UI", 9)).pack(anchor="w", padx=12, pady=(8, 0))
            val = tk.Label(box, text="-", bg=CARD, fg=TEXT_MAIN, font=("Segoe UI", 13, "bold"))
            val.pack(anchor="w", padx=12, pady=(0, 8))
            self.cards[key] = val

    def tree(self, parent, columns, heads, widths, height=12):
        frame = tk.Frame(parent, bg=BG)
        tv = ttk.Treeview(frame, columns=columns, show="headings", height=height, selectmode="browse")
        for c, h, w in zip(columns, heads, widths):
            tv.heading(c, text=h)
            tv.column(c, width=w, anchor="w", stretch=(c == columns[-1]))
        sb = ttk.Scrollbar(frame, orient="vertical", command=tv.yview)
        tv.configure(yscrollcommand=sb.set)
        tv.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        tv.tag_configure("up", foreground=GREEN)
        tv.tag_configure("down", foreground=RED)
        tv.tag_configure("flat", foreground=TEXT_MAIN)
        tv.tag_configure("buy", foreground=BLUE)
        tv.tag_configure("live", foreground=PURPLE)
        return frame, tv

    def build_tabs(self):
        self.nb = nb = ttk.Notebook(self.root)
        nb.pack(fill="both", expand=True, padx=14, pady=(4, 6))

        # TAB 1: OPEN POSITIONS
        t1 = ttk.Frame(nb)
        nb.add(t1, text="  Open Positions  ")
        cols = ("mode", "coin", "pnl", "pnl_val", "entry", "now", "peak", "low", "held", "key")
        heads = ("Mode", "Coin", "PnL %", "PnL (Est)", "Entry", "Price Now", "Peak %", "Low %", "Held", "Mint / Address")
        widths = (65, 85, 75, 95, 115, 115, 70, 70, 65, 380)
        frame, self.pos_tree = self.tree(t1, cols, heads, widths)
        frame.pack(fill="both", expand=True, pady=(8, 4))
        self.pos_tree.bind("<Double-1>", lambda e: self.open_chart(self.pos_tree, 9))

        row1 = tk.Frame(t1, bg=BG)
        row1.pack(fill="x", pady=(2, 6))
        ttk.Button(row1, text="Copy Mint Address", command=lambda: self.copy_key(self.pos_tree, 9)).pack(side="left")
        ttk.Button(row1, text="DexScreener Chart", command=lambda: self.open_chart(self.pos_tree, 9)).pack(side="left", padx=6)
        ttk.Button(row1, text="Solscan Account", command=lambda: self.open_solscan(self.pos_tree, 9)).pack(side="left", padx=6)
        ttk.Button(row1, text="⚡ Sell Now (Jupiter)", command=self.sell_selected).pack(side="left", padx=6)
        ttk.Button(row1, text="⚠ Write-off Rugged (Free Slot)", command=self.writeoff_selected).pack(side="left", padx=6)

        self.pos_hint = tk.Label(row1, text="", bg=BG, fg=GREY, font=("Segoe UI", 9))
        self.pos_hint.pack(side="right")

        # TAB 2: TRADE HISTORY
        t2 = ttk.Frame(nb)
        nb.add(t2, text="  Trade History  ")
        h_cols = ("time", "mode", "action", "coin", "price", "amount", "pnl", "pnl_pct", "reason", "explorer", "mint")
        h_heads = ("Time", "Mode", "Action", "Coin", "Price", "Amount", "PnL", "PnL %", "Exit Reason", "Explorer / Tx", "Mint Address")
        h_widths = (120, 60, 65, 85, 110, 95, 85, 75, 130, 260, 200)
        h_frame, self.hist_tree = self.tree(t2, h_cols, h_heads, h_widths)
        h_frame.pack(fill="both", expand=True, pady=(8, 4))
        self.hist_tree.bind("<Double-1>", lambda e: self.open_explorer_or_chart(self.hist_tree))

        row2 = tk.Frame(t2, bg=BG)
        row2.pack(fill="x", pady=(2, 6))
        ttk.Button(row2, text="Open Explorer / Solscan Tx", command=lambda: self.open_explorer_or_chart(self.hist_tree)).pack(side="left")
        ttk.Button(row2, text="Copy Address", command=lambda: self.copy_key(self.hist_tree, 10)).pack(side="left", padx=6)

        # TAB 3: SCAN LOG
        t3 = ttk.Frame(nb)
        nb.add(t3, text="  Live Log & Bridge  ")
        box = tk.Frame(t3, bg=BG)
        box.pack(fill="both", expand=True, pady=8)
        self.log = tk.Text(box, wrap="none", font=("Consolas", 9), bg="#0d0e15", fg=TEXT_MAIN, relief="flat", state="disabled", highlightbackground=LINE, highlightthickness=1)
        sb = ttk.Scrollbar(box, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        self.log.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        for tag, color in (("buy", GREEN), ("sell", BLUE), ("reject", GREY), ("warn", ORANGE), ("live", PURPLE)):
            self.log.tag_configure(tag, foreground=color)

        # TAB 4: SETTINGS (With Side-by-Side Dual SOL ⇆ $)
        t4 = ttk.Frame(nb)
        nb.add(t4, text="  Settings  ")
        self.build_settings(t4)

    def build_settings(self, parent):
        scroll_canvas = tk.Canvas(parent, bg=BG, highlightthickness=0)
        vbar = ttk.Scrollbar(parent, orient="vertical", command=scroll_canvas.yview)
        content = tk.Frame(scroll_canvas, bg=BG)

        content.bind("<Configure>", lambda e: scroll_canvas.configure(scrollregion=scroll_canvas.bbox("all")))
        scroll_canvas.create_window((0, 0), window=content, anchor="nw")
        scroll_canvas.configure(yscrollcommand=vbar.set)

        scroll_canvas.pack(side="left", fill="both", expand=True, padx=12, pady=10)
        vbar.pack(side="right", fill="y")

        self.vars = {}

        # -------------------------------------------------------------
        # Live SOL Price Ticker Banner
        # -------------------------------------------------------------
        ticker_bar = tk.Frame(content, bg=CARD, highlightbackground=LINE, highlightthickness=1)
        ticker_bar.pack(fill="x", padx=4, pady=(0, 10))

        self.rate_lbl = tk.Label(ticker_bar, text="● Live Solana Rate: 1 SOL ≈ $145.00 USD", bg=CARD, fg=GREEN, font=("Segoe UI", 10, "bold"))
        self.rate_lbl.pack(side="left", padx=12, pady=8)

        ttk.Button(ticker_bar, text="Refresh SOL Price", command=self.refresh_sol_price).pack(side="right", padx=10, pady=6)

        # -------------------------------------------------------------
        # SECTION 1: Dual Capital & Sizing (Side-by-Side SOL ⇆ $)
        # -------------------------------------------------------------
        sec1 = tk.LabelFrame(content, text="  Capital & Position Sizing (Dual SOL ⇆ $)  ", bg=BG, fg="#93c5fd", font=("Segoe UI", 10, "bold"), padx=12, pady=8)
        sec1.pack(fill="x", padx=4, pady=6)

        for _, sol_k, usd_k, label, def_sol, def_usd in DUAL_SETTINGS:
            sol_v = tk.StringVar(value=str(bot.CONFIG.get(sol_k, def_sol)))
            usd_v = tk.StringVar(value=str(bot.CONFIG.get(usd_k, def_usd)))
            self.vars[sol_k] = sol_v
            self.vars[usd_k] = usd_v

            row = DualSolUsdRow(sec1, label, sol_v, usd_v, lambda: bot.get_sol_price(bot.CONFIG), bg=BG)
            row.pack(fill="x", pady=4)
            self.dual_rows.append(row)

        # -------------------------------------------------------------
        # SECTION 2: General & Risk Settings
        # -------------------------------------------------------------
        sec2 = tk.LabelFrame(content, text="  Trading & Risk Controls  ", bg=BG, fg="#93c5fd", font=("Segoe UI", 10, "bold"), padx=12, pady=8)
        sec2.pack(fill="x", padx=4, pady=6)

        grid2 = tk.Frame(sec2, bg=BG)
        grid2.pack(fill="x")

        half = (len(STANDARD_SETTINGS) + 1) // 2
        for i, (key, label, kind) in enumerate(STANDARD_SETTINGS):
            r, c = i % half, (i // half) * 3
            tk.Label(grid2, text=label, bg=BG, fg="#cbd5e1", anchor="w", font=("Segoe UI", 9)).grid(row=r, column=c, sticky="w", padx=(0, 8), pady=3)
            val = bot.CONFIG.get(key, "")
            if kind == "bool":
                var = tk.BooleanVar(value=bool(val))
                ttk.Checkbutton(grid2, variable=var).grid(row=r, column=c + 1, sticky="w", pady=3)
            else:
                var = tk.StringVar(value=str(val))
                ttk.Entry(grid2, textvariable=var, width=13).grid(row=r, column=c + 1, sticky="w", pady=3)
            self.vars[key] = var

        # Action Buttons
        btn_row = tk.Frame(content, bg=BG)
        btn_row.pack(fill="x", padx=4, pady=(12, 16))

        ttk.Button(btn_row, text="Save & Apply Settings", command=self.apply_settings).pack(side="left")
        ttk.Button(btn_row, text="Launch Phantom Bridge Browser", command=self.open_phantom_bridge).pack(side="left", padx=10)
        ttk.Button(btn_row, text="Reset Paper Account...", command=self.reset_account).pack(side="left", padx=10)

        # Background fetch of live price
        threading.Thread(target=self.refresh_sol_price, daemon=True).start()

    def refresh_sol_price(self):
        try:
            price = bot.get_sol_price(bot.CONFIG)
            if price and price > 0:
                self.rate_lbl.config(text=f"● Live Solana Rate: 1 SOL ≈ ${price:.2f} USD")
        except Exception:
            pass

    def say(self, text, ms=4500):
        self.msg.config(text=text)
        if self.msg_job:
            self.root.after_cancel(self.msg_job)
        self.msg_job = self.root.after(ms, lambda: self.msg.config(text=""))

    def toggle(self):
        if self.engine.running:
            self.engine.stop_bot()
        else:
            mode = bot.CONFIG.get("execution_mode", "paper")
            if mode == "live" and not bot.BRIDGE.is_connected():
                if messagebox.askyesno("Connect Phantom Wallet", "Live Trading mode is active, but Phantom is not connected yet.\n\nOpen the Phantom Browser Bridge now to pair your wallet?"):
                    self.open_phantom_bridge()
            self.engine.start()

    def open_phantom_bridge(self):
        bot.BRIDGE.open_browser()
        self.say("Opened Phantom Bridge in your browser (http://127.0.0.1:8765)")

    def chosen_key(self, tv, col):
        sel = tv.selection()
        if not sel:
            self.say("Please select a row first.")
            return None
        return tv.item(sel[0], "values")[col]

    def copy_key(self, tv, col):
        key = self.chosen_key(tv, col)
        if key:
            self.root.clipboard_clear()
            self.root.clipboard_append(key)
            self.say("Copied address to clipboard.")

    def open_chart(self, tv, col):
        key = self.chosen_key(tv, col)
        if key:
            webbrowser.open(f"https://dexscreener.com/solana/{key}")

    def open_solscan(self, tv, col):
        key = self.chosen_key(tv, col)
        if key:
            webbrowser.open(f"https://solscan.io/account/{key}")

    def open_explorer_or_chart(self, tv):
        sel = tv.selection()
        if not sel:
            return
        vals = tv.item(sel[0], "values")
        explorer = vals[9]
        mint = vals[10]
        if explorer and explorer.startswith("http"):
            webbrowser.open(explorer)
        elif mint:
            webbrowser.open(f"https://dexscreener.com/solana/{mint}")

    def sell_selected(self):
        sel = self.pos_tree.selection()
        if not sel:
            self.say("Select an open position first.")
            return
        mint = sel[0]
        vals = self.pos_tree.item(mint, "values")
        mode = vals[0]
        name = vals[1]

        prompt = f"Sell position in {name} immediately via {mode} execution?"
        if messagebox.askyesno("Confirm Sell", prompt):
            self.say(self.engine.sell_now(mint))

    def writeoff_selected(self):
        sel = self.pos_tree.selection()
        if not sel:
            self.say("Select an open position first.")
            return
        mint = sel[0]
        vals = self.pos_tree.item(mint, "values")
        name = vals[1]

        prompt = (f"Clear rugged/dead position {name}?\n\n"
                  f"Use this if liquidity was pulled or Jupiter returned 'NO_ROUTES_FOUND'.\n"
                  f"This frees up the trading slot immediately.")
        if messagebox.askyesno("Write-off Rugged Token", prompt):
            self.say(self.engine.write_off_rugged(mint))

    def apply_settings(self):
        raw = {k: v.get() for k, v in self.vars.items()}
        parsed, errors = parse_settings(raw)
        if errors:
            messagebox.showerror("Check Settings", "\n".join(errors))
            return
        bot.CONFIG.update(parsed)
        save_settings()
        self.say("Settings applied and saved to sniper_settings.json.")

    def reset_account(self):
        if self.engine.running:
            messagebox.showinfo("Stop Bot First", "Please stop the bot before resetting the paper account.")
            return
        if messagebox.askyesno("Reset Account", "This resets simulated balances and wipes open positions. Continue?"):
            self.engine.reset_account()
            self.csv_sig = None
            self.say("Account reset.")

    def on_close(self):
        self.engine.shutdown()
        self.root.destroy()

    def tick(self):
        try:
            self.drain_log()
            rows = position_rows(self.engine.acct, self.engine.prices)
            self.update_positions(rows)
            self.update_cards(rows)
            self.update_status(rows)
            self.update_history()
            self.update_wallet_badge()
        except Exception as e:
            self.append_log(f"[window] refresh error: {e}")
        self.root.after(500, self.tick)

    def update_wallet_badge(self):
        mode = bot.CONFIG.get("execution_mode", "paper").upper()
        self.mode_badge.config(text=f"[{mode} MODE]", fg=GREEN if mode == "LIVE" else PURPLE)

        if bot.BRIDGE.is_connected():
            pk = bot.BRIDGE.wallet_address
            short_pk = f"{pk[:4]}...{pk[-4:]}"
            bal = bot.BRIDGE.sol_balance
            self.phantom_btn.config(text=f"Phantom: {short_pk} ({bal:.4f} SOL)")
        else:
            self.phantom_btn.config(text="Connect Phantom")

    def update_positions(self, rows):
        seen = set()
        for r in rows:
            mint = r["mint"]
            seen.add(mint)
            tag = "flat" if r["chg"] is None else ("up" if r["chg"] > 0 else "down" if r["chg"] < 0 else "flat")
            mode_tag = "LIVE" if r["is_live"] else "PAPER"

            pnl_str = money(r["pnl"], True, r["cost_unit"])
            vals = (
                mode_tag,
                r["symbol"],
                pct(r["chg"]),
                pnl_str,
                bot.fmt_price(r["entry"]),
                bot.fmt_price(r["now"]) if r["now"] else "...",
                pct(r["peak"]),
                pct(r["low"]),
                fmt_held(r["held"]),
                mint,
            )
            if mint in self.pos_items:
                self.pos_tree.item(mint, values=vals, tags=(tag,))
            else:
                self.pos_tree.insert("", "end", iid=mint, values=vals, tags=(tag,))
                self.pos_items.add(mint)

        for mint in list(self.pos_items - seen):
            self.pos_tree.delete(mint)
            self.pos_items.discard(mint)

        cfg = bot.CONFIG
        self.pos_hint.config(text=f"{len(rows)} of {cfg['max_open_positions']} slots in use" if rows else "No open positions")

    def update_cards(self, rows):
        s = account_stats(self.engine.acct, rows)
        def paint(key, text, num_val=None):
            color = TEXT_MAIN if num_val is None else (GREEN if num_val > 0 else RED if num_val < 0 else TEXT_MAIN)
            self.cards[key].config(text=text, fg=color)

        paint("cash", s["cash"])
        paint("value", s["value"])
        paint("open_pnl", s["open_pnl"], s.get("open_pnl_num"))
        paint("day", s["day"], s.get("day_num"))
        paint("total", s["total"], s.get("total_num"))
        paint("winrate", s["winrate"])

    def update_status(self, rows):
        eng = self.engine
        if not eng.running:
            self.status.config(text="● STOPPED", fg=GREY)
            self.btn.config(text="Start bot", style="Start.TButton")
            return

        self.btn.config(text="Stop bot", style="Stop.TButton")
        age = time.time() - eng.last_price_time if eng.last_price_time else None
        mode = bot.CONFIG.get("execution_mode", "paper").upper()

        if rows and (age is None or age > 15):
            self.status.config(text=f"● RUNNING [{mode}] - waiting prices", fg=ORANGE)
        elif rows:
            self.status.config(text=f"● RUNNING [{mode}] - prices fresh", fg=GREEN)
        else:
            self.status.config(text=f"● RUNNING [{mode}] - scanning {bot.CONFIG['scan_interval_sec']}s", fg=GREEN)

    def update_history(self):
        path = bot.CONFIG["trades_csv"]
        try:
            st = os.stat(path)
            sig = (st.st_mtime, st.st_size)
        except OSError:
            sig = None
        if sig == self.csv_sig:
            return
        self.csv_sig = sig
        self.hist_tree.delete(*self.hist_tree.get_children())
        for vals in read_trades(path):
            action = vals[2]
            tag = "buy" if action == "BUY" else ("up" if "+" in vals[6] else "down")
            self.hist_tree.insert("", "end", values=vals, tags=(tag,))

    def drain_log(self):
        for _ in range(250):
            try:
                self.append_log(self.logq.get_nowait())
            except queue.Empty:
                break

    def append_log(self, line):
        low = line.lower()
        tag = (
            "reject" if ("reject" in low or "rug" in low or "filtered" in low) else
            "buy" if ("buy" in low or "sniper buy" in low) else
            "sell" if "sell" in low else
            "live" if ("phantom" in low or "bridge" in low or "tx:" in low) else
            "warn" if any(w in low for w in ("error", "failed", "warning")) else None
        )
        at_bottom = self.log.yview()[1] > 0.97
        self.log.config(state="normal")
        self.log.insert("end", line + "\n", tag or ())
        lines = int(self.log.index("end-1c").split(".")[0])
        if lines > 3000:
            self.log.delete("1.0", f"{lines - 2500}.0")
        self.log.config(state="disabled")
        if at_bottom:
            self.log.see("end")

def main():
    if tk is None:
        print("Tkinter is not available in this environment.")
        print("To run the bot in CLI/headless mode, use: python bot.py")
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    load_settings()
    logq = queue.Queue()
    bot.CONSOLE_OUTPUT = False
    bot.LOG_HOOK = logq.put

    engine = Engine()
    root = tk.Tk()
    App(root, engine, logq)
    bot.log("GUI Initialized. Select 'Start bot' to begin.")
    if "--start" in sys.argv:
        engine.start()
    root.mainloop()

if __name__ == "__main__":
    main()
