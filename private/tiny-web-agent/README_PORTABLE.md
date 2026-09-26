# Portable / single-EXE build

The application is intentionally shipped **without a model** and without a hard-coded model path.
A fresh database creates its first conversation with no model selected. On first launch, Settings opens and the user must explicitly choose a `.gguf` model before Send is enabled.

## Build `TinyLocalAgent.exe`

Use the same Python environment in which your CUDA-enabled `llama-cpp-python` already works, then run:

```bat
build_exe.bat
```

The script:

1. keeps your existing `llama-cpp-python` installation rather than replacing it with a CPU build;
2. installs PyInstaller and the web/tool dependencies;
3. installs Playwright Chromium with `PLAYWRIGHT_BROWSERS_PATH=0` so it can be bundled;
4. builds `dist\TinyLocalAgent.exe`.

The `.gguf` is **not** included in the EXE.

On the target Windows computer, copy `TinyLocalAgent.exe` anywhere writable and launch it. The app creates:

```text
TinyLocalAgent.exe
data\
    chat.db
```

Use **Settings > Browse…** to choose a GGUF. The selected absolute path is stored in `data\chat.db`.

The target computer does not need Python. NVIDIA GPU inference still requires a compatible NVIDIA driver.

## Easier diagnostic build

If the one-file build has a missing-DLL/browser problem, run `build_folder.bat`. It creates an inspectable `dist\TinyLocalAgentFolder\` build first.

## Markdown

Assistant responses are stored as raw Markdown in SQLite. The server renders them with Mistune using raw-HTML escaping. During token streaming the UI shows the unfinished Markdown as text; when generation completes it swaps to rendered Markdown. Reopened conversations are rendered immediately.

## Model selection notes

The app ships with no model path. Add or browse to a `.gguf` file after launch.
Selecting a model from either dropdown is persisted immediately for the active
conversation. Windows paths using either `C:\Models\model.gguf` or
`D:/Models/model.gguf` are accepted.

## Model picker / settings reliability update

Browse now opens a native file picker on the machine running Tiny Local Agent. The chosen GGUF is registered by its absolute path and selected automatically; it is not copied. Add path remains available for registering an existing GGUF or folder manually. Conversation settings are saved atomically through a dedicated POST endpoint together with the selected model.

## External tools after packaging

The core EXE remains self-contained. Optional user-added Python tools live outside it under:

```text
tools/
  external/
    my_tool.py
    definitions/
      my_tool.json
```

Creating/registering an external tool does not require rebuilding `TinyLocalAgent.exe`. Executing such a tool does require an external Python runtime; the app can use a `python.exe` placed beside the EXE, `tool_runtime/python.exe`, or Python on PATH. Built-in tools continue to work without this external runtime.

## Windows/PyInstaller llama.cpp preload

The build includes `pyi_rth_llama_first.py`, which preloads `llama_cpp` before
other application packages in frozen builds. This avoids a Windows/PyInstaller
class of native access violations reported when other packages initialize first.
