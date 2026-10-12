# Installiert den Multiview-Server auf Windows:
#   1. prüft Node.js
#   2. installiert die Node-Pakete
#   3. lädt MediaMTX (Stream-Empfang) und prüft die Prüfsumme
# Wird über install-windows.bat gestartet.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$MediamtxVersion = 'v1.21.2'
$MediamtxBase = "https://github.com/bluenviron/mediamtx/releases/download/$MediamtxVersion"
$File = "mediamtx_${MediamtxVersion}_windows_amd64.zip"

Write-Host '== Multiview - Installation ==' -ForegroundColor Cyan

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'FEHLER: Node.js ist nicht installiert. Bitte von https://nodejs.org die LTS-Version installieren und dieses Skript erneut starten.' -ForegroundColor Red
  exit 1
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) {
  Write-Host "FEHLER: Node.js $(& node -v) ist zu alt - Version 18 oder neuer noetig." -ForegroundColor Red
  exit 1
}
Write-Host "Node.js $(& node -v) gefunden."

# 2. Node-Pakete
Write-Host 'Installiere Node-Pakete ...'
& npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host 'FEHLER bei npm ci' -ForegroundColor Red; exit 1 }

# 3. MediaMTX
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("multiview-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Lade MediaMTX $MediamtxVersion ..."
  Invoke-WebRequest -UseBasicParsing -Uri "$MediamtxBase/$File" -OutFile (Join-Path $tmp $File)
  Invoke-WebRequest -UseBasicParsing -Uri "$MediamtxBase/checksums.sha256" -OutFile (Join-Path $tmp 'checksums.sha256')

  $line = Select-String -Path (Join-Path $tmp 'checksums.sha256') -SimpleMatch $File | Select-Object -First 1
  $expected = if ($line) { ($line.Line -split '\s+')[0].ToLower() } else { '' }
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $File)).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) {
    Write-Host 'FEHLER: Pruefsumme von MediaMTX stimmt nicht - Datei wird nicht verwendet.' -ForegroundColor Red
    exit 1
  }
  Write-Host 'Pruefsumme OK.'

  Expand-Archive -Path (Join-Path $tmp $File) -DestinationPath (Join-Path $tmp 'x') -Force
  New-Item -ItemType Directory -Path (Join-Path $Root 'bin') -Force | Out-Null
  Copy-Item (Join-Path $tmp 'x\mediamtx.exe') (Join-Path $Root 'bin\mediamtx.exe') -Force
  Write-Host 'MediaMTX installiert: bin\mediamtx.exe'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Fertig. Starten mit start-windows.bat' -ForegroundColor Green
Write-Host 'Dann im Browser: http://<IP-dieses-Rechners>:8090'
Write-Host 'Tipp: firewall-windows.bat (als Administrator) gibt die noetigen Ports frei.'
