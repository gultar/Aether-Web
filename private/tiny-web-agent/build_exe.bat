@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo Tiny Local Web Agent - single EXE build
echo ============================================================
echo.

python -c "import llama_cpp; print('llama-cpp-python:', llama_cpp.__file__)" >nul 2>&1
if errorlevel 1 (
    echo ERROR: llama-cpp-python is not installed in this Python environment.
    echo Install the CUDA-enabled build that already works on this computer,
    echo then run build_exe.bat again.
    pause
    exit /b 1
)

echo [1/4] Installing packaging/runtime dependencies...
python -m pip install pyinstaller -r requirements_web.txt
if errorlevel 1 goto :fail

echo.
echo [2/4] Installing Chromium inside the Playwright package...
set PLAYWRIGHT_BROWSERS_PATH=0
python -m playwright install chromium
if errorlevel 1 goto :fail

echo.
echo [3/4] Building TinyLocalAgent.exe...
echo       FastEmbed/ONNX semantic retrieval is included; Torch/Transformers remain excluded.
python -m PyInstaller --noconfirm --clean TinyLocalAgent.spec
if errorlevel 1 goto :fail

echo.
echo [4/4] Build complete.
echo.
echo Output:
echo   %CD%\dist\TinyLocalAgent.exe
echo.
echo No GGUF is bundled. Copy only TinyLocalAgent.exe to the target computer.
echo On first launch, the app will require the user to browse for a .gguf model.
echo Conversations will be stored in a data folder beside the EXE.
echo.
pause
exit /b 0

:fail
echo.
echo BUILD FAILED.
pause
exit /b 1
