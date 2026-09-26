@echo off
cd /d "%~dp0"
start "" node server.js
timeout /t 2 /nobreak >nul
start "" chrome.exe http://127.0.0.1:8001
