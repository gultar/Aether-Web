@echo off
setlocal
set "EXT=%LOCALAPPDATA%\BrowserOS\outlook-companion-extension"
if not exist "%EXT%\manifest.json" (
  echo BrowserOS has not prepared the Outlook Companion extension yet.
  echo.
  echo 1. Start BrowserOS once.
  echo 2. Then run this file again.
  echo.
  pause
  exit /b 1
)
echo Extension folder:
echo %EXT%
echo.
start "" explorer.exe "%EXT%"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "edge://extensions/"
echo In Chrome or Edge:
echo   1. Turn on Developer mode.
echo   2. Click Load unpacked.
echo   3. Select the folder shown above.
echo   4. Reload the BrowserOS tab once.
echo.
pause
