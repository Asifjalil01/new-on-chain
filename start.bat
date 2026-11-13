@echo off
title Solana Launch Sniper - Desktop App
echo ====================================================================
echo         SOLANA LAUNCH SNIPER - STANDALONE DESKTOP SOFTWARE
echo ====================================================================
echo.
echo [1/2] Checking Node.js runtime...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on your system!
    echo Please download and install Node.js LTS from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [2/2] Launching Standalone Desktop GUI Window (no browser needed)...
echo (First launch downloads desktop runtime dependencies automatically.)
echo.
call npm run desktop
if %errorlevel% neq 0 (
    echo.
    echo Desktop app exited with an error. Check the log above.
    pause
)
