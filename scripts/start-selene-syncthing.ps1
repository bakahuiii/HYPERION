[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$hyperionRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $hyperionRoot)

function Start-Iris {
  $irisRoot = Join-Path $workspaceRoot 'IRIS'
  $irisEntry = Join-Path $irisRoot 'src\index.mjs'
  if (-not (Test-Path -LiteralPath $irisEntry)) { return }

  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodePath = if ($node) { $node.Source } else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
  if (-not (Test-Path -LiteralPath $nodePath)) { return }

  Start-Process -FilePath $nodePath -ArgumentList 'src/index.mjs' -WorkingDirectory $irisRoot -WindowStyle Hidden
}

function Start-SeleneWindows {
  if (Get-Process SELENE.Windows -ErrorAction SilentlyContinue) { return }

  $seleneRoot = if ($env:HYPERION_SELENE_WINDOWS_HOME) {
    [IO.Path]::GetFullPath($env:HYPERION_SELENE_WINDOWS_HOME)
  } else {
    $releaseRoot = Join-Path $workspaceRoot 'SELENE\releases'
    Get-ChildItem -LiteralPath $releaseRoot -Directory -Filter 'v*' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'published\windows-x64' } |
      Where-Object { Test-Path -LiteralPath (Join-Path $_ 'SELENE.Windows.exe') -PathType Leaf } |
      Select-Object -First 1
  }
  if (-not $seleneRoot) { return }
  $seleneExe = Join-Path $seleneRoot 'SELENE.Windows.exe'
  if (-not (Test-Path -LiteralPath $seleneExe)) { return }

  Start-Process -FilePath $seleneExe -ArgumentList '--minimized' -WorkingDirectory $seleneRoot -WindowStyle Hidden
}

function Start-Syncthing {
  if (Get-Process syncthing -ErrorAction SilentlyContinue) { return }

  $syncthing = Get-Command syncthing -ErrorAction SilentlyContinue
  if ($syncthing) {
    Start-Process -FilePath $syncthing.Source -ArgumentList '--no-browser' -WindowStyle Hidden
    return
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
}

Start-Iris
Start-SeleneWindows
Start-Syncthing
