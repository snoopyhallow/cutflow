@echo off
title CutFlow Studio
setlocal
set "ROOT=%~dp0.."
set "PATH=%ROOT%\apps\api\.venv\Scripts;%PATH%"
cd /d "%ROOT%\apps\api"
echo Starting CutFlow Studio on http://127.0.0.1:8010 ...
"%ROOT%\apps\api\.venv\Scripts\cutflow.exe" serve --host 127.0.0.1 --port 8010
pause
