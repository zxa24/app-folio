@echo off
chcp 65001 >nul 2>&1
setlocal

set PORT=8080
set URL=http://localhost:%PORT%

:: Find node.exe
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

:: If port 3000 is already in use, check if it is OUR translator server
:: (so re-running the bat is idempotent). If it is some OTHER server, kill it
:: so our serve.js can bind. Without this check, an unrelated process holding
:: port 3000 makes the browser show its 'Cannot GET /' (or whatever) instead.
echo Checking if port %PORT% is free...
curl -s "%URL%/api/ping" 2>nul | findstr /c:"translator-app-local" >nul
if %errorlevel% equ 0 (
    echo Existing translator server detected on port %PORT% - reusing it.
    goto open_browser
)

:: Port not held by us. Kill anyone else on this port (best effort).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo Killing stale process %%a holding port %PORT%...
    taskkill /F /PID %%a >nul 2>&1
)

:: Start server in a SEPARATE window so it survives this bat's exit.
:: Previously used `start "" /b` which shares this console - when the bat
:: reaches end and cmd.exe closes, the console closes, and node receives
:: CTRL_CLOSE_EVENT and dies. Browser then can't reach localhost.
:: New window decouples node lifetime from the launcher bat.
start "Translator Server" /min node "%~dp0serve.js" %PORT%

:: Wait for OUR server to respond (verify the response signature, not just
:: any HTTP response - a foreign server replying 404 would otherwise look
:: like success and we'd open the browser to the wrong page).
echo Starting translator app server on port %PORT%...
set RETRIES=0
:wait_loop
if %RETRIES% geq 20 (
    echo [ERROR] Server failed to start after 10 seconds.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul 2>&1
curl -s "%URL%/api/ping" 2>nul | findstr /c:"translator-app-local" >nul
if %errorlevel% neq 0 (
    set /a RETRIES+=1
    goto wait_loop
)

:open_browser
echo Server ready. Opening browser...
start "" "%URL%"
