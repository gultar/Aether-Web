@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "PYEXE="
if defined TINY_AGENT_PYTHON set "PYEXE=%TINY_AGENT_PYTHON%"
if not defined PYEXE if exist "%~dp0..\..\config\tiny-agent-python.txt" set /p PYEXE=<"%~dp0..\..\config\tiny-agent-python.txt"
if not defined PYEXE for /f "usebackq delims=" %%P in (`python -c "import sys; print(sys.executable)" 2^>nul`) do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE (
  echo No working python.exe was found. Run ..\..\setup-agent.bat first.
  pause
  exit /b 1
)
echo Using Python: %PYEXE%
"%PYEXE%" main.py
pause
