#!/usr/bin/env bash
# Startup script for On-Chain SPOT Bot v2 on macOS and Linux

echo "===================================================================="
echo "            ◈ ON-CHAIN SPOT BOT v2 - LOCAL RUNNER"
echo "===================================================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not found on your system!"
    echo "Please install Node.js (v18 or higher) from https://nodejs.org/"
    echo "On Ubuntu/Debian: sudo apt update && sudo apt install -y nodejs npm"
    echo "On macOS (Homebrew): brew install node"
    exit 1
fi

echo "[1/3] Environment verified: $(node --version)"

# Check node_modules
if [ ! -d "node_modules" ]; then
    echo "[2/3] Installing dependencies for first run..."
    npm install
else
    echo "[2/3] Dependencies found."
fi

echo "[3/3] Launching On-Chain SPOT Bot v2..."
echo "Opening browser at: http://localhost:3000"
echo ""

# Attempt to open browser
if command -v open &> /dev/null; then
    (sleep 2 && open http://localhost:3000) &
elif command -v xdg-open &> /dev/null; then
    (sleep 2 && xdg-open http://localhost:3000) &
fi

npm run dev
