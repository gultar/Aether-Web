# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

import playwright
from PyInstaller.utils.hooks import collect_all


datas = [
    ("templates", "templates"),
    ("static", "static"),
    ("external_tool_runner.py", "."),
    ("skills", "skills"),
]
binaries = []
hiddenimports = ["llama_cpp.llama_cpp"]

# llama-cpp-python carries native ggml/llama/CUDA DLLs. Playwright carries its
# Node driver and, after build_exe.bat installs it with PLAYWRIGHT_BROWSERS_PATH=0,
# the local Chromium browser. collect_all keeps those package assets together.
for package in ("llama_cpp", "playwright", "greenlet", "ddgs", "mistune", "yaml", "fastembed", "onnxruntime", "numpy", "pypdf", "docx"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries

    # Keep package assets/native DLLs for a genuinely portable build, but do not
    # force PyInstaller to analyze optional llama-cpp-python features that this
    # app never imports. Those optional branches can pull in the entire Hugging
    # Face / scientific Python stack (Transformers, Torch, SciPy, etc.).
    if package == "llama_cpp":
        package_hidden = [
            name for name in package_hidden
            if not (
                name == "llama_cpp.llama_embedding"
                or name.startswith("llama_cpp.server")
            )
        ]

    hiddenimports += package_hidden


# PLAYWRIGHT_BROWSERS_PATH=0 installs Chromium here. Add it explicitly so
# the one-file build contains the browser even if generic data collection
# changes between PyInstaller versions.
playwright_dir = Path(playwright.__file__).resolve().parent
local_browsers = playwright_dir / "driver" / "package" / ".local-browsers"
if local_browsers.exists():
    datas.append((str(local_browsers), "playwright/driver/package/.local-browsers"))
else:
    print("WARNING: Playwright local browser directory not found:", local_browsers)
    print("Run build_exe.bat so Chromium is installed before PyInstaller starts.")


a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["pyi_rth_llama_first.py"],
    excludes=[
        # Optional ML/scientific stacks are not used by Tiny Local Web Agent's
        # GGUF inference path. Excluding them prevents PyInstaller hooks from
        # recursively collecting packages installed in the build environment.
        "torch",
        "transformers",
        "sentence_transformers",
        "scipy",
        "sklearn",
        "pandas",
        "pyarrow",
        "tensorflow",
        "faiss",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="TinyLocalAgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
