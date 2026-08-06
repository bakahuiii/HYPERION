[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if (Get-Process syncthing -ErrorAction SilentlyContinue) { exit 0 }

$syncthing = Get-Command syncthing -ErrorAction SilentlyContinue
if ($syncthing) {
  Start-Process -FilePath $syncthing.Source -ArgumentList '--no-browser' -WindowStyle Hidden
  exit 0
}

# Winget may update the package path before the app-execution alias reaches PATH.
$packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
$package = Get-ChildItem -LiteralPath $packageRoot -Directory -Filter 'Syncthing.Syncthing_*' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$binary = if ($package) {
  Get-ChildItem -LiteralPath $package.FullName -Recurse -Filter 'syncthing.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
}
if (-not $binary) { throw 'Syncthing is not installed.' }

Start-Process -FilePath $binary.FullName -ArgumentList '--no-browser' -WindowStyle Hidden
