[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonPath = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$BridgePath = Join-Path $PSScriptRoot "tauri_bridge.py"
$OutputDir = Join-Path $ProjectRoot "desktop\src-tauri\binaries"
$BuildRoot = Join-Path $ProjectRoot ".tauri-sidecar-build"

if (-not (Test-Path -LiteralPath $PythonPath)) {
    throw "Project virtual environment is missing. Run scripts\\install.ps1 first."
}

if (-not (Test-Path -LiteralPath $BridgePath)) {
    throw "scripts\\tauri_bridge.py is missing."
}

& $PythonPath -m pip install "pyinstaller==6.22.2"
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller installation failed."
}
New-Item -ItemType Directory -Force -Path $OutputDir, $BuildRoot | Out-Null

& $PythonPath -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "translator-bridge" `
    --distpath (Join-Path $BuildRoot "dist") `
    --workpath (Join-Path $BuildRoot "work") `
    --specpath $BuildRoot `
    --hidden-import dashscope.audio.asr `
    --hidden-import soundcard.mediafoundation `
    $BridgePath
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller sidecar build failed."
}

$BuiltBridge = Join-Path $BuildRoot "dist\translator-bridge.exe"
$TargetBridge = Join-Path $OutputDir "translator-bridge-$TargetTriple.exe"
if (-not (Test-Path -LiteralPath $BuiltBridge)) {
    throw "PyInstaller did not produce translator-bridge.exe."
}

Copy-Item -LiteralPath $BuiltBridge -Destination $TargetBridge -Force
Write-Host "Sidecar built: $TargetBridge"
