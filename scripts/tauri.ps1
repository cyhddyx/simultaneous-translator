[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("dev", "build")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DesktopRoot = Join-Path $ProjectRoot "desktop"
$RustBin = Join-Path $env:USERPROFILE ".cargo\bin"
$CargoPath = Join-Path $RustBin "cargo.exe"
$SidecarBuildScript = Join-Path $PSScriptRoot "build-tauri-sidecar.ps1"

if (-not (Test-Path -LiteralPath $CargoPath)) {
    throw "Rust MSVC toolchain is missing. Install Rustup and run rustup default stable-x86_64-pc-windows-msvc."
}

if (-not (Test-Path -LiteralPath (Join-Path $DesktopRoot "node_modules"))) {
    throw "Desktop dependencies are missing. Run npm install in the desktop directory first."
}

$env:Path = "$RustBin;$env:Path"
if ($Mode -eq "build") {
    if (-not (Test-Path -LiteralPath $SidecarBuildScript)) {
        throw "Tauri sidecar build script is missing."
    }

    & $SidecarBuildScript
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri sidecar build failed with exit code $LASTEXITCODE."
    }
}

Push-Location $DesktopRoot
try {
    npx tauri $Mode
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri $Mode failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
