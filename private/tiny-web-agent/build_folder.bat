@echo off
setlocal
cd /d "%~dp0"
python -m pip install pyinstaller -r requirements_web.txt
if errorlevel 1 goto :fail
set PLAYWRIGHT_BROWSERS_PATH=0
python -m playwright install chromium
if errorlevel 1 goto :fail
python -m PyInstaller --noconfirm --clean --onedir --console --name TinyLocalAgentFolder --collect-all llama_cpp --collect-all playwright --collect-all greenlet --collect-all ddgs --collect-all mistune --collect-all yaml --collect-all fastembed --collect-all onnxruntime --collect-all numpy --collect-all pypdf --collect-all docx --exclude-module torch --exclude-module transformers --exclude-module sentence_transformers --exclude-module scipy --exclude-module sklearn --exclude-module pandas --exclude-module pyarrow --exclude-module tensorflow --exclude-module faiss --hidden-import llama_cpp.llama_cpp --runtime-hook pyi_rth_llama_first.py --add-data "templates;templates" --add-data "static;static" main.py
if errorlevel 1 goto :fail
echo Build complete: dist\TinyLocalAgentFolder\
pause
exit /b 0
:fail
echo BUILD FAILED.
pause
exit /b 1
