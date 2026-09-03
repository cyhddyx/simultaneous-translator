$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $PSScriptRoot
$PythonPath = Join-Path $PluginRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $PythonPath)) {
    throw "尚未安装依赖。请先运行 scripts\install.ps1。"
}

& $PythonPath (Join-Path $PSScriptRoot "translator.py")

