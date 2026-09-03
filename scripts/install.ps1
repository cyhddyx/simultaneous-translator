$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $PluginRoot ".venv"

if (-not (Test-Path $VenvPath)) {
    python -m venv $VenvPath
}

& (Join-Path $VenvPath "Scripts\python.exe") -m pip install --upgrade pip
& (Join-Path $VenvPath "Scripts\python.exe") -m pip install -r (Join-Path $PluginRoot "requirements.txt")
Write-Host "Installation complete. Run scripts\\run-tauri.ps1 to start the desktop app."
