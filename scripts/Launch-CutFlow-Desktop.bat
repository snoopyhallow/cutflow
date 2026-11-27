@echo off
title CutFlow Studio Desktop
setlocal
set "ROOT=%~dp0.."
set "EXE=%ROOT%\apps\desktop\release\win-unpacked\CutFlow Studio.exe"

if exist "%EXE%" (
    start "" "%EXE%"
    exit /b 0
)

echo Launching CutFlow Studio Desktop via Electron...
pushd "%ROOT%"
call npm run desktop
popd
