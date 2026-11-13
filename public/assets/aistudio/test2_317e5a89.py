#!/usr/bin/env python3
"""
Solana Auto-Trading Bot (GUI): signals from DexScreener/GeckoTerminal/RugCheck, trading through Jupiter,
signing with a Phantom wallet key.

!! REAL MONEY !!  LIVE mode spends real SOL from the wallet whose key is in phantom_key.txt.
The bot starts STOPPED and in PAPER mode (simulated trades) every time. Use a NEW wallet that holds only money
you can afford to lose. Never share the key and never copy it into chat, email or a cloud folder.

Run:   py signal_gui.py
Needs: Python 3.8+ with tkinter (included in the normal Windows installer).
       LIVE trading also needs:   py -m pip install solders      (paper mode needs nothing extra)

Files next to this script:
  jupiter_key.txt   free API key from portal.jup.ag (prices, quotes and trades go through Jupiter)
  phantom_key.txt   private key of the trading wallet (Phantom: Settings > Manage Accounts > your account >
                    Show Private Key). Best: make a separate "Bot" account in Phantom and fund it with a little SOL.
  rpc_url.txt       optional: your own Solana RPC URL (free at helius.dev or quicknode.com) if the public one is slow

Rules built in
- It NEVER sells below your cost (only you can, with the "Sell all now" button, after a warning).
- Winners are protected by a profit-lock ladder that only moves up (see Help).
- After any sale, the same coin cannot be bought again until the cooldown has passed.
- Every buy is preceded by a Jupiter sell test (honeypot check).
"""
import base64
import csv
import json
import os
import queue
import re
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from collections import deque
from datetime import datetime
from tkinter import messagebox, ttk

API = "https://api.dexscreener.com"
GECKO_API = "https://api.geckoterminal.com/api/v2"
RUG_API = "https://api.rugcheck.xyz/v1/tokens/{mint}/report"
JUP_PRICE_URL = "https://api.jup.ag/price/v3"
JUP_ORDER_URL = "https://api.jup.ag/swap/v2/order"      # quote only (no wallet needed)
JUP_QUOTE_V1_URL = "https://api.jup.ag/swap/v1/quote"   # older endpoint, used as a fallback
SOL_MINT = "So11111111111111111111111111111111111111112"
JUP_EXECUTE_URL = "https://api.jup.ag/swap/v2/execute"
RPC_DEFAULT = "https://api.mainnet-beta.solana.com"
CHAIN = "solana"

TICK_SECONDS = 1.0           # DexScreener refresh (liquidity, volume, buys/sells)
EVAL_EVERY = 20              # seconds between BUY/WAIT/AVOID re-scores
CONFIRMATIONS = 3            # BUY needs this many passing scores in a row
HISTORY_LEN = 30
DISCOVER_EVERY = 60
MAX_AUTO_COINS = 60
MAX_NEW_PER_SCAN = 15
ROTATE_SECONDS = 20 * 60     # auto coins that never reach BUY are swapped out after this long
IGNORE_SECONDS = 60 * 60     # a dropped auto coin can come back after this long
SAFETY_TTL = 600             # re-check holders/risks every 10 min (2 min for coins you hold)
SAFETY_PER_CYCLE = 8
FAST_MAX_AGE = 8             # use a Jupiter price only if it is at most this many seconds old
RESORT_EVERY = 5             # seconds between re-sorting rows (so they don't jump around)
INSIDER_MAX = 25             # % of supply held by RugCheck-flagged insiders before AVOID
CREATOR_MAX = 15             # % of supply still held by the creator before AVOID

HERE = os.path.dirname(os.path.abspath(__file__))
SAVE_FILE = os.path.join(HERE, "watchlist.json")
TRADES_FILE = os.path.join(HERE, "trades.csv")
JUP_KEY_FILE = os.path.join(HERE, "jupiter_key.txt")
WALLET_KEY_FILE = os.path.join(HERE, "phantom_key.txt")
RPC_FILE = os.path.join(HERE, "rpc_url.txt")
DEFAULT_TIERS = "15:40,30:55,60:70,100:80"   # peak gain %  :  % of that gain to lock in
MAX_BUY_SOL = 1.0                            # hard safety cap per buy (protects against typos)
DEFAULT_WATCH = ["e1fm1y9d6hnxt9ftehkaurkjaeejby42dfzv39axczds"]

ADDR_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")

PRESETS = {
    "Safe":         {"liq": 50000, "holders": 1500, "top10": 35, "ratio": 1.3, "txns": 60, "vol": 8000,
                     "tp1": 30, "tp2": 60, "min_profit": 4, "lock_tiers": "10:50,20:60,40:70,80:80"},
    "Balanced":     {"liq": 20000, "holders": 1000, "top10": 50, "ratio": 1.3, "txns": 40, "vol": 5000,
                     "tp1": 50, "tp2": 100, "min_profit": 5, "lock_tiers": DEFAULT_TIERS},
    "New launches": {"liq": 8000, "holders": 150, "top10": 60, "ratio": 1.5, "txns": 30, "vol": 3000,
                     "tp1": 50, "tp2": 100, "min_profit": 6, "lock_tiers": "20:35,40:50,80:65,150:75"},
    "Aggressive":   {"liq": 5000, "holders": 100, "top10": 70, "ratio": 1.2, "txns": 20, "vol": 2000,
                     "tp1": 100, "tp2": 200, "min_profit": 8, "lock_tiers": "30:30,60:45,120:60,250:70"},
}

# ------------------------------------------------------------------------------------------
# TELEGRAM ALERTS (currently DISABLED).
# To turn on:
#   1. In Telegram, talk to @BotFather, send /newbot, copy the token it gives you.
#   2. Send any message to your new bot, then talk to @userinfobot to get your numeric chat id.
#   3. Remove the leading "# " from the lines in this block AND from the one line inside notify() below.
# ------------------------------------------------------------------------------------------
# TELEGRAM_TOKEN = "PUT_YOUR_BOT_TOKEN_HERE"
# TELEGRAM_CHAT_ID = "PUT_YOUR_CHAT_ID_HERE"
#
# def send_telegram(text):
#     try:
#         url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
#         body = json.dumps({"chat_id": TELEGRAM_CHAT_ID, "text": text}).encode()
#         req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
#         urllib.request.urlopen(req, timeout=10).read()
#     except Exception:
#         pass


def notify(text):
    """Called for every BUY / SELL / take-profit alert. Telegram is OFF until you uncomment the block above."""
    # threading.Thread(target=send_telegram, args=(text,), daemon=True).start()
    pass


# ---------------------------------------------------------------- network helpers
def http_json(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "Mozilla/5.0 signal-gui"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def gecko(path):
    req = urllib.request.Request(GECKO_API + path, headers={
        "Accept": "application/json;version=20230302", "User-Agent": "Mozilla/5.0 signal-gui"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def load_jup_key():
    key = os.environ.get("JUP_API_KEY", "").strip()
    if not key:
        try:
            with open(JUP_KEY_FILE) as f:
                key = f.read().strip()
        except Exception:
            key = ""
    return key


def jup_prices(mints, key=""):
    headers = {"User-Agent": "Mozilla/5.0 signal-gui"}
    if key:
        headers["x-api-key"] = key
    req = urllib.request.Request(JUP_PRICE_URL + "?ids=" + ",".join(mints), headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def _jup_get(url, key=""):
    headers = {"User-Agent": "Mozilla/5.0 signal-gui"}
    if key:
        headers["x-api-key"] = key
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as r:
        return json.load(r)


def jup_sell_quote(mint, raw_amount, key=""):
    """Ask Jupiter what selling raw_amount (smallest units) of the token for SOL would return.
    This only asks for a price quote: nothing is signed and no wallet is involved.
    Returns {"out": lamports, "impact": percent, "error": text or ""}."""
    try:
        d = _jup_get(f"{JUP_ORDER_URL}?inputMint={mint}&outputMint={SOL_MINT}&amount={raw_amount}", key)
    except urllib.error.HTTPError as e:
        if e.code not in (404, 405):
            raise
        d = _jup_get(f"{JUP_QUOTE_V1_URL}?inputMint={mint}&outputMint={SOL_MINT}&amount={raw_amount}"
                     f"&slippageBps=300", key)
    pi = d.get("priceImpact")
    impact = abs(float(pi)) if pi is not None else abs(float(d.get("priceImpactPct") or 0)) * 100
    return {"out": int(d.get("outAmount") or 0), "impact": impact,
            "error": str(d.get("errorMessage") or d.get("error") or "")}


def http_error_text(e):
    try:
        return e.read().decode("utf-8", "ignore")[:300]
    except Exception:
        return ""


def _jup_headers(key):
    h = {"User-Agent": "Mozilla/5.0 signal-gui"}
    if key:
        h["x-api-key"] = key
    return h


def to_int(x):
    """Jupiter returns amounts as strings or numbers; keep full integer precision."""
    try:
        return int(x)
    except (TypeError, ValueError):
        try:
            return int(float(x))
        except (TypeError, ValueError):
            return 0


def jup_order(input_mint, output_mint, amount, taker="", key=""):
    """GET /swap/v2/order. With a taker (wallet address) the answer contains a transaction to sign;
    without one it is only a price quote (used for paper trading)."""
    url = f"{JUP_ORDER_URL}?inputMint={input_mint}&outputMint={output_mint}&amount={int(amount)}"
    if taker:
        url += f"&taker={taker}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=_jup_headers(key)), timeout=20) as r:
        return json.load(r)


def jup_execute(signed_b64, request_id, key=""):
    """POST /swap/v2/execute: Jupiter sends the signed transaction to the chain and reports the result."""
    body = json.dumps({"signedTransaction": signed_b64, "requestId": request_id}).encode()
    headers = _jup_headers(key)
    headers["Content-Type"] = "application/json"
    req = urllib.request.Request(JUP_EXECUTE_URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


class Wallet:
    """Holds the trading key in memory only. It is read from phantom_key.txt (or the PHANTOM_PRIVATE_KEY
    environment variable), used locally to sign swaps, and never printed, logged or sent anywhere."""

    def __init__(self):
        self.kp = None
        self.address = ""
        self.error = ""
        self.load()

    @property
    def ready(self):
        return self.kp is not None

    def load(self):
        secret = os.environ.get("PHANTOM_PRIVATE_KEY", "").strip()
        if not secret:
            try:
                # utf-8-sig automatically strips any Windows Notepad BOM (\ufeff)
                with open(WALLET_KEY_FILE, encoding="utf-8-sig") as f:
                    secret = f.read().strip()
            except FileNotFoundError:
                self.error = "no phantom_key.txt next to the script (paper mode works without it)"
                return
            except Exception as e:
                self.error = f"cannot read phantom_key.txt ({type(e).__name__})"
                return
        if not secret:
            self.error = "phantom_key.txt is empty"
            return

        # Strip surrounding quotes ("..." or '...' or `...`)
        if (secret.startswith('"') and secret.endswith('"')) or \
           (secret.startswith("'") and secret.endswith("'")) or \
           (secret.startswith("`") and secret.endswith("`")):
            secret = secret[1:-1].strip()

        # Strip assignment prefix like "PHANTOM_PRIVATE_KEY = ..." or "key: ..."
        m = re.match(r"^(?:export\s+)?(?:PHANTOM_PRIVATE_KEY|private_key|key|secret)\s*[:=]\s*(.+)$", secret, re.IGNORECASE)
        if m:
            secret = m.group(1).strip()
            if (secret.startswith('"') and secret.endswith('"')) or (secret.startswith("'") and secret.endswith("'")):
                secret = secret[1:-1].strip()

        # Check if user accidentally pasted their 12 or 24-word Secret Recovery Phrase
        words = secret.split()
        if len(words) in (12, 15, 18, 21, 24) and all(w.isalpha() for w in words):
            self.kp, self.address = None, ""
            self.error = (
                f"phantom_key.txt contains a {len(words)}-word Secret Recovery Phrase, NOT a private key!\n"
                "Phantom export: click Settings (gear) > Manage Accounts > your account > Show Private Key."
            )
            return

        # Remove internal whitespace and newlines (e.g. from copy-paste wrapping)
        clean_b58 = re.sub(r"\s+", "", secret)

        # Check if user pasted a public address (~43-44 base58 characters, 32 bytes)
        if 32 <= len(clean_b58) <= 44 and ADDR_RE.fullmatch(clean_b58):
            self.kp, self.address = None, ""
            self.error = (
                f"You pasted your PUBLIC Wallet Address ({clean_b58[:6]}...{clean_b58[-4:]}), NOT your Private Key!\n"
                "A public address cannot sign trades. Phantom's private key is ~88 characters long.\n"
                "In Phantom: Settings > Manage Accounts > your account > 'Show Private Key' (enter password)."
            )
            return

        try:
            from solders.keypair import Keypair
        except ImportError:
            self.error = "package missing: run  py -m pip install solders"
            return

        try:
            if clean_b58.startswith("[") and clean_b58.endswith("]"):
                data = json.loads(clean_b58)
                if len(data) == 64:
                    self.kp = Keypair.from_bytes(bytes(data))
                elif len(data) == 32:
                    self.kp = Keypair.from_seed(bytes(data))
                else:
                    raise ValueError(f"JSON byte array has length {len(data)} (expected 64 or 32 bytes)")
            else:
                self.kp = Keypair.from_base58_string(clean_b58)
            self.address = str(self.kp.pubkey())
            self.error = ""
        except Exception as e:
            self.kp, self.address = None, ""
            err_text = str(e)
            if "expected 64 bytes" in err_text or "length" in err_text.lower():
                self.error = (
                    f"Invalid key length ({len(clean_b58)} chars): {e}\n"
                    "Phantom private keys are ~88 characters base58 (64 bytes). Make sure you didn't copy a public address."
                )
            else:
                self.error = f"Invalid private key in phantom_key.txt: {e}"



def sign_transaction(kp, tx_b64):
    """Signs a transaction received from Jupiter and returns it as base64. Only our own signature slot is filled,
    so transactions that already carry another party's signature stay valid."""
    from solders.message import to_bytes_versioned
    from solders.transaction import VersionedTransaction
    vtx = VersionedTransaction.from_bytes(base64.b64decode(tx_b64))
    msg = vtx.message
    keys = list(msg.account_keys)
    me = kp.pubkey()
    if me not in keys[:msg.header.num_required_signatures]:
        raise ValueError("this transaction does not ask for our wallet's signature")
    sigs = list(vtx.signatures)
    sigs[keys.index(me)] = kp.sign_message(to_bytes_versioned(msg))
    return base64.b64encode(bytes(VersionedTransaction.populate(msg, sigs))).decode()


def load_rpc_url():
    url = os.environ.get("SOLANA_RPC_URL", "").strip()
    if not url:
        try:
            with open(RPC_FILE, encoding="utf-8") as f:
                url = f.read().strip()
        except Exception:
            url = ""
    return url or RPC_DEFAULT


def rpc_call(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                          "User-Agent": "Mozilla/5.0 signal-gui"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.load(r)
    if d.get("error"):
        err = d["error"]
        raise RuntimeError(err.get("message", str(err)) if isinstance(err, dict) else str(err))
    return d["result"]


def rpc_sol_balance(url, owner):
    """SOL balance in lamports."""
    return int(rpc_call(url, "getBalance", [owner])["value"])


def rpc_token_balance(url, owner, mint):
    """Raw token balance (smallest units) of one mint across all of the owner's token accounts."""
    res = rpc_call(url, "getTokenAccountsByOwner", [owner, {"mint": mint}, {"encoding": "jsonParsed"}])
    return sum(int(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for a in res.get("value", []))


def parse_tiers(text):
    """'15:40,30:55' -> [(15.0, 40.0), (30.0, 55.0)]  (peak gain %, % of that gain to lock in). Bad parts are ignored."""
    tiers = []
    for part in str(text).split(","):
        try:
            lvl, frac = part.split(":")
            lvl, frac = float(lvl), float(frac)
        except ValueError:
            continue
        if lvl > 0 and 0 < frac < 100:
            tiers.append((lvl, frac))
    return sorted(tiers)


def lock_gain(peak_gain, tiers, min_profit):
    """Profit (in %) that is locked in once the coin's best gain so far was `peak_gain` %.
    Returns None while the first tier has not been reached. The result never goes down as the peak rises,
    never drops below min_profit, and never exceeds the peak gain itself."""
    locked = [peak_gain * frac / 100.0 for lvl, frac in tiers if peak_gain >= lvl]
    if not locked:
        return None
    return min(peak_gain, max(max(locked), min_profit))


def fmt_cool(seconds):
    seconds = int(seconds)
    return f"{seconds // 60}m {seconds % 60:02d}s" if seconds >= 60 else f"{seconds}s"


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def best_pair(pairs):
    pairs = [p for p in pairs if p.get("chainId") == CHAIN]
    if not pairs:
        return None
    return max(pairs, key=lambda p: float((p.get("liquidity") or {}).get("usd") or 0))


def resolve_input(text):
    """Turn a link / pair address / token address into a pair address (or None)."""
    found = ADDR_RE.findall(text or "")
    if not found:
        return None
    addr = found[-1]
    try:
        data = http_json(f"/latest/dex/pairs/{CHAIN}/{addr}")
        pairs = data.get("pairs") or ([data["pair"]] if data.get("pair") else [])
        if pairs:
            return pairs[0]["pairAddress"]
    except Exception:
        pass
    try:
        pairs = http_json(f"/tokens/v1/{CHAIN}/{addr}")
        bp = best_pair(pairs if isinstance(pairs, list) else [])
        if bp:
            return bp["pairAddress"]
    except Exception:
        pass
    return None


def rugcheck(mint):
    """Holders, concentration, authorities, insiders, creator share and risks from RugCheck. None on failure.
    Insider / creator / LP fields are best effort: they are used only when RugCheck returns them."""
    try:
        req = urllib.request.Request(RUG_API.format(mint=mint), headers={"User-Agent": "Mozilla/5.0 signal-gui"})
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.load(r)
    except Exception:
        return None
    top = d.get("topHolders") or []
    top10 = sum(float(h.get("pct") or 0) for h in top[:10])
    insider = sum(float(h.get("pct") or 0) for h in top if h.get("insider"))
    creator = d.get("creator") or ""
    creator_pct = sum(float(h.get("pct") or 0) for h in top
                      if creator and creator in (h.get("address"), h.get("owner")))
    lps = [(m.get("lp") or {}).get("lpLockedPct") for m in (d.get("markets") or [])]
    lps = [float(x) for x in lps if x is not None]
    danger = [x.get("name", "?") for x in (d.get("risks") or []) if str(x.get("level", "")).lower() == "danger"]
    holders = d.get("totalHolders")
    return {
        "holders": int(holders) if holders is not None else None,
        "top10": top10, "insider": insider, "creator_pct": creator_pct,
        "lp_locked": max(lps) if lps else None,
        "mint_auth": bool(d.get("mintAuthority")), "freeze_auth": bool(d.get("freezeAuthority")),
        "rugged": bool(d.get("rugged")), "danger": danger, "top10_drop": 0.0,
        "decimals": (d.get("token") or {}).get("decimals"),
    }


class Ignored:
    """Set-like list of dropped coins. Auto-dropped ones expire; manually removed ones stay removed."""
    def __init__(self):
        self.d = {}

    def add(self, key, permanent=False):
        self.d[key] = None if permanent else time.time()

    def discard(self, key):
        self.d.pop(key, None)

    def __contains__(self, key):
        if key not in self.d:
            return False
        t = self.d[key]
        if t is not None and time.time() - t > IGNORE_SECONDS:
            del self.d[key]
            return False
        return True


# ---------------------------------------------------------------- scoring
def new_state(auto):
    return {"auto": auto, "hist": deque(maxlen=HISTORY_LEN), "ath": 0.0, "streak": 0,
            "avoid_count": 0, "alerted": False, "sell_alerted": False,
            "last_eval": 0.0, "verdict": "WAIT", "reasons": ["starting..."], "added": time.time(),
            "ticks": deque(maxlen=400), "liq_hist": deque(maxlen=200), "dir": "",
            "entry": None, "entry_time": None, "peak": 0.0, "tp_alerted": set(), "warn_alerted": False,
            "sol_in": 0, "tokens": 0, "bot": False, "paper": False,
            "last_buy_try": 0.0, "last_sell_try": 0.0, "guard_log": 0.0}


def social_str(p):
    info = p.get("info") or {}
    parts = []
    if info.get("websites"):
        parts.append("W")
    kinds = {str(s.get("type", "")).lower() for s in (info.get("socials") or [])}
    for key, letter in (("twitter", "X"), ("telegram", "T"), ("discord", "D")):
        if key in kinds:
            parts.append(letter)
    return " ".join(parts) if parts else "-"


def _evaluate(p, st, cfg, sf=None, sell=None):
    """Return (verdict, reasons). Verdict is BUY, WAIT or AVOID.
    sf = RugCheck info or None. sell = cached sell-test result or None."""
    st["want_sell_test"] = False
    price = float(p.get("priceUsd") or 0)
    if price <= 0:
        return "AVOID", ["no price"]
    liq = float((p.get("liquidity") or {}).get("usd") or 0)
    m5 = (p.get("txns") or {}).get("m5", {})
    buys, sells = m5.get("buys", 0), m5.get("sells", 0)
    vol5 = float((p.get("volume") or {}).get("m5") or 0)
    ch = p.get("priceChange") or {}
    ch5, ch1h = float(ch.get("m5") or 0), float(ch.get("h1") or 0)

    st["ath"] = max(st["ath"], price)
    st["hist"].append(price)
    low = min(st["hist"])
    ratio = buys / max(sells, 1)
    drawdown = 1 - price / st["ath"] if st["ath"] else 0
    bounce = price / low - 1 if low else 0

    avoid, wait, ok = [], [], []
    if liq < cfg["liq"]:
        avoid.append(f"liquidity ${liq:,.0f} < ${cfg['liq']:,.0f}")
    if drawdown > 0.60:
        avoid.append(f"{drawdown:.0%} below the high seen")
    if ch1h < -40:
        avoid.append(f"1h change {ch1h:.0f}% (dumping)")
    if cfg.get("sell_test") and sell and sell["status"] == "fail":
        avoid.append(f"SELL TEST FAILED: {sell['why']}")

    if sf is None:
        wait.append("safety check pending or unavailable (no BUY without it)")
    else:
        if sf["rugged"]:
            avoid.append("RugCheck marks this token as rugged")
        if sf["holders"] is None:
            wait.append("holder count unknown")
        elif sf["holders"] < cfg["holders"]:
            avoid.append(f"only {sf['holders']} holders (min {int(cfg['holders'])})")
        if sf["top10"] > cfg["top10"]:
            avoid.append(f"top 10 wallets hold {sf['top10']:.0f}% (max {cfg['top10']:.0f}%)")
        if cfg["authority"] and (sf["mint_auth"] or sf["freeze_auth"]):
            avoid.append("mint or freeze authority NOT revoked")
        if sf.get("insider", 0) > INSIDER_MAX:
            avoid.append(f"insiders hold {sf['insider']:.0f}% of supply")
        if sf.get("creator_pct", 0) > CREATOR_MAX:
            avoid.append(f"creator still holds {sf['creator_pct']:.0f}% of supply")
        if sf["danger"]:
            avoid.append("RugCheck danger: " + ", ".join(sf["danger"][:3]))
        if sf.get("lp_locked") is not None:
            ok.append(f"LP locked/burned {sf['lp_locked']:.0f}%")

    if cfg.get("social"):
        (ok if social_str(p) != "-" else wait).append("website/socials listed" if social_str(p) != "-"
                                                      else "no website/socials listed")

    (ok if ratio >= cfg["ratio"] else wait).append(f"5m buy/sell {ratio:.2f} (need {cfg['ratio']})")
    (ok if buys + sells >= cfg["txns"] else wait).append(f"5m txns {buys + sells} (need {cfg['txns']:.0f})")
    (ok if vol5 >= cfg["vol"] else wait).append(f"5m vol ${vol5:,.0f} (need ${cfg['vol']:,.0f})")
    (ok if ch5 > 0 else wait).append(f"5m change {ch5:+.1f}% (need +)")
    if len(st["hist"]) >= 5:
        if bounce < 0.03:
            wait.append(f"only {bounce:.1%} above recent low (no bounce yet)")
        elif bounce > 0.25:
            wait.append(f"already {bounce:.0%} above recent low (chasing)")
        else:
            ok.append(f"bounced {bounce:.1%} off recent low")
    else:
        wait.append("collecting price history...")

    if avoid:
        st["streak"] = 0
        return "AVOID", avoid
    if wait:
        st["streak"] = 0
        return "WAIT", wait
    st["streak"] += 1
    if cfg.get("sell_test"):
        # every other check passed: a BUY also needs proof that the coin can actually be sold
        if sell and sell["status"] == "pass":
            ok.append(f"sell test passed (${cfg['sell_usd']:.0f} sells with {sell['impact']:.1f}% impact)")
        else:
            st["want_sell_test"] = True          # tells the sell-test worker to check this coin now
            why = sell["why"] if sell else "checking now"
            return "WAIT", ok + [f"sell test not passed yet ({why})"]
    if st["streak"] >= CONFIRMATIONS:
        return "BUY", ok + [f"confirmed {st['streak']}x in a row"]
    return "WAIT", ok + [f"conditions met, confirming {st['streak']}/{CONFIRMATIONS}"]


def evaluate(p, st, cfg, sf=None, preview=False, sell=None):
    """preview=True re-scores a coin with new settings WITHOUT changing its history or confirmation count."""
    if not preview:
        return _evaluate(p, st, cfg, sf, sell)
    saved = (st["streak"], list(st["hist"]), st["ath"])
    try:
        return _evaluate(p, st, cfg, sf, sell)
    finally:
        st["streak"], st["ath"] = saved[0], saved[2]
        st["hist"].clear()
        st["hist"].extend(saved[1])


# ---------------------------------------------------------------- formatting / parsing
def fmt_usd(x):
    x = float(x or 0)
    if x >= 1e9:
        return f"${x / 1e9:.2f}B"
    if x >= 1e6:
        return f"${x / 1e6:.2f}M"
    if x >= 1e3:
        return f"${x / 1e3:.1f}K"
    return f"${x:.0f}"


def fmt_price(x):
    if x >= 1:
        return f"${x:,.4f}"
    if x >= 0.01:
        return f"${x:.6f}"
    return f"${x:.8f}"


def fmt_age(ms):
    if not ms:
        return "?"
    s = max(0, time.time() - ms / 1000)
    if s < 3600:
        return f"{int(s // 60)}m"
    if s < 86400:
        return f"{s / 3600:.1f}h"
    return f"{s / 86400:.1f}d"


def parse_num(text):
    """Turn table text like '$372.2K', '+1.50', '17,972', '69.8d' into something sortable."""
    s = str(text).replace("$", "").replace(",", "").replace("%", "").replace("+", "").strip()
    for suffix, mult in (("B", 1e9), ("M", 1e6), ("K", 1e3), ("d", 86400), ("h", 3600), ("m", 60)):
        if s.endswith(suffix):
            try:
                return (0, float(s[:-1]) * mult)
            except ValueError:
                break
    try:
        return (0, float(s))
    except ValueError:
        return (1, s.lower())


# ---------------------------------------------------------------- trade history
TRADE_FIELDS = ["closed_at", "coin", "pair", "entry", "exit", "pnl_pct", "held_minutes",
                "mode", "sol_in", "sol_out", "tx"]


def append_trade(row):
    """Adds a row to trades.csv. If the file already has an older header, that header is kept."""
    fields = TRADE_FIELDS
    new = not os.path.exists(TRADES_FILE)
    if not new:
        try:
            with open(TRADES_FILE, newline="") as f:
                fields = next(csv.reader(f))
        except Exception:
            fields = TRADE_FIELDS
    with open(TRADES_FILE, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        if new:
            w.writeheader()
        w.writerow(row)


def read_trades():
    try:
        with open(TRADES_FILE, newline="") as f:
            return list(csv.DictReader(f))
    except Exception:
        return []


def trade_stats(trades):
    pnls = []
    for t in trades:
        try:
            pnls.append(float(t["pnl_pct"]))
        except (KeyError, ValueError):
            continue
    if not pnls:
        return "No closed trades yet. Select a coin you hold and press 'I sold this' to log one."
    wins = sum(1 for x in pnls if x > 0)
    return (f"{len(pnls)} trades  |  win rate {wins / len(pnls):.0%}  |  average {sum(pnls) / len(pnls):+.1f}%  |  "
            f"sum of results {sum(pnls):+.1f}%  |  best {max(pnls):+.1f}%  |  worst {min(pnls):+.1f}%")


# ---------------------------------------------------------------- backtest (1-minute candles)
def backtest_candles(candles, cfg):
    """candles: chronological [ts, open, high, low, close, volume_usd].
    Replays a simplified version of the BUY rules (bounce, 5m momentum, volume, drawdown, 3 confirmations) with the
    same exit rules as the live bot: no stop-loss, nothing is sold below cost, winners are sold by the profit lock.
    A position that never reaches a profit stays open until the data ends (that is the real risk of this strategy).
    After every sale the coin is not bought again for cfg['cooldown_min'] candles (= minutes).
    Returns a list of trades (dicts); open ones have 'open': True and an unrealized pnl."""
    n = len(candles)
    trades = []
    if n < 40:
        return trades
    closes = [c[4] for c in candles]
    run_max = max(c[2] for c in candles[:30])
    streak, i = 0, 30
    min_profit = cfg.get("min_profit", 5)
    tiers = cfg.get("tiers") or parse_tiers(DEFAULT_TIERS)
    while i < n:
        run_max = max(run_max, candles[i][2])
        close = closes[i]
        window_low = min(closes[i - 30:i + 1])
        bounce = close / window_low - 1 if window_low > 0 else 0
        ch5 = close / closes[i - 5] - 1 if closes[i - 5] > 0 else 0
        vol5 = sum(c[5] for c in candles[i - 4:i + 1])
        drawdown = 1 - close / run_max if run_max > 0 else 1
        good = 0.03 <= bounce <= 0.25 and ch5 > 0 and vol5 >= cfg["vol"] and drawdown <= 0.60
        streak = streak + 1 if good else 0
        if streak < CONFIRMATIONS:
            i += 1
            continue

        entry, peak = close, close
        exit_i, exit_px, reason = None, closes[-1], ""
        for j in range(i + 1, n):
            _ts, o, h, l, c, _v = candles[j]
            lg = lock_gain((peak / entry - 1) * 100, tiers, min_profit)
            if lg is not None:
                floor = entry * (1 + lg / 100)
                if l <= floor:
                    fill = min(floor, o)                       # a gap down fills at the open
                    if fill >= entry * (1 + min_profit / 100):  # never sell below the minimum profit
                        exit_i, exit_px, reason = j, fill, f"profit lock +{lg:.0f}%"
                        break
            peak = max(peak, h)
        if exit_i is None:
            trades.append({"in": i, "out": n - 1, "entry": entry, "exit": closes[-1], "open": True,
                           "pnl": (closes[-1] / entry - 1) * 100, "reason": "still open (never sold at a loss)"})
            break
        trades.append({"in": i, "out": exit_i, "entry": entry, "exit": exit_px, "open": False,
                       "pnl": (exit_px / entry - 1) * 100, "reason": reason})
        i = exit_i + int(cfg.get("cooldown_min", 30)) + 1      # cooldown after each sale
        streak = 0
    return trades


def backtest_summary(name, candles, trades):
    if len(candles) < 40:
        return f"{name}: not enough history ({len(candles)} candles)"
    if not trades:
        return f"{name}: {len(candles)} candles, no BUY signals fired"
    closed = [t["pnl"] for t in trades if not t.get("open")]
    opened = [t["pnl"] for t in trades if t.get("open")]
    text = f"{name}: {len(candles)} candles, {len(closed)} sold in profit"
    if closed:
        text += f" (avg {sum(closed) / len(closed):+.1f}%, best {max(closed):+.1f}%)"
    if opened:
        text += f", {len(opened)} STILL OPEN at {opened[0]:+.1f}% (not sold, never sold at a loss)"
    return text


# ---------------------------------------------------------------- themes
THEMES = {
    "light": {"bg": "#f0f0f0", "fg": "#111111", "field": "#ffffff", "chart": "#ffffff", "grid": "#dddddd",
              "rows": {"BUY": "#8ee59a", "WAIT": "#fff2a8", "AVOID": "#f6b4b4", "HOLD": "#b8d8ff",
                       "PROFIT": "#7fe3d4", "SELL": "#ff9d4d"}, "rowfg": "#000000"},
    "dark": {"bg": "#1e1f22", "fg": "#e8e8e8", "field": "#2b2d31", "chart": "#15161a", "grid": "#33363c",
             "rows": {"BUY": "#1f7a3a", "WAIT": "#7a6a14", "AVOID": "#7a2b2b", "HOLD": "#244b7a",
                      "PROFIT": "#0f7a6b", "SELL": "#c75a00"}, "rowfg": "#ffffff"},
}
HELP_TEXT = """THE BOT: START / STOP, PAPER / LIVE
The bot starts STOPPED every time you open the program. Press "Start bot" to let it trade by itself.
PAPER (default) = simulated: it uses real Jupiter quotes but no money moves, so you can watch how it behaves.
LIVE = real swaps from your wallet. Tick "LIVE trading", confirm the warning, then press Start. Switching between
PAPER and LIVE always stops the bot. "Stop bot" stops all automatic buying and selling; your coins stay in your wallet
and you can still use "Buy now" / "Sell all now" by hand. Auto-buy and Auto-sell can be switched off separately.

WALLET SETUP (one time)
1. In Phantom create a NEW account just for the bot and send it a small amount of SOL.
2. Phantom: Settings > Manage Accounts > that account > Show Private Key. Copy it into a file called
   phantom_key.txt next to this program. Never share it with anyone and never put it in a cloud folder.
3. Run once:  py -m pip install solders      4. Put your free Jupiter key in jupiter_key.txt (portal.jup.ag).
5. If the SOL balance shows an error, put a free RPC address (helius.dev) in rpc_url.txt.
Phantom itself cannot be remote-controlled, so the bot signs with that account's key. Anyone who gets the key can
empty the account, so keep only what you can afford to lose in it.

BUY SIZE / MAX OPEN COINS / KEEP SOL FOR FEES
Buy size = SOL spent per coin (hard maximum 1). Max open coins = the bot stops buying while it already holds that many.
Keep SOL for fees = SOL that is never spent, so you can always pay network fees. Manual buys ignore Max open coins.

NEVER SELL AT A LOSS
There is no stop-loss. Before every automatic sale the bot asks Jupiter what the sale would really return (after fees
and price impact) and refuses unless that is above what you paid plus "Min profit to sell %". A coin that falls and
never recovers is simply held, it can even go to zero, and it keeps using up one of your "Max open coins" slots.
Only the "Sell all now" button can sell below cost, after a warning. The optional "Emergency exit on rug warning"
sells even at a loss when a rug-pull warning appears (liquidity drained, top wallets dumping); it is off by default.

PROFIT LOCK (trailing lock ladder)
Format: peak gain % : % of that gain to lock, for example   15:40,30:55,60:70,100:80
Nothing is sold while the coin is below the first level. When your best gain so far reaches +15%, 40% of that gain
(+6%) becomes a floor. At +30% the floor is 55% of the gain (+16.5%), at +60% it is 42%, at +100% it is +80%.
The floor only moves up, never down. If the price falls back to the floor, the bot sells in profit.
Min profit to sell % is the lowest profit it will ever accept. The take-profit alert levels (TP1, TP2) only give a
teal PROFIT alert; the sale itself is done by the lock.

COOLDOWN
After any sale of a coin (automatic or manual) the bot will not buy that coin again for this many minutes, even
if a new BUY signal appears. The "Cooldown" column counts it down. It is saved, so restarting does not reset it.

BUY NOW / SELL ALL NOW
Manual trades through the same Jupiter connection. Select a coin and press the button; you are asked to confirm.
"I bought this" / "I sold this" only record a trade you made somewhere else (for example in Phantom itself).
"Jupiter swap page" opens jup.ag where you can trade with Phantom yourself.

PRESET
A preset fills in the filter numbers and the profit-lock levels with one click. Safe = strict filters and tight
locks. Balanced = middle ground. New launches = looser filters for brand-new coins. Aggressive = loosest filters.
Presets never change your buy size. You can still edit any number afterwards, and it applies instantly.

FIND (Mix / Newest / Trending / Top volume)
Where the auto-scanner looks for coins. Newest = just-launched pools. Trending = pools people are trading right
now. Top volume = biggest pools by 24h volume. Mix = all of them together. Scanning runs by itself every minute.

MIN 5m TXNS
The minimum number of trades (buys plus sells) in the last 5 minutes. A coin with only a handful of trades can be
moved by one person, so it is not a reliable signal. Higher = only busy coins can show BUY.

SELL TEST (before BUY)
Some scam coins let you buy but not sell (honeypots). Before a coin can show BUY, and again right before the bot
buys, Jupiter is asked for a price quote for selling a small amount (default $20) back to SOL. If Jupiter finds no
way to sell it, or the price drops more than "max impact %", the coin gets AVOID and is not bought.
The "Sell test" column shows OK with the impact, FAIL, ? (could not test yet) or - (not needed yet).
A good quote does not guarantee a real sale will work, but it removes many traps.

OTHER FILTERS
Min liquidity: money in the pool. Too little and you can't sell without crashing the price.
Min B/S ratio: buys divided by sells in the last 5 minutes. 1.3 means 30% more buys than sells.
Min 5m vol: dollars traded in the last 5 minutes.
Min holders / Max top-10 %: how many wallets hold the coin and how much the biggest 10 hold (RugCheck data).

BACKTEST SELECTED / ALL
Replays the BUY rules and the same exit rules on about 16 hours of past 1-minute candles. Because losing trades are
never sold, closed trades are always profitable by design. Look at the "STILL OPEN" positions and how deep they are
under water: that is the real risk. It ignores fees and slippage, and the past does not predict the future.

CHART
Candles: green = price closed higher than it opened, red = lower. Pick 10s live, 1m, 5m or 15m candles. The blue
line is your entry, the orange line your current profit-lock floor.
"""

MEANING = {"BUY": "looks good now", "WAIT": "not yet", "AVOID": "unsafe / bad", "HOLD": "your coin, waiting",
           "PROFIT": "your coin, in profit", "SELL": "your coin, profit lock hit"}


# ---------------------------------------------------------------- app
class App:
    COLS = ("coin", "price", "move", "m1", "liq", "mcap", "holders", "top10", "ch5", "ch1h", "ratio",
            "vol5", "age", "social", "sell", "src", "pnl", "lock", "cool", "px", "note", "signal")
    HEAD = ("Coin", "Price", "Move", "1m %", "Liquidity", "MCap", "Holders", "Top10 %", "5m %", "1h %",
            "B/S 5m", "Vol 5m", "Age", "Social", "Sell test", "Source", "Your P/L", "Profit lock", "Cooldown",
            "Price feed", "Note", "Signal")
    WIDTH = (100, 105, 45, 60, 75, 75, 65, 60, 55, 55, 60, 70, 50, 60, 70, 55, 70, 85, 75, 80, 120, 70)
    COMPACT = ("coin", "price", "move", "m1", "liq", "holders", "pnl", "lock", "cool", "signal")
    RANK = {"SELL": 0, "PROFIT": 1, "BUY": 2, "HOLD": 3, "WAIT": 4, "AVOID": 5}

    def __init__(self, root):
        self.root = root
        root.title("Solana Auto-Trading Bot: Jupiter + Phantom (PAPER mode unless you switch to LIVE)")
        root.geometry("1400x1000")
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.watch = {}            # pair -> state
        self.mints = {}            # pair -> token mint
        self.notes = {}            # pair -> note text
        self.ignored = Ignored()
        self.disc_round = 0
        self.fast = {}             # mint -> (price, blockId, timestamp) from Jupiter
        self.fast_status = "Jupiter: starting"
        self.jup_key = load_jup_key()
        self.sel_pair = None
        self.rows = {}             # pair -> info for the UI
        self.safety = {}           # mint -> (timestamp, info or None)
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.disc_wake = threading.Event()
        self.last_sort = 0.0
        self.sort_col, self.sort_rev = None, False
        self.themed_labels = []
        self.bt_win = None
        self.candle_cache = {}     # (pair, timeframe) -> (timestamp, candles)
        self.sell_cache = {}       # mint -> (timestamp, sell-test result)
        self.decimals = {}         # mint -> token decimals (from Jupiter)
        self.chart_wake = threading.Event()
        self.chart_pair_last = None
        self.chart_tf = "1m"
        self.force_eval = False    # set when a setting changes so every coin is re-scored right away
        self.last_scan_txt = "starting"
        self.setting_job = None
        self.wallet = Wallet()
        self.rpc_url = load_rpc_url()
        self.sol_balance = None
        self.wallet_note = ""
        self.bot_on = False        # the bot always starts STOPPED
        self.cooldown = {}         # mint -> time until which the bot will not buy it again
        self.inflight = {}         # pair -> "buy" / "sell" while a trade is queued or running
        self.trade_q = queue.Queue()

        S = tk.StringVar
        self.v = {"liq": S(value="20000"), "ratio": S(value="1.3"), "txns": S(value="40"), "vol": S(value="5000"),
                  "holders": S(value="1000"), "top10": S(value="50"),
                  "tp1": S(value="50"), "tp2": S(value="100"),
                  "sell_usd": S(value="20"), "sell_impact": S(value="5"),
                  "buy_sol": S(value="0.02"), "max_pos": S(value="3"), "reserve": S(value="0.01"),
                  "cooldown_min": S(value="30"), "min_profit": S(value="5"), "lock_tiers": S(value=DEFAULT_TIERS)}
        self.b = {"authority": tk.BooleanVar(value=True), "social": tk.BooleanVar(value=False),
                  "auto": tk.BooleanVar(value=True), "hide": tk.BooleanVar(value=False),
                  "dark": tk.BooleanVar(value=False), "compact": tk.BooleanVar(value=False),
                  "sell_test": tk.BooleanVar(value=True), "live": tk.BooleanVar(value=False),
                  "auto_buy": tk.BooleanVar(value=True), "auto_sell": tk.BooleanVar(value=True),
                  "emergency": tk.BooleanVar(value=False)}
        self.v_mode = S(value="Mix")
        self.v_tf = S(value="1m")
        self.v_preset = S(value="Balanced")
        self.v_price = S(value="")
        self.v_note = S(value="")
        self.v_search = S(value="")
        self.v_status = S(value="Starting...")

        self.build_ui()
        self.load_watchlist()
        self.apply_theme()
        self.apply_compact()
        self.cfg_cache = self.cfg()      # worker threads read this copy, never the tk variables
        self.auto_on = self.b["auto"].get()
        for target in (self.worker, self.disc_worker, self.safety_worker, self.fast_worker, self.chart_worker,
                       self.sell_test_worker, self.trade_worker, self.wallet_worker):
            threading.Thread(target=target, daemon=True).start()
        self.v_search.trace_add("write", lambda *a: self.resort(force=True))
        # any settings change is applied automatically (no restart, no button)
        for var in list(self.v.values()) + list(self.b.values()) + [self.v_mode]:
            var.trace_add("write", lambda *a: self.on_setting_changed())
        root.after(300, self.drain)
        root.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------------------------------------------------------------- UI
    def build_ui(self):
        self.style = ttk.Style()
        self.base_theme = self.style.theme_use()
        self.style.configure("Treeview", rowheight=26)

        self.big = tk.Label(self.root, text="Select a coin to see its live price", font=("Segoe UI", 20, "bold"),
                            anchor="w", padx=10, pady=4)
        self.big.pack(fill="x")
        self.signal_var = tk.StringVar(value="Signals: auto-scanning, please wait a moment...")
        ttk.Label(self.root, textvariable=self.signal_var, font=("Segoe UI", 10, "bold"),
                  wraplength=1250, padding=(10, 0)).pack(fill="x")
        bar = ttk.Frame(self.root, padding=(6, 2))
        bar.pack(fill="x")
        ttk.Label(bar, text="Chart candles:").pack(side="left")
        tfc = ttk.Combobox(bar, width=8, state="readonly", textvariable=self.v_tf, values=("10s live", "1m", "5m", "15m"))
        tfc.pack(side="left", padx=4)
        tfc.bind("<<ComboboxSelected>>", lambda e: self.on_tf_change())
        ttk.Label(bar, text="(follows the coin you select, or the strongest signal if none is selected)").pack(side="left", padx=8)
        self.chart = tk.Canvas(self.root, height=240, highlightthickness=0)
        self.chart.pack(fill="x", padx=6)

        top = ttk.Frame(self.root, padding=(6, 4))
        top.pack(fill="x")
        ttk.Label(top, text="Add coin (link / pair / token address):").pack(side="left")
        self.entry = ttk.Entry(top, width=44)
        self.entry.pack(side="left", padx=6)
        self.entry.bind("<Return>", lambda e: self.add_coin())
        for text, cmd in (("Add", self.add_coin), ("Remove selected", self.remove_selected),
                          ("Open chart", self.open_selected), ("Jupiter swap page", self.open_swap),
                          ("Copy address", self.copy_address)):
            ttk.Button(top, text=text, command=cmd).pack(side="left", padx=2)

        trade = ttk.Frame(self.root, padding=(6, 2))
        trade.pack(fill="x")
        self.bot_label = tk.Label(trade, text="BOT STOPPED", font=("Segoe UI", 10, "bold"), padx=10, pady=2,
                                  bg="#9e9e9e", fg="white")
        self.bot_label.pack(side="left")
        ttk.Button(trade, text="Start bot", command=self.start_bot).pack(side="left", padx=(8, 2))
        ttk.Button(trade, text="Stop bot", command=self.stop_bot).pack(side="left", padx=2)
        ttk.Checkbutton(trade, text="LIVE trading (real money)", variable=self.b["live"],
                        command=self.on_live_toggle).pack(side="left", padx=(10, 2))
        ttk.Checkbutton(trade, text="Auto-buy", variable=self.b["auto_buy"]).pack(side="left", padx=2)
        ttk.Checkbutton(trade, text="Auto-sell", variable=self.b["auto_sell"]).pack(side="left", padx=2)
        ttk.Button(trade, text="Buy now", command=self.manual_buy).pack(side="left", padx=(10, 2))
        ttk.Button(trade, text="Sell all now", command=self.manual_sell).pack(side="left", padx=2)
        self.wallet_var = tk.StringVar(value="")
        ttk.Label(trade, textvariable=self.wallet_var).pack(side="left", padx=12)

        pos = ttk.Frame(self.root, padding=(6, 2))
        pos.pack(fill="x")
        ttk.Label(pos, text="Record a trade made elsewhere:   price $ (blank = current)").pack(side="left")
        ttk.Entry(pos, width=13, textvariable=self.v_price).pack(side="left", padx=4)
        for text, cmd in (("I bought this", self.mark_bought), ("I sold this", self.mark_sold),
                          ("Clear position", self.clear_position), ("Trade history", self.show_history),
                          ("Backtest selected", self.backtest_selected), ("Backtest all", self.backtest_all)):
            ttk.Button(pos, text=text, command=cmd).pack(side="left", padx=2)
        ttk.Label(pos, text="    Note:").pack(side="left")
        ne = ttk.Entry(pos, width=24, textvariable=self.v_note)
        ne.pack(side="left", padx=2)
        ne.bind("<Return>", lambda e: self.save_note())
        ttk.Button(pos, text="Save note", command=self.save_note).pack(side="left")

        flt = self.flt = ttk.Frame(self.root, padding=(6, 2))
        flt.pack(fill="x")
        ttk.Label(flt, text="Search:").pack(side="left")
        ttk.Entry(flt, width=16, textvariable=self.v_search).pack(side="left", padx=4)
        ttk.Checkbutton(flt, text="Hide AVOID", variable=self.b["hide"],
                        command=lambda: self.resort(force=True)).pack(side="left", padx=6)
        ttk.Checkbutton(flt, text="Compact layout", variable=self.b["compact"],
                        command=self.apply_compact).pack(side="left", padx=6)
        ttk.Checkbutton(flt, text="Dark mode", variable=self.b["dark"], command=self.apply_theme).pack(side="left", padx=6)
        ttk.Label(flt, text="   Preset:").pack(side="left")
        pc = ttk.Combobox(flt, width=13, state="readonly", textvariable=self.v_preset, values=tuple(PRESETS))
        pc.pack(side="left", padx=4)
        pc.bind("<<ComboboxSelected>>", self.apply_preset)
        self.settings_open = tk.BooleanVar(value=True)
        ttk.Checkbutton(flt, text="Show settings", variable=self.settings_open,
                        command=self.toggle_settings).pack(side="left", padx=10)
        ttk.Button(flt, text="Help: what do the settings mean?", command=self.show_help).pack(side="left", padx=6)

        self.settings = ttk.Frame(self.root)
        self.settings.pack(fill="x")
        r1 = ttk.Frame(self.settings, padding=(6, 2))
        r1.pack(fill="x")
        ttk.Checkbutton(r1, text="Auto-find new Solana coins", variable=self.b["auto"],
                        command=self.disc_wake.set).pack(side="left")
        for label, key in (("Min liquidity $", "liq"), ("Min B/S ratio", "ratio"),
                           ("Min 5m txns", "txns"), ("Min 5m vol $", "vol")):
            ttk.Label(r1, text="   " + label).pack(side="left")
            ttk.Entry(r1, width=8, textvariable=self.v[key]).pack(side="left")
        ttk.Button(r1, text="Scan now", command=self.scan_now).pack(side="left", padx=10)
        ttk.Label(r1, text="Find:").pack(side="left")
        ttk.Combobox(r1, width=11, state="readonly", textvariable=self.v_mode,
                     values=("Mix", "Newest", "Trending", "Top volume")).pack(side="left", padx=4)
        r2 = ttk.Frame(self.settings, padding=(6, 2))
        r2.pack(fill="x")
        ttk.Label(r2, text="Safety (RugCheck):").pack(side="left")
        for label, key in (("Min holders", "holders"), ("Max top-10 wallets %", "top10")):
            ttk.Label(r2, text="   " + label).pack(side="left")
            ttk.Entry(r2, width=7, textvariable=self.v[key]).pack(side="left")
        ttk.Checkbutton(r2, text="Require mint + freeze revoked", variable=self.b["authority"]).pack(side="left", padx=10)
        ttk.Checkbutton(r2, text="Require website/socials", variable=self.b["social"]).pack(side="left")
        ttk.Checkbutton(r2, text="Sell test before BUY: sell $", variable=self.b["sell_test"]).pack(side="left", padx=(12, 0))
        ttk.Entry(r2, width=5, textvariable=self.v["sell_usd"]).pack(side="left")
        ttk.Label(r2, text="max impact %").pack(side="left", padx=(6, 0))
        ttk.Entry(r2, width=4, textvariable=self.v["sell_impact"]).pack(side="left")
        r3 = ttk.Frame(self.settings, padding=(6, 2))
        r3.pack(fill="x")
        ttk.Label(r3, text="Trading:").pack(side="left")
        for label, key, w in (("Buy size SOL (max 1)", "buy_sol", 7), ("Max open coins", "max_pos", 4),
                              ("Keep SOL for fees", "reserve", 6), ("Cooldown after a sale (min)", "cooldown_min", 5)):
            ttk.Label(r3, text="   " + label).pack(side="left")
            ttk.Entry(r3, width=w, textvariable=self.v[key]).pack(side="left")
        r4 = ttk.Frame(self.settings, padding=(6, 2))
        r4.pack(fill="x")
        ttk.Label(r4, text="Profit exits (never below cost):   Min profit to sell %").pack(side="left")
        ttk.Entry(r4, width=5, textvariable=self.v["min_profit"]).pack(side="left")
        ttk.Label(r4, text="   Profit lock tiers (peak gain %:lock %)").pack(side="left")
        ttk.Entry(r4, width=26, textvariable=self.v["lock_tiers"]).pack(side="left")
        for label, key in (("TP alert 1 +%", "tp1"), ("TP alert 2 +%", "tp2")):
            ttk.Label(r4, text="   " + label).pack(side="left")
            ttk.Entry(r4, width=5, textvariable=self.v[key]).pack(side="left")
        ttk.Checkbutton(r4, text="Emergency exit on rug warning (may sell at a loss)",
                        variable=self.b["emergency"]).pack(side="left", padx=12)

        self.legend = tk.Frame(self.root)
        self.legend.pack(fill="x", padx=6, pady=2)
        for name in MEANING:
            lab = tk.Label(self.legend, text=f" {name} = {MEANING[name]} ", padx=4)
            lab.pack(side="left", padx=3)
            self.themed_labels.append((lab, name))

        mid = ttk.Frame(self.root, padding=6)
        mid.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(mid, columns=self.COLS, show="headings", selectmode="browse")
        for c, h, w in zip(self.COLS, self.HEAD, self.WIDTH):
            self.tree.heading(c, text=h, command=lambda c=c: self.sort_by(c))
            self.tree.column(c, width=w, anchor="w" if c in ("coin", "note") else "center")
        sb = ttk.Scrollbar(mid, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="left", fill="y")
        self.tree.bind("<<TreeviewSelect>>", self.on_select)
        self.tree.bind("<Double-1>", lambda e: self.open_selected())

        self.reason_var = tk.StringVar(value="Select a coin to see why it got its signal. Click a column header to sort.")
        ttk.Label(self.root, textvariable=self.reason_var, wraplength=1250, padding=4).pack(fill="x")
        ttk.Label(self.root, text="Signal log", padding=(6, 0)).pack(anchor="w")
        self.log = tk.Text(self.root, height=5, state="disabled")
        self.log.pack(fill="x", padx=6)
        ttk.Label(self.root, textvariable=self.v_status, relief="sunken", anchor="w").pack(fill="x", side="bottom")
        ttk.Label(self.root, text="Rule-based signals, not predictions. LIVE mode spends real money and a coin that is never "
                                  "sold at a loss can fall to zero. Only risk what you can afford to lose.",
                  foreground="#a00", padding=3).pack(fill="x", side="bottom")

    def toggle_settings(self):
        if self.settings_open.get():
            self.settings.pack(fill="x", after=self.flt)
        else:
            self.settings.pack_forget()

    def fix_tree_map(self):
        """Workaround for Tk 8.6.9 where row tag colors don't show. Must be redone after a theme change."""
        def fixed(option):
            return [e for e in self.style.map("Treeview", query_opt=option) if e[:2] != ("!disabled", "!selected")]
        self.style.map("Treeview", foreground=fixed("foreground"), background=fixed("background"))

    def apply_theme(self):
        t = THEMES["dark" if self.b["dark"].get() else "light"]
        st = self.style
        st.theme_use("clam" if self.b["dark"].get() else self.base_theme)
        self.fix_tree_map()
        st.configure(".", background=t["bg"], foreground=t["fg"])
        for w in ("TLabel", "TFrame", "TCheckbutton", "TButton"):
            st.configure(w, background=t["bg"], foreground=t["fg"])
        st.configure("TEntry", fieldbackground=t["field"], foreground=t["fg"])
        st.configure("TCombobox", fieldbackground=t["field"], foreground=t["fg"], background=t["bg"])
        st.configure("Treeview", background=t["field"], fieldbackground=t["field"], foreground=t["fg"], rowheight=26)
        st.configure("Treeview.Heading", background=t["bg"], foreground=t["fg"])
        self.root.configure(bg=t["bg"])
        self.legend.configure(bg=t["bg"])
        self.big.configure(bg=t["bg"])
        self.chart.configure(bg=t["chart"])
        self.log.configure(bg=t["field"], fg=t["fg"], insertbackground=t["fg"])
        for lab, name in self.themed_labels:
            lab.configure(bg=t["rows"][name], fg=t["rowfg"])
        for name, color in t["rows"].items():
            opts = {"background": color, "foreground": t["rowfg"]}
            if name == "SELL":
                opts["font"] = ("Segoe UI", 9, "bold")
            self.tree.tag_configure(name, **opts)
        self.update_big()
        self.draw_chart()

    def apply_compact(self):
        self.tree["displaycolumns"] = self.COMPACT if self.b["compact"].get() else "#all"

    def apply_preset(self, _e=None):
        d = PRESETS.get(self.v_preset.get())
        if d:
            for k, val in d.items():
                self.v[k].set(str(val))

    def cfg(self):
        def num(key, default):
            try:
                return float(self.v[key].get())
            except ValueError:
                return default
        c = {k: num(k, d) for k, d in (("liq", 20000), ("ratio", 1.3), ("txns", 40), ("vol", 5000),
                                       ("holders", 1000), ("top10", 50), ("tp1", 50), ("tp2", 100),
                                       ("sell_usd", 20), ("sell_impact", 5), ("buy_sol", 0.02), ("max_pos", 3),
                                       ("reserve", 0.01), ("cooldown_min", 30), ("min_profit", 5))}
        c["max_pos"] = max(0, int(c["max_pos"]))
        c["cooldown_min"] = max(0.0, c["cooldown_min"])
        c["tiers"] = parse_tiers(self.v["lock_tiers"].get()) or parse_tiers(DEFAULT_TIERS)
        for k in ("sell_test", "authority", "social", "live", "auto_buy", "auto_sell", "emergency"):
            c[k] = self.b[k].get()
        c["mode"] = self.v_mode.get()
        return c

    def on_setting_changed(self):
        """Wait until you stop typing (0.6 s), then apply everything."""
        if self.setting_job:
            self.root.after_cancel(self.setting_job)
        self.setting_job = self.root.after(600, self.apply_settings_now)

    def apply_settings_now(self):
        self.setting_job = None
        old, new = self.cfg_cache, self.cfg()
        self.cfg_cache = new
        self.auto_on = self.b["auto"].get()
        if old["sell_usd"] != new["sell_usd"] or old["sell_impact"] != new["sell_impact"]:
            self.sell_cache.clear()                  # old test results used the old amount / limit
        self.force_eval = True                       # re-score every coin immediately with the new settings
        self.wake.set()
        if old["liq"] != new["liq"] or old["mode"] != new["mode"]:
            self.disc_wake.set()                     # find coins again with the new filters
        self.save_watchlist()
        self.v_status.set("Settings applied")

    def show_help(self):
        win = tk.Toplevel(self.root)
        win.title("What do the settings mean?")
        win.geometry("760x600")
        box = tk.Text(win, wrap="word", font=("Segoe UI", 10), padx=10, pady=10)
        box.insert("end", HELP_TEXT)
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)

    def log_line(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", f"[{datetime.now():%H:%M:%S}] {text}\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def beep(self, freq):
        try:
            import winsound
            threading.Thread(target=lambda: [winsound.Beep(freq, 250) for _ in range(2)], daemon=True).start()
        except Exception:
            self.root.bell()

    def alert(self, freq, text):
        self.beep(freq)
        self.log_line(text)
        notify(text)

    # ---------------------------------------------------------------- watchlist / settings persistence
    def load_watchlist(self):
        coins, entries, notes, cooldowns = DEFAULT_WATCH, {}, {}, {}
        try:
            with open(SAVE_FILE) as f:
                data = json.load(f)
            if isinstance(data, list):
                coins = data
            else:
                coins = data.get("coins", DEFAULT_WATCH)
                entries, notes = data.get("entries", {}), data.get("notes", {})
                cooldowns = data.get("cooldowns", {})
                for k, val in (data.get("settings") or {}).items():
                    if k == "live":
                        continue                  # LIVE mode is never restored: you switch it on on purpose
                    var = self.v.get(k) or self.b.get(k)
                    if var is not None:
                        try:
                            var.set(val)
                        except Exception:
                            pass
                if data.get("mode"):
                    self.v_mode.set(data["mode"])
        except Exception:
            pass
        self.notes = dict(notes)
        now = time.time()
        self.cooldown = {m: t for m, t in cooldowns.items() if isinstance(t, (int, float)) and t > now}
        with self.lock:
            for a in coins:
                st = new_state(False)
                e = entries.get(a)
                if e:
                    price, t = (e["price"], e.get("t")) if isinstance(e, dict) else (e, None)
                    st["entry"], st["entry_time"] = float(price), t
                    st["peak"] = max(float(price), float(e.get("peak") or 0)) if isinstance(e, dict) else float(price)
                    if isinstance(e, dict):
                        st["sol_in"], st["tokens"] = to_int(e.get("sol_in")), to_int(e.get("tokens"))
                        st["bot"], st["paper"] = bool(e.get("bot")), bool(e.get("paper"))
                self.watch[a] = st

    def save_watchlist(self):
        try:
            with self.lock:
                coins = [a for a, s in self.watch.items() if not s["auto"]]
                entries = {a: {"price": s["entry"], "t": s["entry_time"], "peak": s["peak"], "sol_in": s["sol_in"],
                               "tokens": s["tokens"], "bot": s["bot"], "paper": s["paper"]}
                           for a, s in self.watch.items() if s["entry"]}
            settings = {k: var.get() for k, var in {**self.v, **self.b}.items() if k != "live"}
            now = time.time()
            with open(SAVE_FILE, "w") as f:
                json.dump({"coins": coins, "entries": entries, "notes": self.notes,
                           "settings": settings, "mode": self.v_mode.get(),
                           "cooldowns": {m: t for m, t in self.cooldown.items() if t > now}}, f)
        except Exception:
            pass

    # ---------------------------------------------------------------- buttons
    def selected(self):
        sel = self.tree.selection()
        return sel[0] if sel else None

    def add_coin(self):
        text = self.entry.get().strip()
        if not text:
            return
        self.entry.delete(0, "end")
        self.v_status.set("Looking up coin...")

        def job():
            pair = resolve_input(text)
            if not pair:
                self.q.put(("status", "Could not find that coin on Solana. Check the address."))
                return
            with self.lock:
                if pair in self.watch:
                    self.watch[pair]["auto"] = False
                else:
                    self.watch[pair] = new_state(False)
                self.ignored.discard(pair)
            self.q.put(("save", None))
            self.wake.set()
        threading.Thread(target=job, daemon=True).start()

    def remove_selected(self):
        pair = self.selected()
        if not pair:
            return
        with self.lock:
            self.watch.pop(pair, None)
            self.ignored.add(pair, permanent=True)
        self.rows.pop(pair, None)
        self.tree.delete(pair)
        self.save_watchlist()

    def open_selected(self):
        pair = self.selected()
        if pair:
            webbrowser.open(f"https://dexscreener.com/{CHAIN}/{pair}")

    def open_swap(self):
        """Opens Jupiter's swap page for the coin. You review and confirm any trade yourself, in your own wallet."""
        pair = self.selected()
        mint = self.mints.get(pair)
        if mint:
            webbrowser.open(f"https://jup.ag/swap/SOL-{mint}")

    def copy_address(self):
        mint = self.mints.get(self.selected())
        if mint:
            self.root.clipboard_clear()
            self.root.clipboard_append(mint)
            self.v_status.set(f"Copied token address {mint[:6]}...{mint[-4:]}")

    def price_from_box(self, pair):
        txt = self.v_price.get().strip()
        if not txt:
            return self.rows[pair]["price"]
        return float(txt)

    @staticmethod
    def clear_pos(st):
        st.update(entry=None, entry_time=None, peak=0.0, sell_alerted=False, tp_alerted=set(), warn_alerted=False,
                  sol_in=0, tokens=0, bot=False, paper=False)

    def mark_bought(self):
        pair = self.selected()
        if not pair or pair not in self.rows:
            self.v_status.set("Select a coin first, then press 'I bought this'.")
            return
        try:
            price = self.price_from_box(pair)
        except ValueError:
            self.v_status.set("Price must be a number like 0.00013")
            return
        with self.lock:
            st = self.watch.get(pair)
            if st:
                self.clear_pos(st)
                st.update(entry=price, peak=price, auto=False, entry_time=time.time())
        self.v_price.set("")
        self.save_watchlist()
        self.log_line(f"Tracking your position in {self.rows[pair]['name']} from {fmt_price(price)} "
                      f"(a trade you made yourself: the bot only shows signals for it, it does not sell it)")

    def mark_sold(self):
        pair = self.selected()
        if not pair or pair not in self.rows:
            self.v_status.set("Select the coin you sold first.")
            return
        with self.lock:
            st = self.watch.get(pair)
        if not st or not st["entry"]:
            self.v_status.set("No open position on this coin. Press 'I bought this' first.")
            return
        try:
            exit_px = self.price_from_box(pair)
        except ValueError:
            self.v_status.set("Price must be a number like 0.00013")
            return
        entry = st["entry"]
        pnl = (exit_px / entry - 1) * 100
        held = (time.time() - st["entry_time"]) / 60 if st["entry_time"] else 0
        append_trade({"closed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "coin": self.rows[pair]["name"],
                      "pair": pair, "entry": entry, "exit": exit_px, "pnl_pct": f"{pnl:.2f}",
                      "held_minutes": f"{held:.0f}", "mode": "MANUAL"})
        with self.lock:
            self.clear_pos(st)
        self.start_cooldown(self.mints.get(pair))
        self.v_price.set("")
        self.save_watchlist()
        self.log_line(f"Logged trade: {self.rows[pair]['name']} {pnl:+.1f}% ({fmt_price(entry)} -> {fmt_price(exit_px)})")

    def clear_position(self):
        pair = self.selected()
        if not pair:
            return
        with self.lock:
            st = self.watch.get(pair)
            if st:
                self.clear_pos(st)
        self.save_watchlist()

    def save_note(self):
        pair = self.selected()
        if not pair:
            return
        text = self.v_note.get().strip()
        if text:
            self.notes[pair] = text
        else:
            self.notes.pop(pair, None)
        self.save_watchlist()
        if self.tree.exists(pair) and pair in self.rows:
            vals = list(self.rows[pair]["values"])
            vals[self.COLS.index("note")] = text
            self.rows[pair]["values"] = tuple(vals)
            self.tree.item(pair, values=self.rows[pair]["values"])

    def scan_now(self):
        self.disc_wake.set()
        self.wake.set()

    def show_history(self):
        win = tk.Toplevel(self.root)
        win.title("Trade history (trades.csv)")
        win.geometry("920x420")
        trades = read_trades()
        ttk.Label(win, text=trade_stats(trades), padding=8, wraplength=720).pack(fill="x")
        cols = ("closed_at", "coin", "entry", "exit", "pnl_pct", "held_minutes", "mode", "sol_in", "sol_out")
        tv = ttk.Treeview(win, columns=cols, show="headings")
        for c, w in zip(cols, (150, 90, 100, 100, 70, 90, 70, 90, 90)):
            tv.heading(c, text=c.replace("_", " "))
            tv.column(c, width=w, anchor="center")
        tv.tag_configure("win", background="#c8f0cf", foreground="black")
        tv.tag_configure("loss", background="#f6c4c4", foreground="black")
        for t in reversed(trades):
            try:
                tag = "win" if float(t["pnl_pct"]) > 0 else "loss"
            except (KeyError, ValueError):
                tag = ""
            tv.insert("", "end", values=[t.get(c, "") for c in cols], tags=(tag,))
        tv.pack(fill="both", expand=True, padx=8, pady=8)

    # ---------------------------------------------------------------- backtest
    def backtest_selected(self):
        pair = self.selected()
        if not pair:
            self.v_status.set("Select a coin first.")
            return
        self.run_backtest([pair])

    def backtest_all(self):
        self.run_backtest(list(self.rows)[:25])

    def run_backtest(self, pairs):
        cfg = dict(self.cfg_cache)
        names = {p: self.rows[p]["name"] for p in pairs if p in self.rows}
        self.v_status.set(f"Backtesting {len(names)} coin(s)... (about 2 seconds per coin)")

        def job():
            lines, closed_pnls, open_pnls = [], [], []
            for idx, pair in enumerate(names):
                try:
                    res = gecko(f"/networks/solana/pools/{pair}/ohlcv/minute?aggregate=1&limit=1000&currency=usd")
                    raw = res["data"]["attributes"]["ohlcv_list"]
                    candles = sorted(([float(x) for x in c[:6]] for c in raw), key=lambda c: c[0])
                    trades = backtest_candles(candles, cfg)
                    closed_pnls += [t["pnl"] for t in trades if not t.get("open")]
                    open_pnls += [t["pnl"] for t in trades if t.get("open")]
                    lines.append(backtest_summary(names[pair], candles, trades))
                    for t in trades[:6]:
                        tag = "OPEN  " if t.get("open") else "closed"
                        lines.append(f"      {tag} in {fmt_price(t['entry'])} -> {fmt_price(t['exit'])}  "
                                     f"{t['pnl']:+.1f}%  ({t['reason']})")
                except Exception as e:
                    lines.append(f"{names[pair]}: could not load candles ({e})")
                self.q.put(("status", f"Backtesting... {idx + 1}/{len(names)}"))
                self.stop.wait(2.3)
            locks = ",".join(f"{a:g}:{b:g}" for a, b in cfg["tiers"])
            head = ["BACKTEST on the last ~16 hours of 1-minute candles per coin",
                    f"Rules: vol>=${cfg['vol']:,.0f}/5m, bounce 3-25% off the 30-min low, 5m momentum up, "
                    f"3 confirmations | exits: NO stop-loss, profit lock {locks}, "
                    f"min profit {cfg['min_profit']:.0f}%, cooldown {cfg['cooldown_min']:.0f} min", ""]
            if closed_pnls or open_pnls:
                head.append(f"ALL COINS: {len(closed_pnls)} trades sold in profit (average "
                            f"{(sum(closed_pnls) / len(closed_pnls)) if closed_pnls else 0:+.1f}%), "
                            f"{len(open_pnls)} positions STILL OPEN"
                            + (f" (average {sum(open_pnls) / len(open_pnls):+.1f}% right now)" if open_pnls else ""))
            else:
                head.append("ALL COINS: no trades fired.")
            tail = ["", "READ THIS: the bot never sells at a loss, so every CLOSED trade is a win by design.",
                    "The number that matters is how many positions are STILL OPEN and how far under water they are:",
                    "that money is stuck until the coin recovers, and it can go to zero.",
                    "Candles do not include buy/sell counts, holders or RugCheck data, so only part of the live rules",
                    "is tested. No fees or slippage are included. The past does not predict the future."]
            self.q.put(("backtest", "\n".join(head + [""] + lines + tail)))
        threading.Thread(target=job, daemon=True).start()

    def show_backtest(self, text):
        win = tk.Toplevel(self.root)
        win.title("Backtest results")
        win.geometry("860x520")
        box = tk.Text(win, wrap="word", font=("Consolas", 10))
        box.insert("end", text)
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)

    # ---------------------------------------------------------------- selection / chart / headline
    def on_select(self, _e=None):
        self.sel_pair = self.selected()
        pair = self.sel_pair
        self.v_note.set(self.notes.get(pair, "") if pair else "")
        self.show_reasons()
        self.update_big()
        self.draw_chart()

    def show_reasons(self):
        pair = self.selected()
        if pair and pair in self.rows:
            r = self.rows[pair]
            self.reason_var.set(f"{r['name']}: {r['verdict']}  |  " + "  |  ".join(r["reasons"]))

    def current_pair(self):
        """The coin you selected, or (if none) the strongest signal right now, so the top line and chart
        follow the action automatically."""
        pair = self.selected()
        if pair and pair in self.rows:
            return pair
        if not self.rows:
            return None
        return min(self.rows.values(), key=lambda r: (self.RANK[r["verdict"]], -r["liq"]))["pair"]

    def update_big(self):
        pair = self.current_pair()
        if not pair:
            return
        r = self.rows[pair]
        arrow = "▲" if r["m1"] > 0 else "▼" if r["m1"] < 0 else "•"
        color = {"▲": "#0a8f2c" if not self.b["dark"].get() else "#4cd96f",
                 "▼": "#c62828" if not self.b["dark"].get() else "#ff6b6b"}.get(
            arrow, "#555555" if not self.b["dark"].get() else "#bbbbbb")
        self.big.configure(
            text=f"{r['name']}   {fmt_price(r['price'])}   {arrow} {r['m1']:+.2f}% (1m)   [{r['verdict']}]   {r['px']}",
            fg=color)

    def on_tf_change(self):
        self.chart_tf = self.v_tf.get()
        self.chart_wake.set()
        self.draw_chart()

    def chart_worker(self):
        """Fetches real 1m / 5m / 15m candles for the coin on the chart (GeckoTerminal), every 20 s or on change."""
        while not self.stop.is_set():
            self.chart_wake.wait(20)
            self.chart_wake.clear()
            pair, tf = self.chart_pair_last, self.chart_tf
            if not pair or tf == "10s live":
                continue
            agg = {"1m": 1, "5m": 5, "15m": 15}.get(tf, 1)
            try:
                res = gecko(f"/networks/solana/pools/{pair}/ohlcv/minute?aggregate={agg}&limit=80&currency=usd")
                raw = res["data"]["attributes"]["ohlcv_list"]
                candles = sorted(([float(x) for x in c[:6]] for c in raw), key=lambda c: c[0])
                self.candle_cache[(pair, tf)] = (time.time(), candles)
            except Exception:
                pass                       # keep the old candles, try again in 20 s
            self.stop.wait(2)              # stay well under GeckoTerminal's rate limit

    @staticmethod
    def live_candles(ticks, bucket=10):
        """Build candles from our own price ticks: [time, open, high, low, close, volume]."""
        out = []
        for t, pr in ticks:
            ts = int(t // bucket) * bucket
            if out and out[-1][0] == ts:
                cd = out[-1]
                cd[2], cd[3], cd[4] = max(cd[2], pr), min(cd[3], pr), pr
            else:
                out.append([ts, pr, pr, pr, pr, 0.0])
        return out

    def draw_chart(self):
        c = self.chart
        c.delete("all")
        t = THEMES["dark" if self.b["dark"].get() else "light"]
        pair = self.current_pair()
        if pair != self.chart_pair_last:
            self.chart_pair_last = pair
            self.chart_wake.set()
        w, h = max(c.winfo_width(), 300), max(c.winfo_height(), 120)
        if not pair:
            return
        r = self.rows[pair]
        tf = self.v_tf.get()
        note = ""
        if tf == "10s live":
            candles, period = self.live_candles(r["ticks"]), 10
        else:
            period = {"1m": 60, "5m": 300, "15m": 900}.get(tf, 60)
            cached = self.candle_cache.get((pair, tf))
            candles = [list(x) for x in cached[1]] if cached and cached[1] else []
            if not candles:
                candles, period, note = self.live_candles(r["ticks"]), 10, "  (loading history, showing live 10s candles)"
            else:                          # put the live price into the newest candle
                now, px, last = time.time(), r["price"], candles[-1]
                if px > 0 and now < last[0] + period:
                    last[4], last[2], last[3] = px, max(last[2], px), min(last[3], px)
                elif px > 0:
                    ts = last[0] + int((now - last[0]) // period) * period
                    candles.append([ts, last[4], max(last[4], px), min(last[4], px), px, 0.0])
        candles = candles[-60:]
        if len(candles) < 2:
            c.create_text(w / 2, h / 2, text="collecting live prices...", fill=t["fg"])
            return
        levels = [("entry", r["entry"], "#3b82f6"), ("lock", r["lock_px"], "#f59e0b"),
                  ("TP1", r["tp1_px"], "#22a55b"), ("TP2", r["tp2_px"], "#22a55b")]
        lo = min([cd[3] for cd in candles] + [lv for _n, lv, _c in levels if lv])
        hi = max([cd[2] for cd in candles] + [lv for _n, lv, _c in levels if lv])
        if hi == lo:
            hi, lo = hi * 1.001, lo * 0.999
        pad = (hi - lo) * 0.06
        lo, hi = lo - pad, hi + pad
        left, right, top, bottom = 84, w - 12, 12, h - 22

        def Y(v):
            return bottom - (bottom - top) * (v - lo) / (hi - lo)
        for frac in (0, 0.25, 0.5, 0.75, 1):
            v = lo + (hi - lo) * frac
            c.create_line(left, Y(v), right, Y(v), fill=t["grid"])
            c.create_text(left - 6, Y(v), text=f"{v:.8f}".rstrip("0").rstrip("."), anchor="e",
                          fill=t["fg"], font=("Segoe UI", 8))
        n = len(candles)
        slot = (right - left) / n
        body = max(2.0, slot * 0.65)
        for i, (_ts, o, hh, ll, cl, _v) in enumerate(candles):
            x = left + slot * (i + 0.5)
            color = "#22c55e" if cl >= o else "#ef4444"
            c.create_line(x, Y(hh), x, Y(ll), fill=color)
            y1, y2 = Y(max(o, cl)), Y(min(o, cl))
            if y2 - y1 < 1:
                y2 = y1 + 1
            c.create_rectangle(x - body / 2, y1, x + body / 2, y2, fill=color, outline=color)
        for name, lv, color in levels:
            if lv:
                c.create_line(left, Y(lv), right, Y(lv), fill=color, dash=(4, 3))
                c.create_text(right, Y(lv) - 7, text=name, anchor="e", fill=color, font=("Segoe UI", 8, "bold"))
        fmt = "%H:%M:%S" if period < 60 else "%H:%M"
        c.create_text(left, h - 10, text=datetime.fromtimestamp(candles[0][0]).strftime(fmt), anchor="w",
                      fill=t["fg"], font=("Segoe UI", 8))
        c.create_text(right, h - 10, text=datetime.fromtimestamp(candles[-1][0]).strftime(fmt), anchor="e",
                      fill=t["fg"], font=("Segoe UI", 8))
        c.create_text(left + 6, top + 2, anchor="nw", fill=t["fg"], font=("Segoe UI", 9, "bold"),
                      text=f"{r['name']}  {tf} candles{note}")

    def update_signal_strip(self):
        """One line that lists what to look at right now, so you never have to click around to find signals."""
        groups = []
        for label in ("SELL", "PROFIT", "BUY"):
            rows = sorted((r for r in self.rows.values() if r["verdict"] == label), key=lambda r: -r["liq"])
            if rows:
                shown = ", ".join(f"{r['name']} {r['values'][1]} ({r['m1']:+.1f}%/1m)" for r in rows[:6])
                groups.append(f"{label} ({len(rows)}): {shown}")
        waiting = sum(1 for r in self.rows.values() if r["verdict"] == "WAIT")
        self.signal_var.set("   |   ".join(groups) if groups else
                            f"No BUY / SELL signals right now. Auto-scanning {len(self.rows)} coins ({waiting} waiting).")

    # ---------------------------------------------------------------- sorting / filtering
    def sort_by(self, col):
        if col == "signal":
            self.sort_col, self.sort_rev = None, False
        elif self.sort_col == col:
            self.sort_rev = not self.sort_rev
        else:
            self.sort_col, self.sort_rev = col, True
        for c, h in zip(self.COLS, self.HEAD):
            mark = (" ▼" if self.sort_rev else " ▲") if c == self.sort_col else ""
            self.tree.heading(c, text=h + mark)
        self.resort(force=True)

    def resort(self, force=False):
        if not force and time.time() - self.last_sort < RESORT_EVERY:
            return
        self.last_sort = time.time()
        q = self.v_search.get().strip().lower()
        hide = self.b["hide"].get()
        rows = [r for r in self.rows.values() if self.tree.exists(r["pair"])]

        def visible(r):
            if hide and r["verdict"] == "AVOID":
                return False
            return not q or q in (r["name"] + " " + self.notes.get(r["pair"], "")).lower()
        if self.sort_col:
            idx = self.COLS.index(self.sort_col)
            rows.sort(key=lambda r: parse_num(r["values"][idx]), reverse=self.sort_rev)
        else:
            rows.sort(key=lambda r: (self.RANK[r["verdict"]], -r["liq"]))
        i = 0
        for r in rows:
            if visible(r):
                self.tree.move(r["pair"], "", i)
                i += 1
            else:
                self.tree.detach(r["pair"])

    # ---------------------------------------------------------------- background threads
    def worker(self):
        while not self.stop.is_set():
            t0 = time.time()
            try:
                self.refresh()
            except Exception as e:
                self.q.put(("status", f"Error: {e} (retrying)"))
                self.stop.wait(3)
                continue
            self.wake.wait(max(0.0, TICK_SECONDS - (time.time() - t0)))
            self.wake.clear()

    def disc_worker(self):
        last = 0.0
        while not self.stop.is_set():
            self.disc_wake.wait(5)
            forced = self.disc_wake.is_set()
            self.disc_wake.clear()
            if self.auto_on and (forced or time.time() - last >= DISCOVER_EVERY):
                try:
                    self.discover()
                except Exception:
                    pass
                last = time.time()

    def fast_worker(self):
        """Fresh prices from Jupiter. Your held coins and the selected coin are always in every request."""
        rot = 0
        delay = 1.1 if self.jup_key else 2.2          # keyless limit is 0.5 requests/second
        while not self.stop.is_set():
            try:
                with self.lock:
                    held = [self.mints[a] for a, s in self.watch.items() if s["entry"] and a in self.mints]
                sel = self.mints.get(self.sel_pair)
                priority = list(dict.fromkeys([SOL_MINT] + held + ([sel] if sel else [])))   # SOL price is used by the sell test
                others = sorted(m for m in set(self.mints.values()) if m not in priority)
                slots = max(1, 50 - len(priority))
                if len(others) > slots:
                    rot %= len(others)
                    window = (others + others)[rot:rot + slots]
                    rot += slots
                else:
                    window = others
                chosen = priority + window
                if chosen:
                    data = jup_prices(chosen, self.jup_key)
                    now = time.time()
                    for m, d in data.items():
                        px = (d or {}).get("usdPrice")
                        if px:
                            self.fast[m] = (float(px), d.get("blockId"), now)
                        if (d or {}).get("decimals") is not None:
                            self.decimals[m] = int(d["decimals"])
                    self.fast_status = f"Jupiter prices OK ({len(data)}/{len(chosen)} coins)"
            except urllib.error.HTTPError as e:
                self.fast_status = ("Jupiter rate-limited: add a free API key in jupiter_key.txt"
                                    if e.code == 429 else f"Jupiter HTTP error {e.code}")
                self.stop.wait(5)
            except Exception as e:
                self.fast_status = f"Jupiter unreachable ({e}); using slower DexScreener prices"
                self.stop.wait(3)
            self.stop.wait(delay)

    # ---------------------------------------------------------------- bot / wallet / trading through Jupiter
    def coin_name(self, pair):
        r = self.rows.get(pair)
        return r["name"] if r else str(pair)[:6]

    def cooldown_left(self, mint):
        return max(0.0, self.cooldown.get(mint, 0) - time.time())

    def start_cooldown(self, mint):
        minutes = self.cfg_cache.get("cooldown_min", 30)
        if mint and minutes > 0:
            self.cooldown[mint] = time.time() + minutes * 60

    def update_bot_label(self):
        live = self.b["live"].get()
        if self.bot_on:
            text, bg = ("BOT RUNNING - LIVE (real money)", "#c62828") if live else ("BOT RUNNING - PAPER (simulated)", "#1565c0")
        else:
            text, bg = "BOT STOPPED", "#757575"
        self.bot_label.configure(text=text, bg=bg, fg="white")
        w = self.wallet
        if w.ready:
            bal = f"{self.sol_balance:.4f} SOL" if self.sol_balance is not None else (self.wallet_note or "reading balance...")
            self.wallet_var.set(f"Wallet {w.address[:4]}...{w.address[-4:]}   {bal}")
        else:
            self.wallet_var.set(f"No wallet: {w.error}")

    def on_live_toggle(self):
        if self.b["live"].get():
            if not self.wallet.ready:
                messagebox.showerror("No wallet", "LIVE trading needs your Phantom key.\n\n" + self.wallet.error)
                self.b["live"].set(False)
                return
            if not messagebox.askyesno(
                    "Switch to LIVE trading",
                    f"LIVE mode makes REAL swaps with the wallet\n{self.wallet.address}\n\n"
                    "Mistakes, bad signals, scams and price drops can lose this money for good.\n"
                    "Only use an account that holds money you can afford to lose.\n\nSwitch to LIVE?"):
                self.b["live"].set(False)
                return
        self.bot_on = False
        self.log_line("Mode changed to " + ("LIVE (real money)" if self.b["live"].get() else "PAPER (simulated)")
                      + ". The bot is stopped: press Start bot when you are ready.")

    def start_bot(self):
        cfg = self.cfg()
        if cfg["live"]:
            if not self.wallet.ready:
                messagebox.showerror("No wallet", self.wallet.error)
                return
            if not messagebox.askyesno(
                    "Start the LIVE bot",
                    f"The bot will trade with REAL money from {self.wallet.address[:6]}...:\n\n"
                    f"  buy size: {cfg['buy_sol']} SOL per coin\n  max open coins: {cfg['max_pos']}\n"
                    f"  keeps {cfg['reserve']} SOL for fees\n  sells only in profit (min {cfg['min_profit']:.0f}%)\n\n"
                    "A coin that falls and never recovers is held, it can go to zero.\n\nStart?"):
                return
        self.bot_on = True
        self.log_line("Bot STARTED in " + ("LIVE" if cfg["live"] else "PAPER") + " mode"
                      f" (auto-buy {'on' if cfg['auto_buy'] else 'off'}, auto-sell {'on' if cfg['auto_sell'] else 'off'})")

    def stop_bot(self):
        self.bot_on = False
        self.log_line("Bot STOPPED: no automatic buying or selling. Your coins stay where they are; "
                      "you can still trade by hand.")

    def manual_buy(self):
        pair = self.selected()
        if not pair or pair not in self.rows:
            self.v_status.set("Select a coin first, then press 'Buy now'.")
            return
        cfg = self.cfg()
        if cfg["live"] and not self.wallet.ready:
            messagebox.showerror("No wallet", self.wallet.error)
            return
        with self.lock:
            st = self.watch.get(pair)
        if st and st["entry"]:
            messagebox.showinfo("Already holding", "You already hold this coin. Sell it first or use 'Clear position'.")
            return
        r, mint = self.rows[pair], self.mints.get(pair)
        cool = self.cooldown_left(mint)
        extra = f"\n\nIt is in cooldown ({fmt_cool(cool)} left). The bot would not buy it now, but you can." if cool > 0 else ""
        mode = "LIVE: REAL money" if cfg["live"] else "PAPER (simulated)"
        if not messagebox.askyesno("Confirm buy", f"{mode}\n\nBuy {cfg['buy_sol']} SOL of {r['name']} "
                                                  f"at about {fmt_price(r['price'])}?{extra}"):
            return
        with self.lock:
            if pair in self.inflight:
                return
            self.inflight[pair] = "buy"
        self.cfg_cache = cfg
        self.trade_q.put(("buy", pair, cfg["buy_sol"], "manual"))

    def manual_sell(self):
        pair = self.selected()
        if not pair or pair not in self.rows:
            self.v_status.set("Select a coin first, then press 'Sell all now'.")
            return
        cfg = self.cfg()
        with self.lock:
            st = self.watch.get(pair)
        if cfg["live"] and not self.wallet.ready and not (st and st.get("paper")):
            messagebox.showerror("No wallet", self.wallet.error)
            return
        r = self.rows[pair]
        text = f"Sell ALL of {r['name']} at the current market price?"
        if st and st["entry"]:
            pnl = r["price"] / st["entry"] - 1
            text += f"\n\nYou are at {pnl:+.1%} versus your entry."
            if pnl < 0:
                text += "\n\nWARNING: this is BELOW YOUR COST. Selling now LOCKS IN A LOSS."
        else:
            text += "\n\nNo tracked position: the whole wallet balance of this token will be sold."
        text += "\n\nMode: " + ("LIVE (real money)" if cfg["live"] else "PAPER (simulated)")
        if not messagebox.askyesno("Confirm sell", text):
            return
        with self.lock:
            if pair in self.inflight:
                return
            self.inflight[pair] = "sell"
        self.cfg_cache = cfg
        self.trade_q.put(("sell", pair, "manual"))

    def maybe_auto_buy(self, pair, mint, st, verdict, px_src, cfg, now):
        """Called every tick for every coin that is not held. Queues a buy only if every rule allows it."""
        if not (self.bot_on and cfg["auto_buy"]) or verdict != "BUY" or st["entry"]:
            return
        if not px_src.startswith("JUP") or not mint:           # trade only on a fresh Jupiter price
            return
        if self.cooldown_left(mint) > 0 or now < st["last_buy_try"]:
            return
        with self.lock:
            held = sum(1 for s in self.watch.values() if s["entry"] and s["bot"])
            busy = sum(1 for k in self.inflight.values() if k == "buy")
            same = any(self.mints.get(p2) == mint and (s2["entry"] or self.inflight.get(p2) == "buy")
                       for p2, s2 in self.watch.items())
            if pair in self.inflight or same or held + busy >= cfg["max_pos"]:
                return
            self.inflight[pair] = "buy"
        st["last_buy_try"] = now + 30
        self.trade_q.put(("buy", pair, cfg["buy_sol"], "auto"))

    def maybe_auto_sell(self, pair, st, mode, now):
        """mode: 'lock' (profit lock reached) or 'emergency' (rug warning with the emergency exit ticked)."""
        if not self.bot_on or not st["entry"] or not st["bot"] or now - st["last_sell_try"] < 10:
            return
        with self.lock:
            if pair in self.inflight:
                return
            self.inflight[pair] = "sell"
        st["last_sell_try"] = now
        self.trade_q.put(("sell", pair, "auto" if mode == "lock" else "emergency"))

    def wallet_worker(self):
        while not self.stop.is_set():
            if self.wallet.ready:
                try:
                    self.sol_balance = rpc_sol_balance(self.rpc_url, self.wallet.address) / 1e9
                    self.wallet_note = ""
                except Exception as e:
                    self.wallet_note = f"balance unavailable ({str(e)[:60]}); put a free RPC in rpc_url.txt"
            self.stop.wait(30)

    def trade_worker(self):
        """Runs one trade at a time, so two trades can never spend the same SOL."""
        while not self.stop.is_set():
            try:
                task = self.trade_q.get(timeout=1)
            except queue.Empty:
                continue
            kind, pair = task[0], task[1]
            try:
                if kind == "buy":
                    self.do_buy(pair, task[2], task[3])
                else:
                    self.do_sell(pair, task[2])
            except urllib.error.HTTPError as e:
                self.q.put(("log", f"TRADE ERROR ({kind} {self.coin_name(pair)}): Jupiter HTTP {e.code} "
                                   f"{http_error_text(e)[:150]}"))
            except Exception as e:
                self.q.put(("log", f"TRADE ERROR ({kind} {self.coin_name(pair)}): {e}"))
            finally:
                with self.lock:
                    self.inflight.pop(pair, None)
                self.q.put(("save", None))

    def do_buy(self, pair, sol, source):
        cfg = self.cfg_cache
        mint, name = self.mints.get(pair), self.coin_name(pair)
        with self.lock:
            st = self.watch.get(pair)
        if not st or not mint:
            return False
        opened = False
        try:
            opened = self._buy(st, pair, mint, name, sol, source, cfg)
        finally:
            if not opened:
                st["last_buy_try"] = time.time() + 120          # wait before trying this coin again
        return opened

    def _buy(self, st, pair, mint, name, sol, source, cfg):
        say = lambda text: self.q.put(("log", text))
        live = cfg["live"]
        tag = "LIVE" if live else "PAPER"
        if st["entry"]:
            say(f"{tag} BUY skipped: you already hold {name}")
            return False
        if not (0 < sol <= MAX_BUY_SOL):
            say(f"{tag} BUY refused ({name}): buy size {sol} SOL is not between 0 and {MAX_BUY_SOL} SOL")
            return False
        lam = int(round(sol * 1e9))
        if live:
            if not self.wallet.ready:
                say(f"LIVE BUY skipped ({name}): no wallet ({self.wallet.error})")
                return False
            bal = rpc_sol_balance(self.rpc_url, self.wallet.address)
            need = lam + int(cfg["reserve"] * 1e9)
            if bal < need:
                say(f"LIVE BUY skipped ({name}): wallet has {bal / 1e9:.4f} SOL but needs {need / 1e9:.4f} "
                    f"({sol} to buy + {cfg['reserve']} kept for fees)")
                return False
        test = self.run_sell_test(mint, dict(cfg, sell_test=True))     # honeypot check right before buying
        if test["status"] != "pass":
            say(f"{tag} BUY cancelled ({name}): sell test {test['status']}: {test['why']}")
            return False
        sig = ""
        if live:
            order = jup_order(SOL_MINT, mint, lam, self.wallet.address, self.jup_key)
            if not order.get("transaction"):
                say(f"LIVE BUY failed ({name}): Jupiter returned no transaction: "
                    f"{order.get('errorMessage') or order.get('error') or 'unknown reason'}")
                return False
            res = jup_execute(sign_transaction(self.wallet.kp, order["transaction"]), order["requestId"], self.jup_key)
            if str(res.get("status", "")).lower() != "success":
                say(f"LIVE BUY failed ({name}): {res.get('error') or res.get('status')} (code {res.get('code')})")
                return False
            tokens = to_int(res.get("outputAmountResult") or res.get("totalOutputAmount") or order.get("outAmount"))
            sig = str(res.get("signature", ""))
            if tokens <= 0:
                try:
                    tokens = rpc_token_balance(self.rpc_url, self.wallet.address, mint)
                except Exception:
                    tokens = 0
        else:
            order = jup_order(SOL_MINT, mint, lam, "", self.jup_key)           # quote only, nothing is sent
            tokens = to_int(order.get("outAmount"))
        if tokens <= 0:
            say(f"{tag} BUY unclear ({name}): could not read how many tokens were received. Check your wallet.")
            return False
        dec = self.decimals.get(mint)
        sol_usd = (self.fast.get(SOL_MINT) or (0.0,))[0]
        if dec is not None and sol_usd > 0:
            entry = (lam / 1e9 * sol_usd) / (tokens / 10 ** dec)          # what we really paid per token
        else:
            entry = (self.rows.get(pair) or {}).get("price", 0.0)
        with self.lock:
            self.clear_pos(st)
            st.update(entry=entry, peak=entry, entry_time=time.time(), sol_in=lam, tokens=tokens, bot=True,
                      paper=not live, auto=False)
        shown = f"{tokens / 10 ** dec:,.0f}" if dec is not None else str(tokens)
        self.q.put(("alert", (700, f"{tag} BUY ({source}) {name}: spent {sol} SOL for {shown} tokens at "
                                   f"{fmt_price(entry)}" + (f"  tx {sig[:10]}..." if sig else ""))))
        return True

    def do_sell(self, pair, source):
        cfg = self.cfg_cache
        mint, name = self.mints.get(pair), self.coin_name(pair)
        with self.lock:
            st = self.watch.get(pair)
        if not st or not mint:
            return False
        say = lambda text: self.q.put(("log", text))
        live = cfg["live"]
        paper_pos = bool(st["paper"])
        if st["bot"] and not paper_pos and not live:
            say(f"SELL skipped ({name}): this is a REAL position. Tick LIVE trading to sell it.")
            return False
        do_live = live and not paper_pos
        tag = "LIVE" if do_live else "PAPER"
        tokens = to_int(st["tokens"])
        if do_live:
            if not self.wallet.ready:
                say(f"SELL skipped ({name}): no wallet ({self.wallet.error})")
                return False
            try:
                bal = rpc_token_balance(self.rpc_url, self.wallet.address, mint)
            except Exception as e:
                bal = None
                say(f"({name}: could not read the wallet balance ({str(e)[:60]}), using the recorded amount)")
            if bal is not None:
                if bal <= 0:
                    say(f"SELL skipped ({name}): the wallet holds none of this token" +
                        (" (position cleared)" if st["entry"] else ""))
                    if st["entry"]:
                        with self.lock:
                            self.clear_pos(st)
                    return False
                tokens = bal
        if tokens <= 0:
            say(f"SELL skipped ({name}): nothing to sell")
            return False
        order = jup_order(mint, SOL_MINT, tokens, self.wallet.address if do_live else "", self.jup_key)
        out = to_int(order.get("outAmount"))
        if out <= 0:
            say(f"{tag} SELL failed ({name}): Jupiter found no route to sell "
                f"({order.get('errorMessage') or order.get('error') or 'quote is zero'})")
            return False
        sol_in = to_int(st["sol_in"])
        now = time.time()
        if source == "auto" and sol_in > 0:                       # the never-sell-at-a-loss guard, on the real quote
            need = sol_in * (1 + cfg["min_profit"] / 100.0)
            if out < need:
                if now - st["guard_log"] > 60:
                    st["guard_log"] = now
                    say(f"SELL waiting ({name}): selling now would return {out / 1e9:.4f} SOL, below your cost "
                        f"{sol_in / 1e9:.4f} SOL + {cfg['min_profit']:.0f}%. Not selling at a loss.")
                return False
        sig = ""
        if do_live:
            if not order.get("transaction"):
                say(f"LIVE SELL failed ({name}): Jupiter returned no transaction: "
                    f"{order.get('errorMessage') or order.get('error') or 'unknown reason'}")
                return False
            res = jup_execute(sign_transaction(self.wallet.kp, order["transaction"]), order["requestId"], self.jup_key)
            if str(res.get("status", "")).lower() != "success":
                say(f"LIVE SELL failed ({name}): {res.get('error') or res.get('status')} (code {res.get('code')})")
                return False
            out = to_int(res.get("outputAmountResult") or res.get("totalOutputAmount")) or out
            sig = str(res.get("signature", ""))
        dec = self.decimals.get(mint)
        sol_usd = (self.fast.get(SOL_MINT) or (0.0,))[0]
        if dec is not None and sol_usd > 0:
            exit_px = (out / 1e9 * sol_usd) / (tokens / 10 ** dec)
        else:
            exit_px = (self.rows.get(pair) or {}).get("price", 0.0)
        pnl = (out / sol_in - 1) * 100 if sol_in > 0 else (exit_px / st["entry"] - 1) * 100 if st["entry"] else None
        held = (time.time() - st["entry_time"]) / 60 if st["entry_time"] else 0
        append_trade({"closed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "coin": name, "pair": pair,
                      "entry": st["entry"] or "", "exit": exit_px,
                      "pnl_pct": f"{pnl:.2f}" if pnl is not None else "", "held_minutes": f"{held:.0f}",
                      "mode": tag, "sol_in": f"{sol_in / 1e9:.6f}" if sol_in else "", "sol_out": f"{out / 1e9:.6f}",
                      "tx": sig})
        with self.lock:
            self.clear_pos(st)
        self.start_cooldown(mint)
        pnl_txt = f" ({pnl:+.1f}%)" if pnl is not None else ""
        cool_txt = f", cooldown {cfg['cooldown_min']:.0f} min" if cfg["cooldown_min"] > 0 else ""
        self.q.put(("alert", (1000, f"{tag} SELL ({source}) {name}: got {out / 1e9:.4f} SOL"
                                    + (f" for {sol_in / 1e9:.4f} SOL" if sol_in else "") + f"{pnl_txt}{cool_txt}"
                                    + (f"  tx {sig[:10]}..." if sig else ""))))
        return True

    def run_sell_test(self, mint, cfg):
        """Ask Jupiter for a quote to sell a small amount. Returns {"status": pass/fail/unknown, "why", "impact"}."""
        def res(status, why, impact=None):
            return {"status": status, "why": why, "impact": impact}
        price = 0.0
        for pair, m in list(self.mints.items()):
            if m == mint and pair in self.rows:
                price = self.rows[pair]["price"]
                break
        dec = self.decimals.get(mint)
        if dec is None:
            cached = self.safety.get(mint)
            if cached and cached[1] and cached[1].get("decimals") is not None:
                dec = int(cached[1]["decimals"])
        if price <= 0 or dec is None:
            return res("unknown", "token price or decimals not known yet")
        usd = cfg["sell_usd"]
        raw = int(usd / price * 10 ** dec)
        if raw <= 0:
            return res("unknown", "test amount too small")
        try:
            q = jup_sell_quote(mint, raw, self.jup_key)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "ignore")[:300].lower()
            except Exception:
                pass
            if e.code in (401, 403):
                return res("unknown", "Jupiter needs a free API key: put it in jupiter_key.txt")
            if e.code == 429:
                return res("unknown", "Jupiter rate limit, retrying shortly")
            if e.code == 400 and any(w in body for w in ("route", "liquidity", "tradable", "tradeable")):
                return res("fail", "Jupiter found no way to sell this token")
            return res("unknown", f"Jupiter error {e.code}")
        except Exception as e:
            return res("unknown", f"could not reach Jupiter ({e})")
        if q["out"] <= 0:
            return res("fail", q["error"] or "no sell route found (quote is zero)")
        sol = self.fast.get(SOL_MINT)
        if sol and sol[0] > 0:                       # does the quote match what the coin is supposed to be worth?
            got = q["out"] / 1e9 * sol[0]
            if (1 - got / usd) * 100 > cfg["sell_impact"] + 3:
                return res("fail", f"selling ${usd:.0f} would only return about ${got:.2f}", q["impact"])
        if q["impact"] > cfg["sell_impact"]:
            return res("fail", f"price impact {q['impact']:.1f}% on a ${usd:.0f} sell (max {cfg['sell_impact']:.0f}%)",
                       q["impact"])
        return res("pass", "ok", q["impact"])

    def sell_test_worker(self):
        """Runs the sell test only for coins that already pass every other check (so BUY is the only thing left)."""
        while not self.stop.is_set():
            cfg = self.cfg_cache
            if cfg.get("sell_test"):
                with self.lock:
                    wanted = [self.mints[a] for a, s in self.watch.items() if s.get("want_sell_test") and a in self.mints]
                now = time.time()
                done = 0
                for mint in dict.fromkeys(wanted):
                    c = self.sell_cache.get(mint)
                    ttl = 60 if c and c[1]["status"] == "unknown" else 300
                    if c and now - c[0] < ttl:
                        continue
                    self.sell_cache[mint] = (time.time(), self.run_sell_test(mint, cfg))
                    self.force_eval = True           # show the result right away
                    done += 1
                    self.stop.wait(1.2)              # be gentle with Jupiter's rate limit
                    if done >= 3:
                        break
            self.stop.wait(2)

    def safety_worker(self):
        while not self.stop.is_set():
            now = time.time()
            with self.lock:
                held = {self.mints[a] for a, s in self.watch.items() if s["entry"] and a in self.mints}
            todo = []
            for m in set(list(self.mints.values())):
                c = self.safety.get(m)
                ttl = 120 if m in held else SAFETY_TTL
                if c is None or now - c[0] > (ttl if c[1] else 60):
                    todo.append((c is not None, m))
            for _seen, m in sorted(todo)[:SAFETY_PER_CYCLE]:
                old = self.safety.get(m)
                new = rugcheck(m)
                if new and old and old[1]:
                    new["top10_drop"] = old[1]["top10"] - new["top10"]     # how far the top wallets sold down
                self.safety[m] = (time.time(), new)
                self.stop.wait(0.4)
            self.stop.wait(2)

    def discover(self):
        """Pull candidate pools from GeckoTerminal (new / trending / top volume, rotating pages)
        plus DexScreener's own lists, check them on DexScreener, and add the ones passing the filters."""
        cfg = self.cfg_cache
        mode = cfg["mode"]
        self.disc_round += 1
        r = self.disc_round
        plan = []
        if mode in ("Mix", "Newest"):
            plan += [f"/networks/solana/new_pools?page={pg}" for pg in (1, 2, 3)]
        if mode in ("Mix", "Trending"):
            plan += [f"/networks/solana/trending_pools?page={pg}&duration=1h" for pg in (1, 2)]
            plan.append("/networks/solana/trending_pools?page=1&duration=24h")
        if mode in ("Mix", "Top volume"):
            for pg in ((r * 2) % 10 + 1, (r * 2 + 1) % 10 + 1):      # rotates through pages 1-10
                plan.append(f"/networks/solana/pools?page={pg}&sort=h24_volume_usd_desc")

        candidates, gecko_ok = [], 0
        for path in plan:
            try:
                for d in gecko(path).get("data", []):
                    a = (d.get("attributes") or {}).get("address")
                    if a and a not in candidates:
                        candidates.append(a)
                gecko_ok += 1
            except Exception:
                pass
            self.stop.wait(1.5)                                       # stay under GeckoTerminal's rate limit

        pairs = []
        with self.lock:
            known = set(self.watch)
        fresh = [a for a in candidates if a not in known and a not in self.ignored]
        for batch in chunks(fresh[:150], 30):
            try:
                pairs += http_json(f"/latest/dex/pairs/{CHAIN}/{','.join(batch)}").get("pairs") or []
            except Exception:
                continue

        if mode == "Mix":                                             # DexScreener's own short lists as extra sources
            tokens = []
            for path in ("/token-profiles/latest/v1", "/token-boosts/latest/v1", "/token-boosts/top/v1"):
                try:
                    for item in http_json(path):
                        if item.get("chainId") == CHAIN and item.get("tokenAddress") not in tokens:
                            tokens.append(item["tokenAddress"])
                except Exception:
                    continue
            for batch in chunks(tokens[:90], 30):
                try:
                    res = http_json(f"/tokens/v1/{CHAIN}/{','.join(batch)}")
                    pairs += res if isinstance(res, list) else []
                except Exception:
                    continue

        seen, good = set(), []
        for p in pairs:
            pa = p.get("pairAddress")
            if not pa or pa in seen or p.get("chainId") != CHAIN or pa in known or pa in self.ignored:
                continue
            seen.add(pa)
            if float((p.get("liquidity") or {}).get("usd") or 0) >= cfg["liq"]:
                good.append(p)
        good.sort(key=lambda p: float((p.get("volume") or {}).get("m5") or 0), reverse=True)

        added = 0
        with self.lock:
            auto_count = sum(1 for s in self.watch.values() if s["auto"])
            for p in good:
                if auto_count >= MAX_AUTO_COINS or added >= MAX_NEW_PER_SCAN:
                    break
                self.watch[p["pairAddress"]] = new_state(True)
                auto_count += 1
                added += 1
        self.last_scan_txt = f"{datetime.now():%H:%M:%S} (+{added})"
        note = "" if gecko_ok else "  (GeckoTerminal unreachable, using DexScreener lists only)"
        self.q.put(("log", f"Scan [{mode}]: {len(candidates)} pools found, {len(seen)} new, "
                           f"{len(good)} passed liquidity ${cfg['liq']:,.0f}, added {added}{note}"))

    def refresh(self):
        with self.lock:
            addrs = list(self.watch)
        if not addrs:
            self.q.put(("status", "No coins yet. Add one above."))
            return
        cfg = self.cfg_cache
        now = time.time()
        forced, self.force_eval = self.force_eval, False
        out, drop = [], []
        for batch in chunks(addrs, 30):
            data = http_json(f"/latest/dex/pairs/{CHAIN}/{','.join(batch)}")
            for p in data.get("pairs") or []:
                pair = p.get("pairAddress")
                with self.lock:
                    st = self.watch.get(pair)
                if not st:
                    continue
                price = float(p.get("priceUsd") or 0)
                mint = (p.get("baseToken") or {}).get("address")
                if mint:
                    self.mints[pair] = mint
                px_src = "DEX (slow)"
                fp = self.fast.get(mint)
                if fp and now - fp[2] <= FAST_MAX_AGE:
                    price, px_src = fp[0], f"JUP {now - fp[2]:.0f}s"
                    p["priceUsd"] = str(price)

                # tick tracking: direction and 1 minute change from our own samples
                if price > 0:
                    if st["ticks"] and price != st["ticks"][-1][1]:
                        st["dir"] = "▲" if price > st["ticks"][-1][1] else "▼"
                    st["ticks"].append((now, price))
                ref = next((pr for t, pr in st["ticks"] if now - t <= 60), None)
                m1 = (price / ref - 1) * 100 if ref and price > 0 else 0.0
                liq = float((p.get("liquidity") or {}).get("usd") or 0)
                st["liq_hist"].append((now, liq))
                m5 = (p.get("txns") or {}).get("m5", {})
                buys, sells = m5.get("buys", 0), m5.get("sells", 0)
                cached = self.safety.get(mint)
                sf = cached[1] if cached else None

                # slower BUY/WAIT/AVOID scoring
                sc = self.sell_cache.get(mint)
                sell = sc[1] if sc and now - sc[0] < 600 else None
                alert = False
                due = now - st["last_eval"] >= EVAL_EVERY
                if due or forced:
                    if due:
                        st["last_eval"] = now
                    st["verdict"], st["reasons"] = evaluate(p, st, cfg, sf, preview=not due, sell=sell)
                    if due:
                        st["avoid_count"] = st["avoid_count"] + 1 if st["verdict"] == "AVOID" else 0
                    if st["verdict"] == "BUY" and not st["alerted"]:
                        st["alerted"], alert = True, True
                    elif st["verdict"] != "BUY":
                        st["alerted"] = False
                stale = now - st["added"] > ROTATE_SECONDS and st["verdict"] != "BUY"
                if st["auto"] and not st["entry"] and (st["avoid_count"] >= 6 or stale):
                    drop.append(pair)
                    continue

                # sell-pressure / rug warnings, checked every tick
                warns, liq_drop = [], 0.0
                recent = [l for t, l in st["liq_hist"] if now - t <= 120]
                if recent and max(recent) > 0:
                    liq_drop = 1 - liq / max(recent)
                    if liq_drop >= 0.25:
                        warns.append(f"liquidity fell {liq_drop:.0%} in 2 min (possible LP removal / rug)")
                ratio = buys / max(sells, 1)
                if sells >= 15 and ratio < 0.67 and m1 <= -3:
                    warns.append(f"heavy selling (5m B/S {ratio:.2f}) while price falls {m1:.1f}%/min")
                if sf and sf.get("top10_drop", 0) >= 8:
                    warns.append(f"top-10 wallets sold down {sf['top10_drop']:.0f} points since last check")

                verdict, reasons, pnl_txt = st["verdict"], list(st["reasons"]), "-"
                sell_alert, tp_alert, warn_alert = False, None, None
                lock_px = tp1_px = tp2_px = None
                lock_txt = "-"
                cool = self.cooldown_left(mint)
                if st["entry"] and price > 0:
                    entry = st["entry"]
                    st["peak"] = max(st["peak"], price, entry)
                    pnl = price / entry - 1
                    pnl_txt = f"{pnl:+.1%}"
                    peak_gain = (st["peak"] / entry - 1) * 100
                    tp1_px, tp2_px = entry * (1 + cfg["tp1"] / 100), entry * (1 + cfg["tp2"] / 100)
                    lg = lock_gain(peak_gain, cfg["tiers"], cfg["min_profit"])
                    if lg is not None:
                        lock_px = entry * (1 + lg / 100)
                        lock_txt = f"+{lg:.1f}%"
                    else:
                        lock_txt = f"arms at +{cfg['tiers'][0][0]:g}%"
                    sell_reasons, sell_mode = [], None
                    if lock_px and price <= lock_px:
                        sell_reasons.append(f"profit lock hit: price fell back to the locked +{lg:.1f}% "
                                            f"(your best was +{peak_gain:.0f}%)")
                        sell_mode = "lock"
                    if cfg["emergency"] and warns:
                        sell_reasons += warns
                        sell_mode = sell_mode or "emergency"
                    if sell_reasons:
                        verdict, reasons = "SELL", sell_reasons
                        if not st["sell_alerted"]:
                            st["sell_alerted"], sell_alert = True, True
                    else:
                        st["sell_alerted"] = False
                        hit = [lv for lv in (cfg["tp1"], cfg["tp2"]) if pnl * 100 >= lv]
                        head = f"you're {pnl:+.1%} vs entry; best so far {peak_gain:+.0f}%; profit lock {lock_txt}"
                        if pnl < 0:
                            head += "  |  below cost: never sold at a loss, waiting for profit"
                        if hit:
                            verdict = "PROFIT"
                            reasons = [f"up {pnl:+.0%}: take-profit level +{max(hit):.0f}% reached; "
                                       f"the profit lock protects the gain", head] + reasons
                            new_levels = [lv for lv in hit if lv not in st["tp_alerted"]]
                            if new_levels:
                                st["tp_alerted"].update(new_levels)
                                tp_alert = f"TAKE PROFIT {{name}} is up {pnl:+.0%} (level +{max(new_levels):.0f}%)"
                        else:
                            verdict = "HOLD"
                            reasons = [head] + reasons
                        if warns:                                  # warning only: the bot does not sell at a loss
                            reasons = ["WARNING: " + w for w in warns] + reasons
                            if not st["warn_alerted"]:
                                st["warn_alerted"] = True
                                warn_alert = "WARNING {name}: " + "; ".join(warns).replace("{", "(").replace("}", ")")
                        else:
                            st["warn_alerted"] = False
                    if sell_mode and cfg["auto_sell"] and px_src.startswith("JUP"):
                        self.maybe_auto_sell(pair, st, sell_mode, now)
                else:
                    if liq_drop >= 0.30:
                        verdict, reasons = "AVOID", warns + reasons
                    elif warns:
                        if verdict == "BUY":
                            verdict, alert = "WAIT", False
                        reasons = warns + reasons
                    if cool > 0 and verdict == "BUY":
                        reasons = [f"COOLDOWN: sold recently, the bot will not buy it again for {fmt_cool(cool)}"] + reasons
                    self.maybe_auto_buy(pair, mint, st, verdict, px_src, cfg, now)

                name = (p.get("baseToken") or {}).get("symbol", "?")
                ch = p.get("priceChange") or {}
                values = (name, fmt_price(price), st["dir"] or "•", f"{m1:+.2f}",
                          fmt_usd(liq), fmt_usd(p.get("marketCap") or p.get("fdv")),
                          (f"{sf['holders']:,}" if sf and sf["holders"] is not None else "?"),
                          (f"{sf['top10']:.0f}" if sf else "?"),
                          f"{float(ch.get('m5') or 0):+.1f}", f"{float(ch.get('h1') or 0):+.1f}",
                          f"{ratio:.2f}", fmt_usd((p.get("volume") or {}).get("m5")),
                          fmt_age(p.get("pairCreatedAt")), social_str(p),
                          (f"OK {sell['impact']:.1f}%" if sell and sell["status"] == "pass"
                           else "FAIL" if sell and sell["status"] == "fail" else "?" if sell else "-"),
                          "bot" if st["bot"] else "auto" if st["auto"] else "mine", pnl_txt, lock_txt,
                          fmt_cool(cool) if cool > 0 else "-", px_src,
                          self.notes.get(pair, ""), verdict)
                out.append({"pair": pair, "name": name, "values": values, "verdict": verdict,
                            "reasons": reasons, "alert": alert, "sell_alert": sell_alert,
                            "tp_alert": tp_alert.format(name=name) if tp_alert else None,
                            "warn_alert": warn_alert.format(name=name) if warn_alert else None,
                            "liq": liq, "price": price, "dir": st["dir"], "m1": m1, "px": px_src,
                            "ticks": list(st["ticks"])[-360:],
                            "entry": st["entry"], "lock_px": lock_px, "tp1_px": tp1_px, "tp2_px": tp2_px})
        with self.lock:
            for pair in drop:
                self.watch.pop(pair, None)
                self.ignored.add(pair)
        self.q.put(("rows", (out, drop)))
        self.q.put(("status", f"Live: updated {datetime.now():%H:%M:%S}  |  watching {len(addrs)} coins  |  "
                              f"{self.fast_status}  |  bot {'RUNNING' if self.bot_on else 'stopped'}  |  "
                              f"auto-scan {'ON' if self.auto_on else 'OFF'}, last {self.last_scan_txt}"))

    # ---------------------------------------------------------------- UI updates from the workers
    def drain(self):
        self.cfg_cache = self.cfg()
        self.auto_on = self.b["auto"].get()
        self.update_bot_label()
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "status":
                    self.v_status.set(payload)
                elif kind == "log":
                    self.log_line(payload)
                elif kind == "rows":
                    self.apply_rows(*payload)
                elif kind == "backtest":
                    self.v_status.set("Backtest finished.")
                    self.show_backtest(payload)
                elif kind == "alert":
                    self.alert(*payload)
                elif kind == "save":
                    self.save_watchlist()
        except queue.Empty:
            pass
        self.root.after(400, self.drain)

    def apply_rows(self, out, dropped):
        for pair in dropped:
            self.rows.pop(pair, None)
            if self.tree.exists(pair):
                self.tree.delete(pair)
        for r in out:
            pair = r["pair"]
            self.rows[pair] = r
            if self.tree.exists(pair):
                self.tree.item(pair, values=r["values"], tags=(r["verdict"],))
            else:
                self.tree.insert("", "end", iid=pair, values=r["values"], tags=(r["verdict"],))
            if r["alert"]:
                self.alert(700, f"*** BUY SIGNAL *** {r['name']}  {r['values'][1]}  liq {r['values'][4]}  "
                                f"holders {r['values'][6]}")
            if r["sell_alert"]:
                self.alert(1600, f"!!! SELL SIGNAL !!! {r['name']}  {r['values'][1]}  " + "; ".join(r["reasons"]))
            if r["tp_alert"]:
                self.alert(1000, f"$$$ {r['tp_alert']}  {r['values'][1]}")
            if r["warn_alert"]:
                self.alert(1300, f"!! {r['warn_alert']}")
        self.resort()
        self.update_signal_strip()
        self.show_reasons()
        self.update_big()
        self.draw_chart()

    def on_close(self):
        self.stop.set()
        self.wake.set()
        self.save_watchlist()
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()