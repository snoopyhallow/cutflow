# Starts CutFlow API (Uvicorn --reload on :8010) and Web UI (Vite HMR on :5173) together.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $RepoRoot "apps\api"
$WebDir = Join-Path $RepoRoot "apps\web"
$VenvScripts = Join-Path $ApiDir ".venv\Scripts"

$env:Path = "$VenvScripts;" + [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

Write-Host "Starting CutFlow API on http://127.0.0.1:8010 ..." -ForegroundColor Cyan
$apiProc = Start-Process -FilePath (Join-Path $VenvScripts "uvicorn.exe") `
    -ArgumentList "cutflow.app:app", "--host", "127.0.0.1", "--port", "8010", "--reload" `
    -WorkingDirectory $ApiDir -PassThru -NoNewWindow

try {
    Write-Host "Starting CutFlow Web Studio on http://127.0.0.1:5173 ..." -ForegroundColor Cyan
    Set-Location $WebDir
    npm run dev
} finally {
    if ($apiProc -and -not $apiProc.HasExited) {
        Stop-Process -Id $apiProc.Id -Force -ErrorAction SilentlyContinue
    }
}
