@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo Browser-OS build: dual-context-v9.12.3-scheduled-history-clear
echo ============================================================
netstat -ano | findstr /R /C:":8001 .*LISTENING" >nul
if %errorlevel%==0 (
  echo.
  echo ERROR: Port 8001 is already in use.
  echo An older Browser-OS server may still be running.
  echo Stop the old npm/node process, then run this file again.
  echo.
  pause
  exit /b 1
)
npm start
