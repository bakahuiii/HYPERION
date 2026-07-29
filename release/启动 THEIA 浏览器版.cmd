@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "app\node_modules" (
  echo [THEIA] Missing dependencies. Open a terminal in the app folder and run: npm install
  pause
  exit /b 1
)

call npm --prefix "%~dp0app" run dev:release
