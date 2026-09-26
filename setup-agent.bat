@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Browser-OS Tiny Web Agent Setup

echo ============================================================
echo Browser-OS - Tiny Web Agent Python setup
echo ============================================================
echo.

echo [1/5] Finding Python...
set "PYEXE="

if defined TINY_AGENT_PYTHON (
  if exist "%TINY_AGENT_PYTHON%" (
    "%TINY_AGENT_PYTHON%" -c "import sys; print(sys.executable)" >nul 2>&1
    if not errorlevel 1 set "PYEXE=%TINY_AGENT_PYTHON%"
  )
)

if not defined PYEXE (
  for /f "usebackq delims=" %%P in (`python -c "import sys; print(sys.executable)" 2^>nul`) do if not defined PYEXE set "PYEXE=%%P"
)

if not defined PYEXE goto :nopython
if not exist "%PYEXE%" goto :nopython

echo       Using: %PYEXE%
"%PYEXE%" --version
if errorlevel 1 goto :nopython

echo.
echo [2/5] Checking pip...
"%PYEXE%" -m pip --version
if errorlevel 1 (
  echo pip is missing. Attempting ensurepip...
  "%PYEXE%" -m ensurepip --upgrade
  if errorlevel 1 goto :failed
)

echo.
echo [3/5] Installing/updating Tiny Web Agent dependencies...
"%PYEXE%" -m pip install -r "%~dp0private\tiny-web-agent\requirements_web.txt"
if errorlevel 1 goto :failed

echo.
echo [4/5] Checking the runtime, including llama-cpp-python...
"%PYEXE%" -c "import flask, yaml, ddgs, fastembed, llama_cpp; print('Runtime imports OK'); print('Python:', __import__('sys').executable); print('llama-cpp-python:', getattr(llama_cpp, '__version__', 'installed'))"
if errorlevel 1 goto :llamafailed

echo.
echo [5/5] Saving the Python executable for Browser-OS...
if not exist "%~dp0config" mkdir "%~dp0config"
> "%~dp0config\tiny-agent-python.txt" echo %PYEXE%
if errorlevel 1 goto :failed

echo       Saved: %~dp0config\tiny-agent-python.txt
echo.
echo ============================================================
echo Setup complete.
echo Browser-OS will now use this Python automatically:
echo %PYEXE%
echo ============================================================
echo.
echo You can close this window and restart Browser-OS.
pause
exit /b 0

:nopython
echo.
echo ERROR: A working python.exe could not be found.
echo.
echo `py.exe` is NOT required. Browser-OS can use `python.exe` directly.
echo In PowerShell, verify that this works:
echo     python --version
echo     python -c "import sys; print(sys.executable)"
echo.
pause
exit /b 1

:llamafailed
echo.
echo ERROR: The selected Python environment cannot import one of the required modules.
echo The most important one for model execution is llama_cpp.
echo.
echo Browser-OS does not replace your CUDA-enabled llama-cpp-python automatically.
echo Run this command to see the exact failing import:
echo     "%PYEXE%" -c "import flask, yaml, ddgs, fastembed, llama_cpp"
echo.
echo If llama_cpp is the failing module, use the Python environment where your

echo existing CUDA-enabled llama-cpp-python is installed, then rerun this setup.
pause
exit /b 1

:failed
echo.
echo ERROR: Tiny Web Agent setup failed. See the command output above.
echo Python selected: %PYEXE%
pause
exit /b 1
