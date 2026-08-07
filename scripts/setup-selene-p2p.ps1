[CmdletBinding()]
param(
  [string]$InboxDirectory,
  [switch]$InstallSyncthing,
  [switch]$ConfigureSyncthingFolder,
  [switch]$RegisterStartAtLogon
)

$ErrorActionPreference = 'Stop'
$hyperionRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $hyperionRoot)
$defaultInbox = Join-Path $workspaceRoot 'SELENE-Inbox'
$inbox = [IO.Path]::GetFullPath($(if ($InboxDirectory) { $InboxDirectory } else { $defaultInbox }))

New-Item -ItemType Directory -Force -Path $inbox | Out-Null
[Environment]::SetEnvironmentVariable('HYPERION_SELENE_INBOX', $inbox, 'User')
$env:HYPERION_SELENE_INBOX = $inbox

function Find-SyncthingBinary {
  $command = Get-Command syncthing -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $process = Get-Process syncthing -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($process -and $process.Path) { return $process.Path }

  $packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  $package = Get-ChildItem -LiteralPath $packageRoot -Directory -Filter 'Syncthing.Syncthing_*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $package) { return $null }
  return Get-ChildItem -LiteralPath $package.FullName -Recurse -Filter 'syncthing.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}

$syncthingInstalledThisRun = $false
$syncthingPath = Find-SyncthingBinary
if ($InstallSyncthing -and -not $syncthingPath) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'winget is required to install Syncthing automatically.' }
  & $winget.Source install --id Syncthing.Syncthing --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw 'Syncthing installation failed.' }
  $syncthingInstalledThisRun = $true
  $syncthingPath = Find-SyncthingBinary
}

$startupShortcutName = 'HYPERION SELENE P2P Syncthing.lnk'
if ($RegisterStartAtLogon) {
  $starter = Join-Path $PSScriptRoot 'start-selene-syncthing.ps1'
  if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) { throw 'Syncthing startup helper is missing.' }
  $startupDirectory = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startupDirectory $startupShortcutName
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$starter`""
  $shortcut.WorkingDirectory = $hyperionRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Starts Syncthing for the local SELENE P2P inbox after this user signs in.'
  $shortcut.Save()
}

$syncthingFolderId = 'selene-inbox-v1'
if ($ConfigureSyncthingFolder) {
  if (-not $syncthingPath) { throw 'Install Syncthing before configuring the receive-only folder.' }
  if (-not (Get-Process syncthing -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $syncthingPath -ArgumentList '--no-browser' -WindowStyle Hidden
  }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $folderIds = & $syncthingPath cli config folders list 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { throw 'Syncthing did not become ready within 30 seconds.' }

  if ($folderIds -notcontains $syncthingFolderId) {
    & $syncthingPath cli config folders add --id $syncthingFolderId --label 'SELENE Inbox' --path $inbox --type receiveonly
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Syncthing receive-only folder.' }
  } else {
    $folder = (& $syncthingPath cli config folders $syncthingFolderId dump-json | ConvertFrom-Json)
    if ([IO.Path]::GetFullPath($folder.path) -ne $inbox -or $folder.type -ne 'receiveonly') {
      throw "Syncthing folder '$syncthingFolderId' already exists with a different path or mode."
    }
  }
}

Write-Output "HYPERION_SELENE_INBOX=$inbox"
Write-Output 'Restart HYPERION after this command so its server inherits the user environment variable.'
if ($RegisterStartAtLogon) { Write-Output "Registered current-user startup shortcut: $startupShortcutName" }
if ($ConfigureSyncthingFolder) { Write-Output "Configured Syncthing receive-only folder: $syncthingFolderId" }
if ($syncthingPath) {
  Write-Output "Syncthing=$syncthingPath"
  Write-Output 'Open SELENE Windows and generate its one-time Android pairing QR; manual Syncthing UI pairing is no longer required.'
} elseif ($syncthingInstalledThisRun) {
  Write-Output 'Syncthing was installed successfully. Open SELENE Windows and generate its one-time Android pairing QR.'
} else {
  Write-Output 'Syncthing is not installed. Re-run with -InstallSyncthing or install Syncthing.Syncthing through winget.'
}
