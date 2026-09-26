"""Primary launcher for Tiny Local Web Agent."""

# IMPORTANT ON WINDOWS/PYINSTALLER:
# Keep llama_cpp as the first third-party import. The frozen builds also use
# pyi_rth_llama_first.py so the native runtime is initialized before the app.
from llama_cpp import Llama as _PreloadLlama  # noqa: F401

import os
import sys

from runtime_paths import APP_DIR

# Relative paths used by tools should resolve beside the portable executable.
os.chdir(APP_DIR)

from web_main import main


if __name__ == "__main__":
    main()
