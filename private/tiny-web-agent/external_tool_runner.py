from __future__ import annotations

import importlib.util
import json
import sys
import traceback
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "runner expects <script> <function>"}))
        return 2
    script = Path(sys.argv[1]).resolve()
    function_name = sys.argv[2]
    try:
        arguments = json.loads(sys.stdin.read() or "{}")
        if not isinstance(arguments, dict):
            raise TypeError("Tool arguments must be a JSON object")
        spec = importlib.util.spec_from_file_location(f"tiny_external_{script.stem}", script)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Unable to load {script}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        function = getattr(module, function_name)
        result = function(**arguments)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, default=str))
        return 0
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc(limit=8),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
