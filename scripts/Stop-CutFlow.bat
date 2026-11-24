@echo off
title Stop CutFlow Studio
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force; Write-Host ('Stopped CutFlow PID ' + $_.OwningProcess) }"
echo Done.
timeout /t 2 >nul
