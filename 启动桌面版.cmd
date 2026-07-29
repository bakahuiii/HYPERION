@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem End the desktop process recorded by this project before dropping the PID
rem marker. The path fallback handles launches that ended before writing it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$pidFile = Join-Path $PWD '.theia-desktop.pid'; $expectedPath = [IO.Path]::GetFullPath((Join-Path $PWD 'node_modules\electron\dist\electron.exe')); if (Test-Path -LiteralPath $pidFile) { $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw); $saved = Get-Process -Id $savedPid -ErrorAction SilentlyContinue; if ($saved -and $saved.Path -eq $expectedPath) { Stop-Process -Id $saved.Id -Force -ErrorAction SilentlyContinue } }; Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $expectedPath } | Stop-Process -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue" >nul 2>&1

rem Port 8787 belongs exclusively to THEIA's local API. WMI command-line
rem inspection is unavailable on some Windows installs, so identify the old
rem listener through netstat and stop only a Node/Electron owner of this port.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$owners = @(netstat -ano -p tcp | Select-String '(?:127\.0\.0\.1|0\.0\.0\.0):8787\s+.*LISTENING\s+(\d+)$' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } | Select-Object -Unique); foreach ($owner in $owners) { $process = Get-Process -Id $owner -ErrorAction SilentlyContinue; if ($process -and $process.ProcessName -in @('node','electron')) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue } }" >nul 2>&1

rem Give Electron time to release both the local API port and Chromium's
rem single-instance profile lock before the replacement process is created.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "for ($attempt = 0; $attempt -lt 15; $attempt++) { $listening = netstat -ano -p tcp | Select-String '(?:127\.0\.0\.1|0\.0\.0\.0):8787\s+.*LISTENING'; if (-not $listening) { break }; Start-Sleep -Milliseconds 200 }; Start-Sleep -Milliseconds 1200" >nul 2>&1
call npm run desktop
