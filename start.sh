#!/usr/bin/env bash
# Standalone Desktop GUI launcher for Solana Launch Sniper (macOS and Linux)

echo "===================================================================="
echo "        SOLANA LAUNCH SNIPER - STANDALONE DESKTOP SOFTWARE"
echo "===================================================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not found on your system!"
    echo "Please install Node.js (v18 or higher) from https://nodejs.org/"
    echo "On Ubuntu/Debian: sudo apt update && sudo apt install -y nodejs npm"
    echo "On macOS (Homebrew): brew install node"
    exit 1
fi

echo "[1/2] Runtime verified: $(node --version)"
echo "[2/2] Launching Standalone Desktop GUI Window (no browser needed)..."
echo "(First launch installs desktop runtime dependencies automatically.)"
echo ""

npm run desktop
