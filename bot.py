#!/usr/bin/env python3
"""
Solana Multi-Source Sniper & Live Trading Engine.
Features:
- Dual Mode: Paper Trading (Simulation) & Live Trading (Phantom Wallet via Browser Bridge).
- Browser Bridge: Zero private-key risk. Uses window.solana in your browser for secure signing.
- Jupiter Routing: Full v6 / v1 Swap API quote + swap routing with priority fee support.
- Rug Defense: On-chain mint/freeze authority verification + Jupiter audit + RugCheck score.
- Rugpull Liquidity Fix: Handles Jupiter 'NO_ROUTES_FOUND' gracefully and writes off dead pools.
- Trailing Profit Lock: Lets runners continue pumping past target profit instead of cutting early.
- Candidate Sources: GeckoTerminal, Jupiter Recent, DexScreener Profiles, Boosts.
  (Pump.fun launches currently commented out per safety setting).
"""

import base64
import csv
import io
import json
import math
import os
import re
import shutil
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Optional requests library with urllib fallback
try:
    import requests
    _HAS_REQUESTS = True
    _session = requests.Session()
except ImportError:
    _HAS_REQUESTS = False
    _session = None

if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass

# ==============================================================================
# CONFIGURATION & DEFAULTS
# ==============================================================================

CONFIG = {
    # Execution Mode: 'paper' (simulated) or 'live' (real Phantom wallet via browser bridge)
    "execution_mode": "paper",
    "sizing_basis": "sol",           # 'sol' or 'usd'
    "start_balance_sol": 0.3448,     # SOL start balance
    "start_balance_usd": 50.0,       # USD equivalent (side-by-side)
    "trade_size_sol": 0.020,         # SOL amount per trade (fits smaller wallets e.g. 0.027 SOL)
    "trade_size_usd": 5.0,           # USD equivalent per trade (side-by-side)
    "max_open_positions": 3,
    "daily_loss_limit_sol": 0.069,    # Daily loss limit in SOL
    "daily_loss_limit_usd": 10.0,    # Daily loss limit in USD
    "min_gas_reserve_sol": 0.002,    # Gas reserve kept in wallet for fees (0.002 SOL is plenty)

    # Profit & Stop-loss controls
    "take_profit_pct": 50.0,         # Target profit %
    "trailing_stop_pct": 10.0,       # Trailing stop % from peak (0 = off)
    "trailing_profit_mode": True,    # Once take_profit is reached, trail peak instead of instant dump
    "stop_loss_pct": 35.0,           # Hard stop loss % (protects against sudden down-draws)
    "rug_exit_drop_pct": 75.0,       # Emergency dump if price drops >75% from peak
    "max_hold_minutes": 120,

    # Sniper Entry Window
    "max_age_minutes": 2.0,          # Buy only coins younger than this
    "ultra_early_grace_sec": 10,     # Coins younger than this skip liquidity/volume floors

    # Scan & Monitor Speeds
    "scan_interval_sec": 1,
    "monitor_interval_sec": 1.0,

    # Entry Guards (applied after ultra_early_grace_sec)
    "min_liquidity_usd": 300.0,
    "min_volume_m5_usd": 0.0,
    "min_buys_m5": 2,
    "min_buy_sell_ratio_m5": 1.0,
    "max_price_change_m5_pct": 300.0,
    "min_holders": 0,

    # Hard Rug Screen
    "use_rugcheck": True,
    "strict_rugcheck": True,
    "rugcheck_max_score": 50.0,
    "max_top10_holder_pct": 75.0,
    "rug_recheck_minutes": 15,

    # Candidate Sources
    "use_gecko": True,
    "use_jupiter_recent": True,
    "use_dex_profiles": True,
    "use_pumpportal": False,         # COMMENTED/DISABLED: bot will not buy pump.fun coins
    "use_promoted_feeds": False,

    # Execution Parameters
    "slippage_pct": 2.5,             # Slippage tolerance in percent
    "fee_pct": 1.0,                  # Simulated fee in paper mode
    "priority_fee_lamports": 150000, # 0.00015 SOL for fast priority execution on Solana
    "rpc_url": "https://api.mainnet-beta.solana.com",
    "backup_rpc_url": "https://solana-rpc.publicnode.com",
    "bridge_port": 8765,

    # State & Logging
    "state_file": "sniper_state.json",
    "trades_csv": "trades.csv",
    "log_rejects": True,
    "jupiter_api_key": "",
    "use_jupiter_price": True,
}

# External Endpoints
SOL_MINT = "So11111111111111111111111111111111111111112"
DEX = "https://api.dexscreener.com"
GECKO = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools"
JUP_TOKENS = "https://api.jup.ag/tokens/v2"
JUP_PRICE = "https://api.jup.ag/price/v3"
JUP_QUOTE_URLS = [
    "https://quote-api.jup.ag/v6/quote",
    "https://lite-api.jup.ag/swap/v1/quote",
    "https://api.jup.ag/swap/v1/quote",
]
JUP_SWAP_URLS = [
    "https://quote-api.jup.ag/v6/swap",
    "https://lite-api.jup.ag/swap/v1/swap",
    "https://api.jup.ag/swap/v1/swap",
]
RUGC = "https://api.rugcheck.xyz/v1/tokens"
PUMPP = "https://api.pumpportal.fun/api/data"

RPC_URLS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
]

HEADERS = {"User-Agent": "solana-launch-sniper/3.0", "Accept": "application/json"}
SEEN_TTL_SEC = 10

# ==============================================================================
# UTILITIES & LOGGING
# ==============================================================================

def now():
    return datetime.now().astimezone()

def fmt_price(x):
    if x is None:
        return "n/a"
    x = float(x)
    if abs(x) >= 1:
        return f"{x:,.4f}"
    decimals = min(10, max(2, -math.floor(math.log10(abs(x))) + 5))
    return f"{x:.{decimals}f}"

def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None

CONSOLE_OUTPUT = True
LOG_HOOK = None
_live_active = False
_print_lock = threading.Lock()

def log(msg):
    global _live_active
    with _print_lock:
        line = f"[{now().strftime('%H:%M:%S')}] {msg}"
        if CONSOLE_OUTPUT:
            try:
                print(line, flush=True)
            except UnicodeEncodeError:
                print(line.encode('ascii', 'replace').decode('ascii'), flush=True)
        if LOG_HOOK:
            try:
                LOG_HOOK(line)
            except Exception:
                pass

def get_json(url, params=None, timeout=6, headers=None):
    hdrs = {**HEADERS, **(headers or {})}
    if _HAS_REQUESTS and _session:
        try:
            r = _session.get(url, params=params, headers=hdrs, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            return None
        except Exception:
            return None
    # Standard library urllib fallback
    try:
        full_url = url
        if params:
            full_url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(full_url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass
    return None

def post_json(url, payload, timeout=8, headers=None):
    hdrs = {**HEADERS, "Content-Type": "application/json", **(headers or {})}
    data_bytes = json.dumps(payload).encode("utf-8")
    if _HAS_REQUESTS and _session:
        try:
            r = _session.post(url, json=payload, headers=hdrs, timeout=timeout)
            return r.status_code, r.json() if r.content else {}
        except Exception as e:
            return 500, {"error": str(e)}
    # Standard library urllib fallback
    try:
        req = urllib.request.Request(url, data=data_bytes, headers=hdrs, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            res_data = json.loads(resp.read().decode("utf-8"))
            return resp.status, res_data
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {"error": str(e)}
        return e.code, body
    except Exception as e:
        return 500, {"error": str(e)}


# ==============================================================================
# PHANTOM BROWSER BRIDGE (Local Web Server & Signing Hub)
# ==============================================================================

BRIDGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phantom Wallet Live Bridge - Solana Sniper</title>
  <script src="https://unpkg.com/@solana/web3.js@1.95.4/lib/index.iife.min.js"></script>
  <style>
    :root {
      --bg: #0c0d12;
      --card: #151722;
      --border: #26293d;
      --purple: #ab9ff2;
      --purple-glow: rgba(171, 159, 242, 0.25);
      --green: #10b981;
      --red: #ef4444;
      --text: #f3f4f6;
      --muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      width: 100%;
      max-width: 760px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .header-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .title-group h1 {
      font-size: 20px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .title-group p {
      font-size: 13px;
      color: var(--muted);
      margin-top: 4px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }
    .dot.connected { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .dot.busy { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }

    .btn {
      background: #512da8;
      color: white;
      border: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
    }
    .btn:hover { background: #5e35b1; transform: translateY(-1px); }
    .btn-secondary { background: rgba(255,255,255,0.08); border: 1px solid var(--border); }
    .btn-secondary:hover { background: rgba(255,255,255,0.15); }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 20px;
    }
    .card-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .card-val {
      font-size: 22px;
      font-weight: 700;
      color: white;
    }
    .card-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
      word-break: break-all;
    }

    .queue-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px;
    }
    .queue-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
    }
    .queue-title {
      font-size: 15px;
      font-weight: 600;
    }
    .log-box {
      background: #090a0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      max-height: 260px;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.6;
      display: flex;
      flex-direction: column-reverse;
    }
    .log-item {
      padding: 3px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .log-item.success { color: var(--green); }
    .log-item.error { color: var(--red); }
    .log-item.info { color: var(--purple); }
    a { color: var(--purple); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-card">
      <div class="title-group">
        <h1>
          <span>⚡ Phantom Live Trading Bridge</span>
        </h1>
        <p>Keep this tab open while Live Trading is active. Transactions will pop up here for signature.</p>
      </div>
      <div>
        <button id="connectBtn" class="btn" onclick="toggleConnect()">
          <span id="btnText">Connect Phantom</span>
        </button>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-label">Bridge Status</div>
        <div class="card-val" id="statusText">Disconnected</div>
        <div class="card-sub" id="walletAddr">Click Connect to pair with Phantom extension</div>
      </div>
      <div class="card">
        <div class="card-label">SOL Balance</div>
        <div class="card-val" id="solBalance">-- SOL</div>
        <div class="card-sub" id="balanceUsd">Awaiting wallet connection...</div>
      </div>
    </div>

    <div class="queue-card">
      <div class="queue-header">
        <div class="queue-title">⚡ Transaction Queue & Signing Hub</div>
        <div class="badge" id="autoStatusBadge">
          <span class="dot connected"></span>
          <span>Ready for trades</span>
        </div>
      </div>
      <div class="log-box" id="logBox">
        <div class="log-item info">Bridge loaded. Waiting for Phantom wallet connection...</div>
      </div>
    </div>
  </div>

  <script>
    let walletPubkey = null;
    let isConnected = false;
    let pollInterval = null;
    let connection = null;

    try {
      connection = new solanaWeb3.Connection("https://api.mainnet-beta.solana.com", "confirmed");
    } catch (e) {
      console.warn("Solana Web3 connection warning:", e);
    }

    function addLog(msg, type = "normal") {
      const box = document.getElementById("logBox");
      const div = document.createElement("div");
      div.className = "log-item " + type;
      const time = new Date().toLocaleTimeString();
      div.innerHTML = `[${time}] ${msg}`;
      box.prepend(div);
    }

    function getProvider() {
      if ('phantom' in window && window.phantom?.solana?.isPhantom) {
        return window.phantom.solana;
      }
      if ('solana' in window && window.solana?.isPhantom) {
        return window.solana;
      }
      return null;
    }

    async function toggleConnect() {
      const provider = getProvider();
      if (!provider) {
        alert("Phantom Wallet extension not found! Please install Phantom from https://phantom.app");
        window.open("https://phantom.app", "_blank");
        return;
      }

      if (isConnected) {
        await provider.disconnect();
        isConnected = false;
        walletPubkey = null;
        updateUI();
        await notifyBackendDisconnect();
        addLog("Wallet disconnected.", "info");
      } else {
        try {
          addLog("Requesting connection to Phantom...", "info");
          const resp = await provider.connect();
          walletPubkey = resp.publicKey.toString();
          isConnected = true;
          updateUI();
          await notifyBackendConnect(walletPubkey);
          await refreshBalance();
          addLog("Connected: " + walletPubkey.slice(0, 4) + "..." + walletPubkey.slice(-4), "success");
          startPolling();
        } catch (err) {
          addLog("Connection failed: " + err.message, "error");
        }
      }
    }

    async function refreshBalance() {
      if (!walletPubkey || !connection) return;
      try {
        const pk = new solanaWeb3.PublicKey(walletPubkey);
        const bal = await connection.getBalance(pk);
        const sol = (bal / 1e9).toFixed(4);
        document.getElementById("solBalance").innerText = sol + " SOL";
        document.getElementById("balanceUsd").innerText = "On-chain balance verified via Solana Mainnet";
      } catch (e) {
        console.error("Balance fetch error:", e);
      }
    }

    function updateUI() {
      const btn = document.getElementById("connectBtn");
      const btnText = document.getElementById("btnText");
      const statusText = document.getElementById("statusText");
      const walletAddr = document.getElementById("walletAddr");

      if (isConnected && walletPubkey) {
        btnText.innerText = "Disconnect";
        btn.className = "btn btn-secondary";
        statusText.innerText = "Active & Listening";
        statusText.style.color = "var(--green)";
        walletAddr.innerHTML = `Address: <a href="https://solscan.io/account/${walletPubkey}" target="_blank">${walletPubkey}</a>`;
      } else {
        btnText.innerText = "Connect Phantom";
        btn.className = "btn";
        statusText.innerText = "Disconnected";
        statusText.style.color = "var(--muted)";
        walletAddr.innerText = "Click Connect to pair with Phantom extension";
        document.getElementById("solBalance").innerText = "-- SOL";
      }
    }

    async function notifyBackendConnect(pubkey) {
      try {
        await fetch("/api/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: pubkey })
        });
      } catch (e) {
        console.error("Backend notify error:", e);
      }
    }

    async function notifyBackendDisconnect() {
      try {
        await fetch("/api/disconnect", { method: "POST" });
      } catch (e) {}
    }

    function startPolling() {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(pollForTransactions, 1000);
      setInterval(refreshBalance, 10000);
    }

    let isSigning = false;
    async function pollForTransactions() {
      if (!isConnected || isSigning) return;
      try {
        const res = await fetch("/api/poll_tx");
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.tx) {
          await handleSignTransaction(data.tx);
        }
      } catch (e) {
        // quiet poll fail
      }
    }

    async function handleSignTransaction(txReq) {
      isSigning = true;
      const provider = getProvider();
      if (!provider) {
        await postResult(txReq.id, "failed", null, "Phantom provider not found");
        isSigning = false;
        return;
      }

      addLog(`⚡ Incoming ${txReq.action} for ${txReq.symbol} (${txReq.details || ''}). Opening Phantom...`, "info");
      document.getElementById("statusText").innerText = "Signing in Phantom...";
      document.getElementById("statusText").style.color = "#f59e0b";

      try {
        const rawBytes = Uint8Array.from(atob(txReq.tx_base64), c => c.charCodeAt(0));
        let transaction;
        try {
          transaction = solanaWeb3.VersionedTransaction.deserialize(rawBytes);
        } catch (e1) {
          transaction = solanaWeb3.Transaction.from(rawBytes);
        }

        const { signature } = await provider.signAndSendTransaction(transaction, {
          skipPreflight: false,
          maxRetries: 3
        });

        addLog(`✓ ${txReq.action} Sent! Tx: <a href="https://solscan.io/tx/${signature}" target="_blank">${signature.slice(0, 16)}...</a>`, "success");
        await postResult(txReq.id, "confirmed", signature, null);
        await refreshBalance();
      } catch (err) {
        const msg = err.message || "User rejected or simulation error";
        addLog(`✗ ${txReq.action} Failed: ${msg}`, "error");
        await postResult(txReq.id, "failed", null, msg);
      } finally {
        isSigning = false;
        updateUI();
      }
    }

    async function postResult(txId, status, signature, error) {
      try {
        await fetch("/api/tx_result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tx_id: txId,
            status: status,
            signature: signature,
            error: error
          })
        });
      } catch (e) {
        console.error("Result post error:", e);
      }
    }

    // Auto-detect provider on page load
    window.addEventListener("load", () => {
      const provider = getProvider();
      if (provider && provider.isPhantom) {
        addLog("Phantom extension detected. Attempting auto-connect...", "info");
        provider.connect({ onlyIfTrusted: true }).then(resp => {
          walletPubkey = resp.publicKey.toString();
          isConnected = true;
          updateUI();
          notifyBackendConnect(walletPubkey);
          refreshBalance();
          startPolling();
          addLog("Reconnected to trusted wallet: " + walletPubkey.slice(0, 6) + "...", "success");
        }).catch(() => {
          addLog("Click 'Connect Phantom' to start live trading.", "info");
        });
      }
    });
  </script>
</body>
</html>
"""

class WalletBridgeHandler(BaseHTTPRequestHandler):
    bridge_ref = None

    def log_message(self, format, *args):
        # Silence standard HTTP access logging to keep terminal/GUI clean
        return

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(BRIDGE_HTML.encode("utf-8"))
        elif parsed.path == "/api/status":
            self.send_json(self.bridge_ref.get_status())
        elif parsed.path == "/api/poll_tx":
            tx = self.bridge_ref.pop_pending_tx()
            self.send_json({"tx": tx})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            data = {}

        if parsed.path == "/api/connect":
            pubkey = data.get("publicKey")
            if pubkey:
                self.bridge_ref.set_connected_wallet(pubkey)
            self.send_json({"ok": True})
        elif parsed.path == "/api/disconnect":
            self.bridge_ref.set_disconnected()
            self.send_json({"ok": True})
        elif parsed.path == "/api/tx_result":
            tx_id = data.get("tx_id")
            status = data.get("status")
            sig = data.get("signature")
            err = data.get("error")
            self.bridge_ref.record_tx_result(tx_id, status, sig, err)
            self.send_json({"ok": True})
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_json(self, data):
        out = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class WalletBridge:
    """Manages the local HTTP server and Phantom browser signing queue."""
    def __init__(self, port=8765):
        self.port = port
        self.server = None
        self.server_thread = None
        self.lock = threading.Lock()
        self.is_running = False

        self.wallet_address = None
        self.sol_balance = 0.0
        self.last_balance_check = 0.0

        self.pending_tx_queue = []
        self.active_tx_events = {}   # tx_id -> threading.Event
        self.tx_results = {}          # tx_id -> (status, sig, error)

    def start(self):
        with self.lock:
            if self.is_running:
                return True
            try:
                WalletBridgeHandler.bridge_ref = self
                # Test port binding
                self.server = ThreadingHTTPServer(("127.0.0.1", self.port), WalletBridgeHandler)
                self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
                self.server_thread.start()
                self.is_running = True
                log(f"⚡ Phantom Browser Bridge listening on http://127.0.0.1:{self.port}")
                return True
            except Exception as e:
                log(f"⚠ Could not bind browser bridge on port {self.port}: {e}")
                return False

    def stop(self):
        with self.lock:
            if self.server:
                try:
                    self.server.shutdown()
                    self.server.server_close()
                except Exception:
                    pass
            self.is_running = False

    def open_browser(self):
        if not self.is_running:
            self.start()
        url = f"http://127.0.0.1:{self.port}"
        log(f"Opening Phantom Wallet Bridge in your default browser: {url}")
        threading.Thread(target=lambda: webbrowser.open(url), daemon=True).start()

    def is_connected(self):
        return bool(self.wallet_address)

    def set_connected_wallet(self, pubkey):
        with self.lock:
            self.wallet_address = pubkey
        log(f"✓ Phantom Wallet connected: {pubkey[:6]}...{pubkey[-4:]}")
        self.fetch_sol_balance()

    def set_disconnected(self):
        with self.lock:
            self.wallet_address = None
            self.sol_balance = 0.0
        log("Phantom Wallet disconnected from bridge.")

    def fetch_sol_balance(self):
        if not self.wallet_address:
            return 0.0
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBalance",
            "params": [self.wallet_address, {"commitment": "confirmed"}]
        }
        for url in RPC_URLS:
            try:
                code, resp = post_json(url, body, timeout=5)
                if code == 200 and "result" in resp:
                    lamports = resp["result"].get("value", 0)
                    bal = lamports / 1e9
                    with self.lock:
                        self.sol_balance = bal
                        self.last_balance_check = time.time()
                    return bal
            except Exception:
                continue
        return self.sol_balance

    def get_status(self):
        with self.lock:
            return {
                "connected": bool(self.wallet_address),
                "wallet": self.wallet_address,
                "sol_balance": self.sol_balance,
                "pending_count": len(self.pending_tx_queue)
            }

    def pop_pending_tx(self):
        with self.lock:
            if self.pending_tx_queue:
                return self.pending_tx_queue.pop(0)
        return None

    def record_tx_result(self, tx_id, status, sig, err):
        with self.lock:
            self.tx_results[tx_id] = (status, sig, err)
            ev = self.active_tx_events.get(tx_id)
            if ev:
                ev.set()

    def request_swap_signature(self, swap_base64, action, symbol, mint, details="", timeout=65):
        """
        Submits an unsigned base64 transaction to the browser bridge and waits
        for Phantom confirmation.
        Returns: (success: bool, txid_or_error: str)
        """
        if not self.wallet_address:
            return False, "Phantom wallet is not connected in browser bridge."

        tx_id = f"tx_{int(time.time()*1000)}_{symbol}"
        ev = threading.Event()
        with self.lock:
            self.active_tx_events[tx_id] = ev
            self.pending_tx_queue.append({
                "id": tx_id,
                "action": action,
                "symbol": symbol,
                "mint": mint,
                "tx_base64": swap_base64,
                "details": details
            })

        log(f"⌛ Waiting for Phantom approval in browser for {action} {symbol}...")
        done = ev.wait(timeout=timeout)

        with self.lock:
            self.active_tx_events.pop(tx_id, None)
            res = self.tx_results.pop(tx_id, None)

        if not done:
            return False, f"Transaction timed out after {timeout}s (not approved in Phantom)."
        if not res:
            return False, "Unknown bridge response."

        status, sig, err = res
        if status == "confirmed" and sig:
            return True, sig
        return False, err or "Transaction rejected or simulation failed."

# Global Bridge Instance
BRIDGE = WalletBridge(port=CONFIG["bridge_port"])


# ==============================================================================
# JUPITER ROUTING & SWAP BUILDER
# ==============================================================================

def fetch_jupiter_quote(input_mint, output_mint, amount_raw, slippage_pct=2.5):
    """
    Fetches Jupiter swap route quote with fallbacks and graceful error handling.
    Returns: (ok: bool, quote_or_error: dict/str)
    """
    slippage_bps = int(slippage_pct * 100)
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(int(amount_raw)),
        "slippageBps": str(slippage_bps),
    }

    for url in JUP_QUOTE_URLS:
        try:
            data = get_json(url, params=params, timeout=5)
            if isinstance(data, dict):
                if data.get("error") or data.get("errorCode") == "NO_ROUTES_FOUND":
                    return False, "NO_ROUTES_FOUND"
                if "outAmount" in data or "routePlan" in data:
                    return True, data
        except Exception:
            continue
    return False, "NO_ROUTES_FOUND"

def build_jupiter_swap_transaction(quote_response, user_pubkey, priority_fee_lamports=150000):
    """
    Calls Jupiter swap build API to produce a base64 VersionedTransaction.
    Returns: (ok: bool, base64_tx_or_error: str)
    """
    payload = {
        "quoteResponse": quote_response,
        "userPublicKey": user_pubkey,
        "wrapAndUnwrapSol": True,
        "dynamicComputeUnitLimit": True,
        "prioritizationFeeLamports": priority_fee_lamports,
    }

    for url in JUP_SWAP_URLS:
        try:
            code, resp = post_json(url, payload, timeout=8)
            if code == 200 and isinstance(resp, dict) and "swapTransaction" in resp:
                return True, resp["swapTransaction"]
            if isinstance(resp, dict) and resp.get("error"):
                return False, resp.get("error")
        except Exception as e:
            continue
    return False, "Failed to compile Jupiter swap transaction."

def get_onchain_token_balance(wallet_pubkey, mint):
    """Retrieves token balance and decimals directly from Solana RPC."""
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTokenAccountsByOwner",
        "params": [
            wallet_pubkey,
            {"mint": mint},
            {"encoding": "jsonParsed", "commitment": "confirmed"}
        ]
    }
    for url in RPC_URLS:
        try:
            code, resp = post_json(url, body, timeout=6)
            if code == 200 and "result" in resp:
                val = resp["result"].get("value", [])
                if val:
                    info = val[0].get("account", {}).get("data", {}).get("parsed", {}).get("info", {})
                    token_amount = info.get("tokenAmount", {})
                    raw_amount = int(token_amount.get("amount", 0))
                    ui_amount = float(token_amount.get("uiAmount", 0.0) or 0.0)
                    decimals = int(token_amount.get("decimals", 6))
                    return raw_amount, ui_amount, decimals
        except Exception:
            continue
    return 0, 0.0, 6

_sol_price_cache = {"price": 145.0, "updated_at": 0.0}
_sol_price_lock = threading.Lock()

def get_sol_price(cfg=None):
    """Returns current live SOL price in USD with 30s cache."""
    now_t = time.time()
    with _sol_price_lock:
        if now_t - _sol_price_cache["updated_at"] < 30 and _sol_price_cache["price"] > 0:
            return _sol_price_cache["price"]

    # 1. Jupiter Price API
    url = f"{JUP_PRICE}?ids={SOL_MINT}"
    data = get_json(url, timeout=4)
    if isinstance(data, dict):
        obj = data.get(SOL_MINT) or data.get("data", {}).get(SOL_MINT)
        if isinstance(obj, dict):
            p = _f(obj.get("usdPrice") or obj.get("price"))
            if p and p > 1.0:
                with _sol_price_lock:
                    _sol_price_cache["price"] = p
                    _sol_price_cache["updated_at"] = now_t
                return p

    # 2. DexScreener fallback
    ddata = get_json(f"{DEX}/tokens/v1/solana/{SOL_MINT}", timeout=4)
    if isinstance(ddata, list) and ddata:
        p = _f(ddata[0].get("priceUsd"))
        if p and p > 1.0:
            with _sol_price_lock:
                _sol_price_cache["price"] = p
                _sol_price_cache["updated_at"] = now_t
            return p

    return _sol_price_cache["price"]


# ==============================================================================
# CANDIDATE SOURCES (Gecko, Jupiter, DexScreener, PumpPortal)
# ==============================================================================

_src_last, _src_stats = {}, {}
_src_lock = threading.Lock()
_seen, _seen_lock = {}, threading.Lock()
_src_of = {}

def _mark_seen(mints):
    t = time.time()
    with _seen_lock:
        for m in mints:
            _seen[m] = t
        if len(_seen) > 20000:
            for k in [k for k, v in _seen.items() if t - v > 600]:
                _seen.pop(k, None)

def _fresh_only(mints):
    t = time.time()
    with _seen_lock:
        return [m for m in mints if t - _seen.get(m, 0) > SEEN_TTL_SEC]

def _src_gecko(cfg):
    out = []
    for page in (1, 2):
        data = get_json(GECKO, params={"page": page})
        if not (isinstance(data, dict) and isinstance(data.get("data"), list)):
            continue
        for pool in data["data"]:
            try:
                rel = pool.get("relationships") or {}
                tid = ((rel.get("base_token") or {}).get("data") or {}).get("id", "")
                if tid.startswith("solana_"):
                    mint = tid[len("solana_"):]
                    if mint and len(mint) > 20:
                        out.append(mint)
            except Exception:
                continue
    return out

def _src_jup(cfg):
    if not cfg.get("use_jupiter_recent", True):
        return []
    hdrs = {"x-api-key": cfg["jupiter_api_key"]} if cfg.get("jupiter_api_key") else None
    data = get_json(f"{JUP_TOKENS}/recent", headers=hdrs)
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("tokens") or data.get("data") or []
    else:
        return []
    return [t.get("id") for t in items if isinstance(t, dict) and t.get("id")]

def _src_profiles(cfg):
    if not cfg.get("use_dex_profiles", True):
        return []
    data = get_json(f"{DEX}/token-profiles/latest/v1")
    if not isinstance(data, list):
        return []
    return [d.get("tokenAddress") for d in data
            if isinstance(d, dict) and d.get("chainId") == "solana" and d.get("tokenAddress")]

def _src_boosts(cfg):
    if not cfg.get("use_promoted_feeds", False):
        return []
    data = get_json(f"{DEX}/token-boosts/latest/v1")
    if not isinstance(data, list):
        return []
    return [d.get("tokenAddress") for d in data
            if isinstance(d, dict) and d.get("chainId") == "solana" and d.get("tokenAddress")]

def _src_pumpportal(cfg):
    # Pump.fun feed query function
    if not cfg.get("use_pumpportal", False):
        return []
    data = get_json(f"{PUMPP}/coins/new")
    if not isinstance(data, list):
        return []
    return [c.get("mint") for c in data if isinstance(c, dict) and c.get("mint")]

# Active Sources List:
# NOTE: ("pumpportal", 3.0, _src_pumpportal) is COMMENTED OUT as requested.
# To re-enable pump.fun launches later, simply uncomment the line below.
SOURCES = [
    ("gecko", 5.0, _src_gecko),
    ("jup", 5.0, _src_jup),
    ("profiles", 3.0, _src_profiles),
    # ("pumpportal", 3.0, _src_pumpportal),  # COMMENTED OUT: bot will not buy pump.fun coins right now
    ("boosts", 10.0, _src_boosts),
]

def fetch_candidate_mints(cfg, force=False):
    mints, lock = set(), threading.Lock()
    def run(name, cd, fn):
        t = time.time()
        with _src_lock:
            if not force and t - _src_last.get(name, 0) < cd:
                return
            _src_last[name] = t
        try:
            res = fn(cfg) or []
            _src_stats[name] = {"items": len(res), "ok_at": time.time()}
        except Exception:
            _src_stats[name] = {"items": -1, "ok_at": 0.0}
            res = []
        with lock:
            for m in res:
                if isinstance(m, str) and 39 <= len(m) <= 50:
                    mints.add(m)
                    if m not in _src_of:
                        _src_of[m] = name
                    if len(_src_of) > 20000:
                        _src_of.clear()

    ths = [threading.Thread(target=run, args=s, daemon=True) for s in SOURCES]
    for t in ths:
        t.start()
    for t in ths:
        t.join(timeout=5)
    fresh = _fresh_only(list(mints))
    _mark_seen(mints)
    return fresh


# ==============================================================================
# ENTRY FILTERS & RUG DEFENSE
# ==============================================================================

def passes_filters(pair, cfg, now_ms=None):
    """Returns (ok, short_reason_code, detail)."""
    now_ms = now_ms or int(time.time() * 1000)
    created = int(pair.get("pairCreatedAt") or 0)
    if created <= 0:
        return False, "missing data", "no pairCreatedAt"
    age_s = (now_ms - created) / 1000.0
    if age_s > cfg.get("max_age_minutes", 2) * 60:
        return False, "too old", f"{age_s / 60:.1f}m > window"
    if age_s < -10:
        return False, "clock skew", "sync your PC clock"
    if _f(pair.get("priceUsd")) is None:
        return False, "no price", "no price on DexScreener yet"

    # Skip pump.fun coins as requested (commented out / disabled for now)
    dex_id = str(pair.get("dexId") or "").lower()
    mint_addr = str((pair.get("baseToken") or {}).get("address") or "")
    if dex_id == "pumpfun" or mint_addr.lower().endswith("pump"):
        return False, "pump.fun skipped", "pump.fun coins currently disabled"

    m5 = (pair.get("txns") or {}).get("m5") or {}
    buys, sells = int(m5.get("buys") or 0), int(m5.get("sells") or 0)
    ratio = cfg.get("min_buy_sell_ratio_m5", 1.0)
    if ratio > 0 and buys < sells * ratio:
        return False, "selling pressure", f"{buys}b/{sells}s in last 5m"
    m5c = _f((pair.get("priceChange") or {}).get("m5"))
    if m5c is not None and m5c > cfg.get("max_price_change_m5_pct", 300):
        return False, "already pumped", f"+{m5c:.0f}% in 5m"

    if age_s > cfg.get("ultra_early_grace_sec", 10):
        liq = _f((pair.get("liquidity") or {}).get("usd")) or 0.0
        if liq < cfg.get("min_liquidity_usd", 300):
            return False, "low liquidity", f"${liq:.0f} < ${cfg.get('min_liquidity_usd', 0):.0f}"
        if buys < cfg.get("min_buys_m5", 2):
            return False, "few buys", f"{buys} buys in last 5m"
        if cfg.get("min_volume_m5_usd", 0) > 0:
            mv5 = _f((pair.get("volume") or {}).get("m5")) or 0.0
            if mv5 < cfg["min_volume_m5_usd"]:
                return False, "low m5 volume", f"${mv5:.0f}"
        if cfg.get("min_holders", 0) > 0:
            h1b = int(((pair.get("txns") or {}).get("h1") or {}).get("buys") or 0)
            if h1b < cfg["min_holders"]:
                return False, "too few h1 buys", f"{h1b}"
    return True, "ok", ""

_rug_cache, _rug_lock = {}, threading.Lock()

def _rpc_mint_authorities(mint):
    """Direct on-chain check of the SPL mint account. Returns (rpc_ok, mint_auth, freeze_auth)."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo", "params": [mint, {"encoding": "jsonParsed"}]}
    for url in RPC_URLS:
        try:
            code, resp = post_json(url, body, timeout=5)
            if code != 200:
                continue
            value = ((resp.get("result") or {}).get("value") or {})
            parsed = ((value.get("data") or {}).get("parsed") or {})
            if parsed.get("type") == "mint":
                inf = parsed.get("info") or {}
                return True, inf.get("mintAuthority"), inf.get("freezeAuthority")
        except Exception:
            continue
    return False, None, None

def hard_rug_check(mint, cfg, age_s):
    """Return (ok, reason). On-chain authority check + Jupiter audit + RugCheck."""
    ttl = max(60, cfg.get("rug_recheck_minutes", 15) * 60)
    with _rug_lock:
        hit = _rug_cache.get(mint)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]

    verdict = (True, "ok")
    rpc_ok, ma, fa = _rpc_mint_authorities(mint)
    if rpc_ok:
        if ma:
            verdict = (False, "mint authority NOT revoked (dev can print unlimited tokens)")
        elif fa:
            verdict = (False, "freeze authority enabled (dev can freeze token sells)")
    else:
        hdrs = {"x-api-key": cfg["jupiter_api_key"]} if cfg.get("jupiter_api_key") else None
        jt = get_json(f"{JUP_TOKENS}/search", params={"query": mint}, headers=hdrs)
        if isinstance(jt, dict):
            jt = jt.get("tokens") or jt.get("data") or []
        if isinstance(jt, list) and jt:
            tok = next((t for t in jt if isinstance(t, dict) and t.get("id") == mint), None)
            if tok is None and isinstance(jt[0], dict):
                tok = jt[0]
            if isinstance(tok, dict):
                if tok.get("mintAuthority"):
                    verdict = (False, "mint authority NOT revoked")
                elif tok.get("freezeAuthority"):
                    verdict = (False, "freeze authority enabled")

    young = age_s < 180
    if verdict[0] and cfg.get("use_rugcheck", True):
        rep = get_json(f"{RUGC}/{mint}/report/summary", timeout=7)
        risks = rep.get("risks") if isinstance(rep, dict) else None
        if isinstance(risks, list):
            if not young:
                sn = _f(rep.get("score_normalised"))
                if sn is not None:
                    if sn > 100:
                        sn /= 1000.0
                    if sn >= cfg.get("rugcheck_max_score", 50):
                        verdict = (False, f"rugcheck risk score {sn:.0f}/100")
            if verdict[0]:
                strict = cfg.get("strict_rugcheck", True)
                for risk in risks:
                    level = str(risk.get("level") or "").lower()
                    name = str(risk.get("name") or "")
                    low = name.lower()
                    if level != "danger":
                        if "holder" in low and not young:
                            m = re.search(r"([\d.]+)\s*%", str(risk.get("description") or "") + " " + name)
                            if m and float(m.group(1)) > cfg.get("max_top10_holder_pct", 75):
                                verdict = (False, f"{name} ({m.group(1)}%)")
                                break
                        continue
                    if young and (("liquidity" in low) or ("lp" in low)):
                        continue
                    if not strict and not (("mint" in low) or ("freeze" in low) or ("authorit" in low) or ("holder" in low)):
                        continue
                    verdict = (False, f"rugcheck danger: {name or 'risk flag'}")
                    break
        elif not young:
            verdict = (False, "no rugcheck report available")

    with _rug_lock:
        if len(_rug_cache) > 5000:
            _rug_cache.clear()
        _rug_cache[mint] = (time.time(), verdict)
    return verdict


# ==============================================================================
# UNIFIED TRADING ACCOUNT (Paper & Live Execution)
# ==============================================================================

def locked(fn):
    def wrapper(self, *args, **kwargs):
        with self.lock:
            return fn(self, *args, **kwargs)
    return wrapper

class PaperAccount:
    """
    Unified Account handling Paper and Live execution seamlessly.
    Maintains complete backward compatibility with gui.py.
    """
    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.RLock()
        self.path = cfg.get("state_file", "sniper_state.json")
        self.state = {
            "cash": cfg["start_balance_usd"],
            "positions": {},
            "day": now().strftime("%Y-%m-%d"),
            "day_pnl": 0.0,
            "total_pnl": 0.0,
            "closed": 0,
            "wins": 0,
            "blacklist": []
        }
        self.load()

    def load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as f:
                    data = json.load(f)
                    # Support both nested multi-mode state and flat state
                    mode = self.cfg.get("execution_mode", "paper")
                    if isinstance(data, dict) and mode in data and isinstance(data[mode], dict):
                        self.state.update(data[mode])
                    elif isinstance(data, dict):
                        self.state.update(data)
                    self.state.setdefault("blacklist", [])
            except Exception as e:
                log(f"Note: state file reset or newly initialized: {e}")

    @locked
    def save(self):
        tmp = self.path + ".tmp"
        try:
            # Save under active execution mode key to keep paper & live records clean
            mode = self.cfg.get("execution_mode", "paper")
            full_data = {}
            if os.path.exists(self.path):
                try:
                    with open(self.path, encoding="utf-8") as f:
                        full_data = json.load(f)
                        if not isinstance(full_data, dict):
                            full_data = {}
                except Exception:
                    full_data = {}
            full_data[mode] = self.state

            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(full_data, f, indent=2, ensure_ascii=False)
            os.replace(tmp, self.path)
        except Exception as e:
            log(f"Error saving state: {e}")

    def _roll_day(self):
        current_day = now().strftime("%Y-%m-%d")
        if self.state.get("day") != current_day:
            self.state["day"] = current_day
            self.state["day_pnl"] = 0.0

    def can_open(self):
        self._roll_day()
        c = self.cfg
        mode = c.get("execution_mode", "paper")

        if len(self.state["positions"]) >= c["max_open_positions"]:
            return False, "max positions"

        if mode == "live":
            if not BRIDGE.is_connected():
                return False, "Phantom wallet not connected in browser"
            # Refresh balance
            sol_bal = BRIDGE.fetch_sol_balance()
            trade_sol = float(c.get("trade_size_sol", 0.020))
            gas_res = float(c.get("min_gas_reserve_sol", 0.002))
            req_sol = trade_sol + gas_res
            if sol_bal < req_sol:
                max_affordable = max(0.0, sol_bal - gas_res)
                return False, f"low SOL in Phantom: {sol_bal:.4f} SOL < {req_sol:.4f} SOL (Set trade size <= {max_affordable:.4f} SOL in Settings)"
            if self.state["day_pnl"] <= -c.get("daily_loss_limit_sol", 0.1):
                return False, "daily loss limit reached"
        else:
            if self.state["cash"] < c["trade_size_usd"]:
                return False, "no cash"
            if self.state["day_pnl"] <= -c["daily_loss_limit_usd"]:
                return False, "daily loss limit reached"

        return True, "ok"

    def _log_trade(self, row):
        new = not os.path.exists(self.cfg["trades_csv"])
        try:
            with open(self.cfg["trades_csv"], "a", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                if new:
                    w.writerow(["time", "action", "symbol", "mint", "price", "amount", "pnl", "pnl_pct", "reason", "explorer", "age_s", "dex", "mode"])
                w.writerow(row)
        except Exception as e:
            log(f"Error writing trade log: {e}")

    @locked
    def note_rejected(self, mint):
        bl = self.state["blacklist"]
        if mint not in bl:
            bl.append(mint)
        if len(bl) > 5000:
            del bl[:len(bl) - 5000]
        self.save()

    @locked
    def buy(self, mint, symbol, price, url=None, meta=None):
        meta = meta or {}
        c = self.cfg
        mode = c.get("execution_mode", "paper")
        url = url or f"https://dexscreener.com/solana/{mint}"

        ok, why = self.can_open()
        if not ok or mint in self.state["positions"]:
            return False

        if mode == "live":
            # LIVE EXECUTION VIA JUPITER & PHANTOM BROWSER
            trade_sol = float(c.get("trade_size_sol", 0.020))
            if c.get("sizing_basis") == "usd" and c.get("trade_size_usd"):
                sol_p = get_sol_price(c)
                if sol_p > 0:
                    trade_sol = round(float(c.get("trade_size_usd")) / sol_p, 4)
            lamports = int(trade_sol * 1e9)
            slippage = float(c.get("slippage_pct", 2.5))
            priority = int(c.get("priority_fee_lamports", 150000))

            log(f"⚡ Live BUY Initiated: {symbol} for {trade_sol:.4f} SOL...")
            # 1. Fetch quote
            q_ok, quote = fetch_jupiter_quote(SOL_MINT, mint, lamports, slippage_pct=slippage)
            if not q_ok:
                log(f"✗ Live BUY failed for {symbol}: Jupiter Quote returned {quote}")
                return False

            out_amount = int(quote.get("outAmount", 0))
            if out_amount <= 0:
                log(f"✗ Live BUY failed for {symbol}: zero output from Jupiter quote.")
                return False

            # 2. Build Swap Transaction
            b_ok, swap_tx = build_jupiter_swap_transaction(quote, BRIDGE.wallet_address, priority_fee_lamports=priority)
            if not b_ok:
                log(f"✗ Live BUY failed for {symbol}: swap build error: {swap_tx}")
                return False

            # 3. Request Signature via Phantom Browser Bridge
            sig_ok, sig = BRIDGE.request_swap_signature(
                swap_tx,
                action="BUY",
                symbol=symbol,
                mint=mint,
                details=f"{trade_sol:.4f} SOL"
            )
            if not sig_ok:
                log(f"✗ Live BUY cancelled/failed for {symbol}: {sig}")
                return False

            # 4. Record Position
            fill_price = price * (1 + slippage / 100)
            explorer_url = f"https://solscan.io/tx/{sig}"
            self.state["positions"][mint] = {
                "symbol": symbol,
                "qty": out_amount,
                "raw_qty": out_amount,
                "entry_price": fill_price,
                "cost": trade_sol,
                "cost_unit": "SOL",
                "opened": time.time(),
                "url": url,
                "peak_price": fill_price,
                "low_price": fill_price,
                "tp_reached": False,
                "dex": meta.get("dex", "?"),
                "source": meta.get("source", "?"),
                "age_at_entry": round(meta.get("age_s", 0), 1),
                "is_live": True,
                "buy_sig": sig,
            }
            self.state["blacklist"].append(mint)
            self._log_trade([now().isoformat(), "BUY", symbol, mint, fmt_price(fill_price), f"{trade_sol:.4f} SOL", "", "", "live_entry", explorer_url, meta.get("age_s", 0), meta.get("dex", "?"), "live"])
            log(f"✓ LIVE BUY CONFIRMED: {symbol} | {trade_sol:.4f} SOL | Tx: {explorer_url}")
            self.save()
            return True

        else:
            # PAPER TRADING SIMULATION
            size = c["trade_size_usd"]
            fill = price * (1 + c["slippage_pct"] / 100)
            qty = (size * (1 - c["fee_pct"] / 100)) / fill
            self.state["cash"] -= size
            self.state["positions"][mint] = {
                "symbol": symbol,
                "qty": qty,
                "entry_price": fill,
                "cost": size,
                "cost_unit": "USD",
                "opened": time.time(),
                "url": url,
                "peak_price": fill,
                "low_price": fill,
                "tp_reached": False,
                "dex": meta.get("dex", "?"),
                "source": meta.get("source", "?"),
                "age_at_entry": round(meta.get("age_s", 0), 1),
                "is_live": False,
            }
            self.state["blacklist"].append(mint)
            self._log_trade([now().isoformat(), "BUY", symbol, mint, fmt_price(fill), f"${size:.2f}", "", "", "paper_entry", url, meta.get("age_s", 0), meta.get("dex", "?"), "paper"])
            log(f"✓ PAPER BUY {symbol} [{meta.get('dex', '?')}/{meta.get('source', '?')}] age {meta.get('age_s', 0):.0f}s @ ${fmt_price(fill)}")
            self.save()
            return True

    @locked
    def write_off_rugged_position(self, mint, reason="liquidity_pulled_no_route"):
        """
        FIX FOR 'NO_ROUTES_FOUND':
        If a token rugpulls or drains LP, Jupiter cannot route the sell. Naive bots
        get stuck forever. This write-off routine closes the position, notes the loss,
        and clears the slot so the sniper continues operating!
        """
        if mint not in self.state["positions"]:
            return False
        pos = self.state["positions"].pop(mint)
        cost = pos.get("cost", 0.0)
        pnl = -cost
        pnl_pct = -100.0

        self._roll_day()
        self.state["day_pnl"] += pnl
        self.state["total_pnl"] += pnl
        self.state["closed"] += 1

        self._log_trade([
            now().isoformat(), "SELL", pos["symbol"], mint, "0.0000",
            "0.00", f"{pnl:.4f}", f"{pnl_pct:.1f}%", f"WRITE_OFF_{reason}",
            pos.get("url", "")
        ])
        log(f"✗ WRITE-OFF RUG: {pos['symbol']} [NO_ROUTES_FOUND / Zero Liquidity] | Slot freed!")
        self.save()
        return True

    @locked
    def sell(self, mint, price, reason):
        if mint not in self.state["positions"]:
            return False
        pos = self.state["positions"][mint]
        is_live = pos.get("is_live", False)
        c = self.cfg

        if is_live:
            # LIVE SELL VIA JUPITER & PHANTOM BROWSER
            log(f"⚡ Live SELL Triggered for {pos['symbol']} [{reason}]...")
            # Query exact on-chain raw balance
            raw_bal, ui_bal, decimals = get_onchain_token_balance(BRIDGE.wallet_address, mint)
            if raw_bal <= 0:
                raw_bal = int(pos.get("raw_qty", pos.get("qty", 0)))

            if raw_bal <= 0:
                log(f"⚠ Zero tokens found in wallet for {pos['symbol']}. Closing tracking slot.")
                self.write_off_rugged_position(mint, reason=f"zero_balance_{reason}")
                return True

            slippage = float(c.get("slippage_pct", 3.0))
            priority = int(c.get("priority_fee_lamports", 150000))

            # Fetch Jupiter quote for Token -> SOL
            q_ok, quote = fetch_jupiter_quote(mint, SOL_MINT, raw_bal, slippage_pct=slippage)
            if not q_ok:
                if quote == "NO_ROUTES_FOUND":
                    log(f"⚠ Jupiter returned NO_ROUTES_FOUND for {pos['symbol']} (liquidity drained/rugged). Writing off position to free slot...")
                    return self.write_off_rugged_position(mint, reason=f"no_route_{reason}")
                log(f"✗ Live SELL quote failed for {pos['symbol']}: {quote}")
                return False

            out_lamports = int(quote.get("outAmount", 0))
            proceeds_sol = out_lamports / 1e9

            # Build swap transaction
            b_ok, swap_tx = build_jupiter_swap_transaction(quote, BRIDGE.wallet_address, priority_fee_lamports=priority)
            if not b_ok:
                log(f"✗ Live SELL failed for {pos['symbol']}: swap build error: {swap_tx}")
                return False

            # Prompt user in Phantom
            sig_ok, sig = BRIDGE.request_swap_signature(
                swap_tx,
                action="SELL",
                symbol=pos["symbol"],
                mint=mint,
                details=f"{proceeds_sol:.4f} SOL"
            )
            if not sig_ok:
                log(f"✗ Live SELL rejected/failed for {pos['symbol']}: {sig}")
                return False

            # Remove position and calculate PnL in SOL
            self.state["positions"].pop(mint)
            pnl_sol = proceeds_sol - pos["cost"]
            pnl_pct = (pnl_sol / pos["cost"]) * 100.0 if pos["cost"] > 0 else 0.0

            self._roll_day()
            self.state["day_pnl"] += pnl_sol
            self.state["total_pnl"] += pnl_sol
            self.state["closed"] += 1
            if pnl_sol > 0:
                self.state["wins"] += 1

            explorer_url = f"https://solscan.io/tx/{sig}"
            self._log_trade([now().isoformat(), "SELL", pos["symbol"], mint, fmt_price(price), f"{proceeds_sol:.4f} SOL", round(pnl_sol, 4), round(pnl_pct, 2), reason, explorer_url, "", "", "live"])
            log(f"✗ LIVE SELL CONFIRMED: {pos['symbol']} | Proceeds: {proceeds_sol:.4f} SOL | PnL: {pnl_sol:+.4f} SOL ({pnl_pct:+.1f}%) | Tx: {explorer_url}")
            self.save()
            return True

        else:
            # PAPER TRADING SELL
            pos = self.state["positions"].pop(mint)
            fill = price * (1 - c["slippage_pct"] / 100)
            proceeds = pos["qty"] * fill * (1 - c["fee_pct"] / 100)
            pnl = proceeds - pos["cost"]
            pnl_pct = pnl / pos["cost"] * 100
            self.state["cash"] += proceeds
            self._roll_day()
            self.state["day_pnl"] += pnl
            self.state["total_pnl"] += pnl
            self.state["closed"] += 1
            if pnl > 0:
                self.state["wins"] += 1
            self._log_trade([now().isoformat(), "SELL", pos["symbol"], mint, fmt_price(fill), f"${proceeds:.2f}", round(pnl, 4), round(pnl_pct, 2), reason, pos.get("url", ""), "", "", "paper"])
            log(f"✗ PAPER SELL {pos['symbol']} @ ${fmt_price(fill)} pnl ${pnl:.2f} ({pnl_pct:.1f}%) [{reason}]")
            self.save()
            return True

    @locked
    def check_exits(self, prices):
        """
        Evaluates exits including Stop Loss, Trailing Profit Lock, and Max Hold.
        Solves: 'coins exiting right at fixed TP while moving upwards'.
        """
        exits = 0
        tp = float(self.cfg.get("take_profit_pct", 50))
        trail = float(self.cfg.get("trailing_stop_pct", 0))
        trail_mode = bool(self.cfg.get("trailing_profit_mode", True))
        sl = float(self.cfg.get("stop_loss_pct", 35))
        rug_drop = float(self.cfg.get("rug_exit_drop_pct", 75))

        for mint, pos in list(self.state["positions"].items()):
            price = prices.get(mint)
            if price is None:
                continue
            entry = pos["entry_price"]
            pos["peak_price"] = max(pos.get("peak_price", entry), price)
            pos["low_price"] = min(pos.get("low_price", entry), price)

            change = (price / entry - 1) * 100
            peak_chg = (pos["peak_price"] / entry - 1) * 100
            pullback_from_peak = (1 - price / pos["peak_price"]) * 100 if pos["peak_price"] > 0 else 0

            reason = None

            # 1. Stop Loss Defense
            if sl > 0 and change <= -sl:
                reason = f"stop_loss_{-sl:g}%"

            # 2. Emergency Rug Defense (rapid drop from peak)
            elif rug_drop > 0 and peak_chg >= 20 and pullback_from_peak >= rug_drop:
                reason = f"rug_dump_pullback_{pullback_from_peak:.0f}%"

            # 3. Trailing Profit Lock (rides pumps past fixed TP)
            elif trail_mode and tp > 0:
                if change >= tp:
                    pos["tp_reached"] = True
                if pos.get("tp_reached", False):
                    # Trail from peak once TP was hit (default 8% if trailing_stop_pct is 0)
                    active_trail = trail if trail > 0 else 8.0
                    if pullback_from_peak >= active_trail:
                        reason = f"trailing_profit_peak+{peak_chg:.0f}%"

            # 4. Standard Fixed Take Profit
            elif (not trail_mode) and tp > 0 and change >= tp:
                reason = f"take_profit_{tp:g}%"

            # 5. Generic Trailing Stop (if peak climbed >10%)
            elif trail > 0 and peak_chg >= 10 and pullback_from_peak >= trail:
                reason = f"trailing_stop_{trail:g}%"

            # 6. Max Hold Time Expired
            elif (time.time() - pos["opened"]) / 60 >= self.cfg.get("max_hold_minutes", 120):
                reason = "max_hold"

            if reason:
                self.sell(mint, price, reason)
                exits += 1

        return exits


# ==============================================================================
# SCAN & MONITOR LOOPS
# ==============================================================================

_stats_lock = threading.Lock()
_stats = {"since": time.time(), "cands": 0, "no_pair": 0, "checked": 0, "rejects": {}, "rug": 0, "bought": 0}
_last_block_log = [0.0]

def _maybe_summary():
    with _stats_lock:
        if time.time() - _stats["since"] < 60:
            return
        cands, no_pair, checked = _stats["cands"], _stats["no_pair"], _stats["checked"]
        rejects, rug, bought = dict(_stats["rejects"]), _stats["rug"], _stats["bought"]
        src_bits = [f"{n}={v.get('items', 0)}{'*' if time.time() - v.get('ok_at', 0) > 120 else ''}"
                    for n, v in sorted(_src_stats.items())]
        _stats.update({"since": time.time(), "cands": 0, "no_pair": 0, "checked": 0, "rejects": {}, "rug": 0, "bought": 0})
    rej_txt = " ".join(f"{k}:{v}" for k, v in sorted(rejects.items(), key=lambda kv: -kv[1]))
    log(f"scan summary (60s): sources[{(' '.join(src_bits)) or 'none'}] candidates={cands} not-indexed={no_pair} checked={checked} rejected[{rej_txt or '-'}] rug={rug} BOUGHT={bought}")

def scan_and_buy(acct, cfg):
    _maybe_summary()
    ok, why = acct.can_open()
    if not ok:
        if time.time() - _last_block_log[0] > 30:
            _last_block_log[0] = time.time()
            log(f"Waiting to trade: {why}")
        return

    fresh = fetch_candidate_mints(cfg)
    if not fresh:
        return
    with _stats_lock:
        _stats["cands"] += len(fresh)

    now_ms = int(time.time() * 1000)
    pairs = {}
    for i in range(0, len(fresh), 30):
        chunk = fresh[i:i + 30]
        data = get_json(f"{DEX}/tokens/v1/solana/{','.join(chunk)}")
        if not isinstance(data, list):
            continue
        for p in data:
            mint = (p.get("baseToken") or {}).get("address")
            if not mint:
                continue
            liq = _f((p.get("liquidity") or {}).get("usd")) or 0.0
            cur = pairs.get(mint)
            if cur is None or liq > cur[0]:
                pairs[mint] = (liq, p)
    with _stats_lock:
        _stats["no_pair"] += max(0, len(fresh) - len(pairs))

    for mint, (_liq, pair) in pairs.items():
        if not acct.can_open()[0]:
            break
        if mint in acct.state["positions"] or mint in acct.state["blacklist"]:
            continue
        symbol = (pair.get("baseToken") or {}).get("symbol") or "?"
        okp, code, detail = passes_filters(pair, cfg, now_ms)
        with _stats_lock:
            _stats["checked"] += 1
        if not okp:
            with _stats_lock:
                _stats["rejects"][code] = _stats["rejects"].get(code, 0) + 1
            if cfg.get("log_rejects"):
                log(f"– {symbol} filtered: {code} ({detail})")
            continue

        age_s = max(0.0, (now_ms - int(pair.get("pairCreatedAt") or 0)) / 1000.0)
        rok, rwhy = hard_rug_check(mint, cfg, age_s)
        if not rok:
            with _stats_lock:
                _stats["rug"] += 1
            log(f"✗ RUG REJECT {symbol}: {rwhy}")
            acct.note_rejected(mint)
            continue

        price = _f(pair.get("priceUsd"))
        if price is None:
            continue

        meta = {"dex": pair.get("dexId") or "?", "source": _src_of.get(mint, "?"), "age_s": age_s}
        if acct.buy(mint, symbol, price, pair.get("url"), meta):
            with _stats_lock:
                _stats["bought"] += 1

def _jupiter_prices(mints, cfg):
    if not cfg.get("use_jupiter_price", True) or not mints:
        return {}
    headers = {"x-api-key": cfg["jupiter_api_key"]} if cfg.get("jupiter_api_key") else None
    data = get_json(JUP_PRICE, params={"ids": ",".join(mints)}, timeout=4, headers=headers)
    if not isinstance(data, dict):
        return {}
    prices = {}
    for mint, quote in data.items():
        if isinstance(quote, dict):
            price = _f(quote.get("usdPrice") or quote.get("price"))
            if price is not None:
                prices[mint] = price
    return prices

def monitor(acct):
    pos = acct.state["positions"]
    if not pos:
        return {}
    mints = list(pos.keys())
    prices = _jupiter_prices(mints, acct.cfg)
    missing = [mint for mint in mints if mint not in prices]
    for i in range(0, len(missing), 30):
        chunk = missing[i:i + 30]
        data = get_json(f"{DEX}/tokens/v1/solana/{','.join(chunk)}", timeout=4)
        if isinstance(data, list):
            for p in data:
                mint = (p.get("baseToken") or {}).get("address")
                if mint in pos and mint not in prices:
                    price = _f(p.get("priceUsd"))
                    if price is not None:
                        prices[mint] = price
    acct.check_exits(prices)
    return prices

def run(once=False):
    acct = PaperAccount(CONFIG)
    mode = CONFIG.get("execution_mode", "paper").upper()
    log(f"=== SOLANA SNIPER BOT STARTED ({mode} MODE) ===")
    if mode == "LIVE":
        BRIDGE.start()
        BRIDGE.open_browser()
        log("Phantom Browser Bridge initialized. Connect your wallet in the browser tab to trade.")
    log(f"Sources: gecko={CONFIG['use_gecko']} jupiter={CONFIG['use_jupiter_recent']} profiles={CONFIG['use_dex_profiles']} pumpportal={CONFIG['use_pumpportal']} boosts={CONFIG['use_promoted_feeds']}")
    log(f"Window: coins < {CONFIG['max_age_minutes'] * 60:.0f}s old | TP {CONFIG['take_profit_pct']}% | Trailing Profit Lock={CONFIG['trailing_profit_mode']} | SL {CONFIG['stop_loss_pct']}%")

    if once:
        scan_and_buy(acct, CONFIG)
        monitor(acct)
        return

    stop = threading.Event()
    def scan_loop():
        while not stop.is_set():
            started = time.time()
            try:
                scan_and_buy(acct, CONFIG)
            except Exception as e:
                log(f"scan error: {e}")
            stop.wait(max(0.1, CONFIG["scan_interval_sec"] - (time.time() - started)))

    threading.Thread(target=scan_loop, daemon=True).start()
    while True:
        started = time.time()
        try:
            monitor(acct)
        except KeyboardInterrupt:
            stop.set()
            if mode == "LIVE":
                BRIDGE.stop()
            break
        time.sleep(max(0.1, CONFIG["monitor_interval_sec"] - (time.time() - started)))

if __name__ == "__main__":
    if "--live" in sys.argv:
        CONFIG["execution_mode"] = "live"
    run(once="--once" in sys.argv)
