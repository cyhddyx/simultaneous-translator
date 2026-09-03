$ErrorActionPreference = "Stop"
$TauriScript = Join-Path $PSScriptRoot "tauri.ps1"

& $TauriScript dev
