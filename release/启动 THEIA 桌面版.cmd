@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "app\node_modules\electron" (
  echo [THEIA] Missing dependencies. Open a terminal in the app folder and run: npm install
  pause
  exit /b 1
)

rem Stop only the previous THEIA release instance recorded in this release folder.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$pidFile = Join-Path $PWD 'data\runtime\desktop.pid'; if (Test-Path -LiteralPath $pidFile) { $id = [int](Get-Content -LiteralPath $pidFile -Raw); $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'electron') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }; Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue" >nul 2>&1

call npm --prefix "%~dp0app" run desktop:release
