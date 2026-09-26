"""PyInstaller runtime hook: preload llama.cpp before third-party application imports.

On Windows, llama-cpp-python has had access-violation reports in frozen apps
where another third-party/native package is imported first. A user runtime hook
runs before the main script, so force llama_cpp and its native libraries to be
initialized at the earliest safe point.
"""
try:
    import llama_cpp  # noqa: F401
    print(f"[Runtime] llama-cpp-python preloaded: {llama_cpp.__file__}")
except Exception as error:
    print(f"[Runtime] llama_cpp preload failed: {type(error).__name__}: {error}")
    raise
