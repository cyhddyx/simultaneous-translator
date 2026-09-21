param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    if (Get-Process -Name 'VBCABLE_Setup', 'VBCABLE_Setup_x64' -ErrorAction SilentlyContinue) {
        throw 'VB-CABLE installer is already open. Complete or close it first.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $componentDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('SimultaneousTranslator\components\VB-CABLE\' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $componentDirectory -Force | Out-Null
    $archivePath = Join-Path $componentDirectory 'VBCABLE_Driver_Pack45.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' -OutFile $archivePath -TimeoutSec 60
    $expectedHash = 'B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB'
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'The official package has changed or is damaged. Installation was stopped.'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $componentDirectory
    $installerName = if ([Environment]::Is64BitOperatingSystem) { 'VBCABLE_Setup_x64.exe' } else { 'VBCABLE_Setup.exe' }
    $installerPath = Join-Path $componentDirectory $installerName
    $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne 'A77952D93229D0EC36E2543081EEA7D125732B9C') {
        throw 'The VB-Audio publisher signature could not be verified. Installation was stopped.'
    }
    if ($PrepareOnly) {
        Write-Output 'Verified official package and publisher. No installer was launched.'
        exit 0
    }
    # Keep the vendor installer visible so the user reviews its terms and installs explicitly.
    Start-Process -FilePath $installerPath -WorkingDirectory $componentDirectory -Verb RunAs | Out-Null
    Write-Output 'launched'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
