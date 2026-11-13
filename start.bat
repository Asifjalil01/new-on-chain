@echo off
title On-Chain SPOT Bot v2
echo ====================================================================
echo             ◈ ON-CHAIN SPOT BOT v2 - LOCAL RUNNER
echo ====================================================================
echo.
echo [1/3] Checking environment...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on your system!
    echo Please download and install Node.js LTS from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [2/3] Checking dependencies & esbuild runtime...
if not exist node_modules (
    echo Installing dependencies (first run)...
    call npm install
) else (
    REM Check if esbuild binary is working properly
    npx esbuild --version >nul 2>nul
    if %errorlevel% neq 0 (
        echo Esbuild runtime update required...
        call npm install -D esbuild@^0.28.0
        call npm install
    )
)

echo [3/3] Starting Bot Engine and Web GUI...
echo.
echo The dashboard will automatically open in your default browser at:
echo http://localhost:3000
echo.
echo Press Ctrl+C in this window at any time to stop the bot.
echo ====================================================================
echo.

timeout /t 2 /nobreak >nul
start http://localhost:3000

call npm run dev
if %errorlevel% neq 0 (
    echo.
    echo Bot stopped with an issue. Running automated dependency repair...
    call npm install -D esbuild@^0.28.0
    call npm install
    echo Retrying launch...
    call npm run dev
)
pause
