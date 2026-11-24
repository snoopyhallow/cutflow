@echo off
title CutFlow Studio
setlocal
set "ROOT=%~dp0.."
set "PATH=%ROOT%\apps\api\.venv\Scripts;%PATH%"

if not exist "%ROOT%\apps\web\dist\index.html" (
    echo Building CutFlow Web Studio bundle...
    pushd "%ROOT%\apps\web"
    call npm run build
    popd
)

netstat -ano | findstr /R /C:":8010 .*LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo CutFlow Studio is already running on http://127.0.0.1:8010 — opening browser...
    start "" "http://127.0.0.1:8010"
    timeout /t 2 >nul
    exit /b 0
)

cd /d "%ROOT%\apps\api"
echo Starting CutFlow Studio on http://127.0.0.1:8010 ...
echo Keep this window open (or minimized) while using CutFlow. Close it or run Stop-CutFlow.bat to stop.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8010'"
"%ROOT%\apps\api\.venv\Scripts\cutflow.exe" serve --host 127.0.0.1 --port 8010
pause
