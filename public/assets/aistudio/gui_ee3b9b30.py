#!/usr/bin/env python3
"""
Solana paper-trading bot with a desktop window.
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

SETTINGS_FILE = "settings.json"
SETTINGS = [
    ("start_balance_usd", "Start balance $ (used on reset)", "float"),
    ("trade_size_usd", "Trade size $", "float"),
    ("max_open_positions", "Max open positions", "int"),
    ("daily_loss_limit_usd", "Daily loss limit $", "float"),
    ("take_profit_pct", "Take profit % (0 = off)", "float"),
    ("trailing_stop_pct", "Trailing stop % from peak (0 = off)", "float"),
    ("max_hold_minutes", "Max hold (minutes)", "int"),
    ("max_age_minutes", "Sniper window: max coin age (minutes)", "float"),
    ("scan_interval_sec", "Scan for new coins every (sec)", "int"),
    ("monitor_interval_sec", "Price check every (sec)", "float"),
    ("min_liquidity_usd", "Min liquidity $", "float"),
    ("min_buys_m5", "Min buys last 5 min", "int"),
    ("min_buy_sell_ratio_m5", "Min buy/sell ratio (5 min)", "float"),
    ("max_price_change_m5_pct", "Skip if pumped +X% in 5 min", "float"),
    ("min_volume_m5_usd", "Min 5-min volume $ (0 = off)", "float"),
    ("min_holders", "Min buys in last 1h (0 = off)", "int"),
    ("use_rugcheck", "Hard RugCheck (score + risks)", "bool"),
    ("strict_rugcheck", "Strict: reject ANY danger risk", "bool"),
    ("rugcheck_max_score", "Max RugCheck risk score (0-100)", "float"),
    ("max_top10_holder_pct", "Max top-10 holders %", "float"),
    ("rug_recheck_minutes", "Recheck rug score every (min)", "int"),
    ("use_gecko", "Source: GeckoTerminal new pools (all DEXes)", "bool"),
    ("use_jupiter_recent", "Source: Jupiter recent tokens", "bool"),
    ("use_jupiter_price", "Use Jupiter live prices", "bool"),
    ("use_dex_profiles", "Source: DexScreener token profiles", "bool"),
    ("use_pumpportal", "Source: PumpPortal new launches", "bool"),
    ("use_promoted_feeds", "Source: DexScreener boosted (promoted)", "bool"),
    ("slippage_pct", "Simulated slippage %", "float"),
    ("fee_pct", "Simulated fee %", "float"),
    ("log_rejects", "Log filtered-out coins (debug)", "bool"),
]
LIMITS = {
    "start_balance_usd": (1, 1e7), "trade_size_usd": (0.5, 1e6), "max_open_positions": (1, 50),
    "daily_loss_limit_usd": (0, 1e7), "take_profit_pct": (0, 1e5), "trailing_stop_pct": (0, 1000),
    "max_hold_minutes": (1, 1e5), "max_age_minutes": (0.05, 60),
    "scan_interval_sec": (1, 3600), "monitor_interval_sec": (0.2, 60),
    "min_liquidity_usd": (0, 1e9), "min_buys_m5": (0, 1e6), "min_buy_sell_ratio_m5": (0, 100),
    "max_price_change_m5_pct": (0, 1e6), "min_volume_m5_usd": (0, 1e9), "min_holders": (0, 1e6),
    "rugcheck_max_score": (0, 100), "max_top10_holder_pct": (0, 100), "rug_recheck_minutes": (1, 1440),
    "slippage_pct": (0, 50), "fee_pct": (0, 50),
}

def convert(value, kind):
    if kind == "bool":
        if isinstance(value, str): return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if kind == "int": return int(float(value))
    return float(value)

def parse_settings(raw):
    parsed, errors = {}, []
    for key, label, kind in SETTINGS:
        try: val = convert(raw[key], kind)
        except (KeyError, ValueError, TypeError):
            errors.append(f"{label}: not a valid number"); continue
        if kind != "bool":
            lo, hi = LIMITS[key]
            if not (lo <= val <= hi):
                errors.append(f"{label}: must be between {lo:g} and {hi:g}"); continue
        parsed[key] = val
    return parsed, errors

def load_settings():
    if not os.path.exists(SETTINGS_FILE): return
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f: data = json.load(f)
        raw = {k: data.get(k, bot.CONFIG[k]) for k, _, _ in SETTINGS}
        parsed, errors = parse_settings(raw)
        if not errors: bot.CONFIG.update(parsed)
    except Exception: pass

def save_settings():
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump({k: bot.CONFIG[k] for k, _, _ in SETTINGS}, f, indent=2)

def money(x, sign=False):
    if x is None: return "..."
    s = f"${abs(x):,.2f}"
    if sign: return ("+" if x >= 0 else "-") + s
    return ("-" if x < 0 else "") + s

def pct(x): return "..." if x is None else f"{x:+.2f}%"
def fmt_held(minutes):
    if minutes < 60: return f"{minutes:.0f}m"
    return f"{int(minutes // 60)}h {int(minutes % 60):02d}m"

def position_rows(acct, prices):
    cfg = acct.cfg
    with acct.lock: items = [(m, dict(p)) for m, p in acct.state["positions"].items()]
    rows = []
    for mint, p in items:
        entry = p["entry_price"]; price = prices.get(mint)
        chg = pnl_usd = value = None
        if price:
            chg = (price / entry - 1) * 100
            value = (p["qty"] * price * (1 - cfg["slippage_pct"] / 100) * (1 - cfg["fee_pct"] / 100))
            pnl_usd = value - p["cost"]
        rows.append({"mint": mint, "symbol": p["symbol"], "entry": entry, "now": price, "chg": chg, "pnl_usd": pnl_usd, "value": value, "cost": p["cost"], "peak": (p.get("peak_price", entry) / entry - 1) * 100, "low": (p.get("low_price", entry) / entry - 1) * 100, "held": (time.time() - p["opened"]) / 60})
    return rows

def account_stats(acct, rows):
    s = acct.state
    open_pnl = sum(r["pnl_usd"] for r in rows if r["pnl_usd"] is not None)
    open_value = sum(r["value"] if r["value"] is not None else r["cost"] for r in rows)
    wins, closed = s["wins"], s["closed"]
    return {"cash": s["cash"], "value": s["cash"] + open_value, "open_pnl": open_pnl, "day": s["day_pnl"], "total": s["total_pnl"], "winrate": f"{wins / closed * 100:.0f}%  ({wins}/{closed})" if closed else "no closed trades"}

def read_trades(path, limit=500):
    if not os.path.exists(path): return []
    out = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) < 9 or row[0] == "time": continue
            try: when = datetime.fromisoformat(row[0]).astimezone().strftime("%Y-%m-%d %H:%M:%S")
            except ValueError: when = row[0]
            usd = row[5]
            try: usd = f"${float(usd):,.2f}"
            except ValueError: pass
            pnl_usd = row[6]
            try: pnl_usd = money(float(pnl_usd), True)
            except ValueError: pass
            pnl_pct = f"{row[7]}%" if row[7] else ""
            out.append((when, row[1], row[2], "$" + row[4], usd, pnl_usd, pnl_pct, row[8], row[3]))
    return out[-limit:][::-1]

class Engine:
    def __init__(self):
        self.acct = bot.PaperAccount(bot.CONFIG); self.prices = {}; self.last_price_time = 0.0; self.running = False; self._stop = None
    def start(self):
        if self.running: return
        stop = threading.Event(); self._stop = stop; self.running = True
        bot.log("Bot started (PAPER MODE - no real money)")
        threading.Thread(target=self._scan_loop, args=(stop,), daemon=True).start()
        threading.Thread(target=self._monitor_loop, args=(stop,), daemon=True).start()
    def stop_bot(self):
        if self._stop: self._stop.set()
        if self.running: bot.log("Bot stopped."); self.running = False; self.acct.save()
    def shutdown(self): self.stop_bot()
    def _scan_loop(self, stop):
        while not stop.is_set():
            started = time.time()
            try: bot.scan_and_buy(self.acct, bot.CONFIG)
            except Exception as e: bot.log(f"scan error: {e}")
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
            if mint not in self.acct.state["positions"]: return "That position is already closed."
            price = self.prices.get(mint)
            if not price: return "No live price for this coin yet."
            self.acct.sell(mint, price, "manual"); return "Sold (paper trade)."
    def reset_account(self):
        for path in (bot.CONFIG["state_file"], bot.CONFIG["trades_csv"]):
            if os.path.exists(path): os.remove(path)
        self.prices.clear(); self.acct = bot.PaperAccount(bot.CONFIG)

BG, CARD, LINE = "#f4f5f7", "#ffffff", "#dde1e6"
GREEN, RED, GREY, BLUE, ORANGE = "#0b7a3b", "#c62828", "#667085", "#1d4ed8", "#b45309"

class App:
    def __init__(self, root, engine, logq):
        self.root, self.engine, self.logq = root, engine, logq; self.pos_items = set(); self.csv_sig = None; self.msg_job = None
        root.title("Solana Paper Trader -V1 almost perfect - PAPER MODE (no real money)"); root.geometry("1200x780"); root.minsize(1000, 640); root.configure(bg=BG)
        self.build_style(); self.build_header(); self.build_cards(); self.build_tabs()
        self.msg = tk.Label(root, text="", anchor="w", bg=BG, fg=GREY, font=("Segoe UI", 9)); self.msg.pack(fill="x", padx=14, pady=(0, 6))
        root.protocol("WM_DELETE_WINDOW", self.on_close); self.tick()

    def build_style(self):
        st = ttk.Style()
        try: st.theme_use("clam")
        except tk.TclError: pass
        st.configure("TFrame", background=BG); st.configure("TNotebook", background=BG, borderwidth=0); st.configure("TNotebook.Tab", padding=(16, 7), font=("Segoe UI", 10))
        st.configure("Treeview", rowheight=26, font=("Segoe UI", 10), background=CARD, fieldbackground=CARD, bordercolor=LINE)
        st.configure("Treeview.Heading", font=("Segoe UI", 9, "bold"), padding=(6, 5))
        st.map("TNotebook.Tab", background=[("selected", CARD), ("!selected", "#e4e7ec")])
        st.configure("TButton", font=("Segoe UI", 10), padding=(12, 6), background="#e9ecf0"); st.map("TButton", background=[("active", "#dde1e6")])
        st.configure("Start.TButton", background=GREEN, foreground="white", font=("Segoe UI", 11, "bold"), padding=(22, 9)); st.map("Start.TButton", background=[("active", "#096532")])
        st.configure("Stop.TButton", background=RED, foreground="white", font=("Segoe UI", 11, "bold"), padding=(22, 9)); st.map("Stop.TButton", background=[("active", "#a01f1f")])

    def build_header(self):
        bar = tk.Frame(self.root, bg=BG); bar.pack(fill="x", padx=14, pady=(12, 4))
        left = tk.Frame(bar, bg=BG); left.pack(side="left")
        tk.Label(left, text="Solana Paper Trader - New Launch Sniper", bg=BG, fg="#101828", font=("Segoe UI", 17, "bold")).pack(anchor="w")
        tk.Label(left, text="All DEXes | brand-new coins only | hard rug screen | PAPER MODE: no wallet, no real money", bg=BG, fg=GREY, font=("Segoe UI", 9)).pack(anchor="w")
        self.btn = ttk.Button(bar, text="Start bot", style="Start.TButton", command=self.toggle); self.btn.pack(side="right")
        self.status = tk.Label(bar, text="", bg=BG, font=("Segoe UI", 10, "bold")); self.status.pack(side="right", padx=18)

    def build_cards(self):
        wrap = tk.Frame(self.root, bg=BG); wrap.pack(fill="x", padx=14, pady=8); self.cards = {}
        spec = [("cash", "Cash"), ("value", "Est. total value"), ("open_pnl", "Open PnL (est.)"), ("day", "Today's PnL"), ("total", "Realized PnL"), ("winrate", "Win rate")]
        for i, (key, caption) in enumerate(spec):
            wrap.columnconfigure(i, weight=1, uniform="card")
            box = tk.Frame(wrap, bg=CARD, highlightbackground=LINE, highlightthickness=1); box.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            tk.Label(box, text=caption, bg=CARD, fg=GREY, font=("Segoe UI", 9)).pack(anchor="w", padx=12, pady=(9, 0))
            val = tk.Label(box, text="-", bg=CARD, fg="#101828", font=("Segoe UI", 15, "bold")); val.pack(anchor="w", padx=12, pady=(0, 9)); self.cards[key] = val

    def tree(self, parent, columns, heads, widths, height=12):
        frame = tk.Frame(parent, bg=BG); tv = ttk.Treeview(frame, columns=columns, show="headings", height=height, selectmode="browse")
        for c, h, w in zip(columns, heads, widths): tv.heading(c, text=h); tv.column(c, width=w, anchor="w", stretch=(c == columns[-1]))
        sb = ttk.Scrollbar(frame, orient="vertical", command=tv.yview); tv.configure(yscrollcommand=sb.set); tv.pack(side="left", fill="both", expand=True); sb.pack(side="right", fill="y")
        tv.tag_configure("up", foreground=GREEN); tv.tag_configure("down", foreground=RED); tv.tag_configure("flat", foreground="#101828"); tv.tag_configure("buy", foreground=BLUE)
        return frame, tv

    def build_tabs(self):
        self.nb = nb = ttk.Notebook(self.root); nb.pack(fill="both", expand=True, padx=14, pady=(4, 6))
        t1 = ttk.Frame(nb); nb.add(t1, text="  Open positions  ")
        frame, self.pos_tree = self.tree(t1, ("coin", "pnl", "pnl_usd", "entry", "now", "peak", "low", "held", "key"), ("Coin", "PnL %", "PnL $ (est.)", "Entry price", "Price now", "Peak %", "Low %", "Held", "Coin key (token address)"), (95, 72, 90, 120, 120, 70, 70, 65, 400))
        frame.pack(fill="both", expand=True, pady=(8, 4)); self.pos_tree.bind("<Double-1>", lambda e: self.open_chart(self.pos_tree, 8))
        row = tk.Frame(t1, bg=BG); row.pack(fill="x", pady=(2, 6))
        ttk.Button(row, text="Copy coin key", command=lambda: self.copy_key(self.pos_tree, 8)).pack(side="left")
        ttk.Button(row, text="Open chart on DexScreener", command=lambda: self.open_chart(self.pos_tree, 8)).pack(side="left", padx=8)
        ttk.Button(row, text="Sell now (paper)", command=self.sell_selected).pack(side="left")
        self.pos_hint = tk.Label(row, text="", bg=BG, fg=GREY, font=("Segoe UI", 9)); self.pos_hint.pack(side="right")
        t2 = ttk.Frame(nb); nb.add(t2, text="  Trade history  ")
        frame, self.hist_tree = self.tree(t2, ("time", "action", "coin", "price", "usd", "pnl_usd", "pnl_pct", "reason", "key"), ("Time", "Action", "Coin", "Price", "Amount", "PnL $", "PnL %", "Exit reason", "Coin key"), (160, 60, 95, 120, 75, 80, 70, 90, 380))
        frame.pack(fill="both", expand=True, pady=(8, 4)); self.hist_tree.bind("<Double-1>", lambda e: self.open_chart(self.hist_tree, 8))
        row = tk.Frame(t2, bg=BG); row.pack(fill="x", pady=(2, 6))
        ttk.Button(row, text="Copy coin key", command=lambda: self.copy_key(self.hist_tree, 8)).pack(side="left")
        ttk.Button(row, text="Open chart on DexScreener", command=lambda: self.open_chart(self.hist_tree, 8)).pack(side="left", padx=8)
        t3 = ttk.Frame(nb); nb.add(t3, text="  Scan log  ")
        box = tk.Frame(t3, bg=BG); box.pack(fill="both", expand=True, pady=8)
        self.log = tk.Text(box, wrap="none", font=("Consolas", 9), bg=CARD, relief="flat", state="disabled", highlightbackground=LINE, highlightthickness=1)
        sb = ttk.Scrollbar(box, orient="vertical", command=self.log.yview); self.log.configure(yscrollcommand=sb.set); self.log.pack(side="left", fill="both", expand=True); sb.pack(side="right", fill="y")
        for tag, color in (("buy", GREEN), ("sell", BLUE), ("reject", GREY), ("warn", ORANGE)): self.log.tag_configure(tag, foreground=color)
        t4 = ttk.Frame(nb); nb.add(t4, text="  Settings  "); self.build_settings(t4)

    def build_settings(self, parent):
        form = tk.Frame(parent, bg=BG); form.pack(fill="x", padx=10, pady=12); self.vars = {}
        half = (len(SETTINGS) + 1) // 2
        for i, (key, label, kind) in enumerate(SETTINGS):
            r, c = i % half, (i // half) * 3
            tk.Label(form, text=label, bg=BG, anchor="w", font=("Segoe UI", 10)).grid(row=r, column=c, sticky="w", padx=(0, 10), pady=4)
            if kind == "bool":
                var = tk.BooleanVar(); ttk.Checkbutton(form, variable=var).grid(row=r, column=c + 1, sticky="w", pady=4)
            else:
                var = tk.StringVar(); ttk.Entry(form, textvariable=var, width=14).grid(row=r, column=c + 1, sticky="w", pady=4)
            self.vars[key] = var
        form.columnconfigure(c + 2, minsize=50)
        self.fill_settings()
        row = tk.Frame(parent, bg=BG); row.pack(fill="x", padx=10, pady=(4, 4))
        ttk.Button(row, text="Apply and save", command=self.apply_settings).pack(side="left")
        ttk.Button(row, text="Reset paper account...", command=self.reset_account).pack(side="left", padx=10)

    def fill_settings(self):
        for key, _, kind in SETTINGS:
            v = bot.CONFIG[key]; self.vars[key].set(bool(v) if kind == "bool" else f"{v:g}")

    def say(self, text, ms=4000):
        self.msg.config(text=text)
        if self.msg_job: self.root.after_cancel(self.msg_job)
        self.msg_job = self.root.after(ms, lambda: self.msg.config(text=""))

    def toggle(self):
        if self.engine.running: self.engine.stop_bot()
        else: self.engine.start()

    def chosen_key(self, tv, col):
        sel = tv.selection()
        if not sel: self.say("Select a coin in the table first."); return None
        return tv.item(sel[0], "values")[col]

    def copy_key(self, tv, col):
        key = self.chosen_key(tv, col)
        if key: self.root.clipboard_clear(); self.root.clipboard_append(key); self.say("Coin key copied.")

    def open_chart(self, tv, col):
        key = self.chosen_key(tv, col)
        if key: webbrowser.open(f"https://dexscreener.com/solana/{key}")

    def sell_selected(self):
        sel = self.pos_tree.selection()
        if not sel: self.say("Select an open position first."); return
        mint = sel[0]; name = self.pos_tree.item(mint, "values")[0]
        if messagebox.askyesno("Sell now", f"Close the paper position in {name} at the current price?"): self.say(self.engine.sell_now(mint))

    def apply_settings(self):
        raw = {k: v.get() for k, v in self.vars.items()}
        parsed, errors = parse_settings(raw)
        if errors: messagebox.showerror("Check your settings", "\n".join(errors)); return
        bot.CONFIG.update(parsed); save_settings(); self.fill_settings(); self.say("Settings applied and saved.")

    def reset_account(self):
        if self.engine.running: messagebox.showinfo("Stop the bot first", "Press 'Stop bot', then reset the paper account."); return
        if messagebox.askyesno("Reset paper account", "This deletes all open positions and the trade history. Continue?"):
            self.engine.reset_account(); self.csv_sig = None; self.say("Paper account reset.")

    def on_close(self): self.engine.shutdown(); self.root.destroy()

    def tick(self):
        try:
            self.drain_log(); rows = position_rows(self.engine.acct, self.engine.prices)
            self.update_positions(rows); self.update_cards(rows); self.update_status(rows); self.update_history()
        except Exception as e: self.append_log(f"[window] refresh error: {e}")
        self.root.after(500, self.tick)

    def update_positions(self, rows):
        seen = set()
        for r in rows:
            mint = r["mint"]; seen.add(mint)
            tag = "flat" if r["chg"] is None else ("up" if r["chg"] > 0 else "down" if r["chg"] < 0 else "flat")
            vals = (r["symbol"], pct(r["chg"]), money(r["pnl_usd"], True), bot.fmt_price(r["entry"]), bot.fmt_price(r["now"]) if r["now"] else "...", pct(r["peak"]), pct(r["low"]), fmt_held(r["held"]), mint)
            if mint in self.pos_items: self.pos_tree.item(mint, values=vals, tags=(tag,))
            else: self.pos_tree.insert("", "end", iid=mint, values=vals, tags=(tag,)); self.pos_items.add(mint)
        for mint in list(self.pos_items - seen): self.pos_tree.delete(mint); self.pos_items.discard(mint)
        cfg = bot.CONFIG
        self.pos_hint.config(text=f"{len(rows)} of {cfg['max_open_positions']} slots in use" if rows else "No open positions")

    def update_cards(self, rows):
        s = account_stats(self.engine.acct, rows)
        def paint(key, text, number=None):
            color = "#101828" if number is None else (GREEN if number > 0 else RED if number < 0 else "#101828")
            self.cards[key].config(text=text, fg=color)
        paint("cash", money(s["cash"])); paint("value", money(s["value"])); paint("open_pnl", money(s["open_pnl"], True), s["open_pnl"])
        paint("day", money(s["day"], True), s["day"]); paint("total", money(s["total"], True), s["total"]); paint("winrate", s["winrate"])

    def update_status(self, rows):
        eng = self.engine
        if not eng.running: self.status.config(text="●  STOPPED", fg=GREY); self.btn.config(text="Start bot", style="Start.TButton"); return
        self.btn.config(text="Stop bot", style="Stop.TButton")
        age = time.time() - eng.last_price_time if eng.last_price_time else None
        if rows and (age is None or age > 15): self.status.config(text="●  RUNNING - waiting for prices", fg=ORANGE)
        elif rows: self.status.config(text=f"●  RUNNING - prices updated {age:.1f}s ago", fg=GREEN)
        else: self.status.config(text=f"●  RUNNING - scanning every {bot.CONFIG['scan_interval_sec']}s", fg=GREEN)

    def update_history(self):
        path = bot.CONFIG["trades_csv"]
        try: st = os.stat(path); sig = (st.st_mtime, st.st_size)
        except OSError: sig = None
        if sig == self.csv_sig: return
        self.csv_sig = sig; self.hist_tree.delete(*self.hist_tree.get_children())
        for vals in read_trades(path):
            if vals[1] == "BUY": tag = "buy"
            else: tag = "up" if vals[5].startswith("+") else "down" if vals[5].startswith("-") else "flat"
            self.hist_tree.insert("", "end", values=vals, tags=(tag,))

    def drain_log(self):
        for _ in range(300):
            try: self.append_log(self.logq.get_nowait())
            except queue.Empty: break

    def append_log(self, line):
        low = line.lower()
        tag = ("reject" if ("reject" in low or "rug" in low or "filtered" in low) else
               "buy" if "sniper buy" in low else
               "sell" if "sell" in low else
               "warn" if any(w in low for w in ("error", "failed")) else None)
        at_bottom = self.log.yview()[1] > 0.97
        self.log.config(state="normal"); self.log.insert("end", line + "\n", tag or ())
        lines = int(self.log.index("end-1c").split(".")[0])
        if lines > 3000: self.log.delete("1.0", f"{lines - 2500}.0")
        self.log.config(state="disabled")
        if at_bottom: self.log.see("end")

def main():
    if tk is None: print("tkinter is not available."); return
    try: import ctypes; ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception: pass
    load_settings(); logq = queue.Queue(); bot.CONSOLE_OUTPUT = False; bot.LOG_HOOK = logq.put
    engine = Engine(); root = tk.Tk(); App(root, engine, logq)
    bot.log("Window ready. Press 'Start bot' to begin paper trading (no real money is used).")
    if "--start" in sys.argv: engine.start()
    root.mainloop()

if __name__ == "__main__": main()