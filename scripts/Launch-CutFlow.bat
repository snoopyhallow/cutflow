@echo off
title CutFlow Studio
setlocal
set "ROOT=%~dp0.."
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"` ) do set "SYS_PATH=%%P"
set "PATH=%ROOT%\apps\api\.venv\Scripts;%SYS_PATH%"
cd /d "%ROOT%\apps\api"
echo Starting CutFlow Studio on http://127.0.0.1:8010 ...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8010'"
"%ROOT%\apps\api\.venv\Scripts\cutflow.exe" serve --host 127.0.0.1 --port 8010
pause
