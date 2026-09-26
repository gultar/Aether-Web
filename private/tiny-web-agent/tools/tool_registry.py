"""Central + loadable external tool registry."""
from __future__ import annotations

import ast
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml
from typing import Any

from runtime_paths import APP_DIR, RESOURCE_DIR
from tools.web_search import duckduckgo_search, visit_url
from tools.commands import run_powershell_command
from tools.cbc_news import cbc_top_stories
from tools.attachments import search_attachment

EXTERNAL_TOOLS_DIR = APP_DIR / "tools" / "external"
EXTERNAL_DEFINITIONS_DIR = EXTERNAL_TOOLS_DIR / "definitions"
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

BUILTIN_TOOL_REGISTRY: dict[str, dict[str, Any]] = {
    "direct_file_output": {
        "label": "Direct file output",
        "description": "Allow the model to create or completely overwrite text files using fenced ```file:path blocks. This capability does not use YAML tool arguments.",
        "enabled_by_default": False,
        "source": "built_in",
        "capability_only": True,
    },
    "duckduckgo_search": {
        "function": duckduckgo_search, "label": "Web search",
        "description": "Search the web for current or unknown information.", "enabled_by_default": True,
        "schema": {"type": "function", "function": {"name": "duckduckgo_search", "description": "Search the web for current or unknown information.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "The search query."}}, "required": ["query"]}}},
    },
    "visit_url": {
        "function": visit_url, "label": "Visit URL",
        "description": "Open a webpage and return text from it.", "enabled_by_default": False,
        "schema": {"type": "function", "function": {"name": "visit_url", "description": "Visit a specific URL and return information from the page.", "parameters": {"type": "object", "properties": {"url": {"type": "string", "description": "The URL to visit."}}, "required": ["url"]}}},
    },
    "run_powershell_command": {
        "function": run_powershell_command, "label": "PowerShell",
        "description": "Run a PowerShell command on the local computer. Non-zero exit codes do not discard stdout or stderr.", "enabled_by_default": False,
        "schema": {"type": "function", "function": {"name": "run_powershell_command", "description": "Run a PowerShell command and return its return code, stdout, and stderr. For recursive filesystem searches, inaccessible directories may write errors without making the whole search useless. When locating a known filename, prefer Get-ChildItem -Filter '<filename>' -File -Recurse -ErrorAction SilentlyContinue and Select-Object -ExpandProperty FullName. Do not remove -Recurse merely because a recursive search encountered an error.", "parameters": {"type": "object", "properties": {"cmd": {"type": "string", "description": "The PowerShell command to run. For recursive filesystem searches, use -ErrorAction SilentlyContinue when appropriate so inaccessible directories do not derail the search."}}, "required": ["cmd"]}}},
    },
    "cbc_top_stories": {
        "function": cbc_top_stories, "label": "CBC Top Stories",
        "description": "Fetch current top news headlines directly from CBC News' official RSS feed. Always fetch at least 10 stories. Use for current Canadian or general top-news requests when CBC is an appropriate source.", "enabled_by_default": True,
        "schema": {"type": "function", "function": {"name": "cbc_top_stories", "description": "Fetch current top stories from CBC News' official RSS feed. This tool always returns at least 10 stories; choose a limit from 10 to 25 when more are useful.", "parameters": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 10, "maximum": 25, "description": "Number of stories to return, from 10 to 25. Values below 10 are automatically raised to 10. Defaults to 10."}}, "required": []}}},
    },
    "search_attachment": {
        "function": search_attachment,
        "label": "Attachment search",
        "description": "Semantically search an attached PDF, DOCX, or text document and return only relevant excerpts.",
        "enabled_by_default": False,
        "schema": {
            "type": "function",
            "function": {
                "name": "search_attachment",
                "description": "Search a previously attached document by semantic meaning. Use this for follow-up questions about a PDF, DOCX, TXT, Markdown, HTML, CSV, JSON, or YAML attachment instead of requesting the entire file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "attachment_id": {"type": "string", "description": "The attachment id given in the conversation, such as att_abc123."},
                        "query": {"type": "string", "description": "The information to find in the document, expressed semantically."},
                        "top_k": {"type": "integer", "description": "Number of relevant excerpts to return, 1 to 10. Defaults to 4."}
                    },
                    "required": ["attachment_id", "query"]
                }
            }
        },
    },
}

TOOL_REGISTRY: dict[str, dict[str, Any]] = dict(BUILTIN_TOOL_REGISTRY)

EXTERNAL_TOOL_TEMPLATE = {
    "name": "my_tool",
    "file": "my_tool.py",
    "function": "my_tool",
    "label": "My Tool",
    "description": "Describe clearly when the model should use this tool.",
    "enabled_by_default": False,
    "timeout_seconds": 30,
    "parameters": {
        "type": "object",
        "properties": {"argument": {"type": "string", "description": "Describe this argument."}},
        "required": ["argument"],
    },
}


def _python_command() -> list[str] | None:
    override = os.environ.get("TINY_AGENT_TOOL_PYTHON", "").strip()
    if override:
        return [override]
    if not getattr(sys, "frozen", False):
        return [sys.executable]
    for candidate in (APP_DIR / "python.exe", APP_DIR / "tool_runtime" / "python.exe"):
        if candidate.is_file():
            return [str(candidate)]
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            return [found]
    if os.name == "nt":
        found = shutil.which("py")
        if found:
            return [found, "-3"]
    return None


def external_python_available() -> bool:
    return _python_command() is not None


def _runner_path() -> Path:
    return RESOURCE_DIR / "external_tool_runner.py"


def _find_external_script(filename: str) -> Path | None:
    """Find an external tool file in the writable folder or common legacy locations.

    Frozen builds use APP_DIR/tools/external as the canonical writable location.
    Older/source layouts may have the file in the current project's tools/external
    or in PyInstaller's resource tree. When found there, registration copies it
    into the canonical writable folder.
    """
    canonical = EXTERNAL_TOOLS_DIR / filename
    candidates = [
        canonical,
        Path.cwd() / "tools" / "external" / filename,
        RESOURCE_DIR / "tools" / "external" / filename,
    ]
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file():
            if candidate != canonical:
                EXTERNAL_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(candidate, canonical)
                return canonical
            return candidate
    return None


def _external_callable(script: Path, function_name: str, timeout: int):
    def call(**arguments: Any) -> str:
        command = _python_command()
        if command is None:
            raise RuntimeError("No Python runtime found for external tools. Install Python, place python.exe beside the app, or set TINY_AGENT_TOOL_PYTHON.")
        runner = _runner_path()
        if not runner.is_file():
            raise RuntimeError(f"External tool runner is missing: {runner}")
        completed = subprocess.run(
            [*command, str(runner), str(script), function_name],
            input=json.dumps(arguments, ensure_ascii=False), text=True,
            capture_output=True, timeout=max(1, timeout), cwd=str(script.parent),
        )
        raw = (completed.stdout or "").strip()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            raise RuntimeError((completed.stderr or raw or "External tool returned invalid output").strip())
        if not payload.get("ok"):
            raise RuntimeError(payload.get("error") or completed.stderr.strip() or "External tool failed")
        result = payload.get("result", "")
        return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    return call


def validate_external_definition(value: Any, *, require_file: bool = True) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Tool definition must be a JSON/YAML mapping.")
    definition = dict(value)
    for key in ("name", "file", "function", "description", "parameters"):
        if key not in definition:
            raise ValueError(f"Missing required field: {key}")
    name = str(definition["name"]).strip()
    function_name = str(definition["function"]).strip()
    filename = Path(str(definition["file"]).strip()).name
    if not _NAME_RE.fullmatch(name):
        raise ValueError("name must be a valid Python-style identifier")
    if not _NAME_RE.fullmatch(function_name):
        raise ValueError("function must be a valid Python identifier")
    if not filename.lower().endswith(".py"):
        raise ValueError("file must name a .py file inside tools/external")
    if name in BUILTIN_TOOL_REGISTRY:
        raise ValueError(f"'{name}' conflicts with a built-in tool")
    parameters = definition["parameters"]
    if not isinstance(parameters, dict) or parameters.get("type") != "object":
        raise ValueError("parameters must be a JSON Schema object with type='object'")
    script = _find_external_script(filename) if require_file else (EXTERNAL_TOOLS_DIR / filename)
    if require_file and script is None:
        raise ValueError(
            f"Python file not found. Expected: {EXTERNAL_TOOLS_DIR / filename}"
        )
    if require_file:
        assert script is not None
        try:
            tree = ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
        except (OSError, UnicodeError, SyntaxError) as error:
            raise ValueError(f"Unable to parse Python file: {error}") from error
        defined = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
        if function_name not in defined:
            raise ValueError(f"Function '{function_name}' was not found in {filename}")
    definition.update({
        "name": name, "file": filename, "function": function_name,
        "label": str(definition.get("label") or name.replace("_", " ").title()),
        "description": str(definition.get("description") or ""),
        "enabled_by_default": bool(definition.get("enabled_by_default", False)),
        "timeout_seconds": max(1, min(3600, int(definition.get("timeout_seconds", 30)))),
        "parameters": parameters,
    })
    return definition


def _entry_from_external(definition: dict[str, Any]) -> dict[str, Any]:
    script = EXTERNAL_TOOLS_DIR / definition["file"]
    return {
        "function": _external_callable(script, definition["function"], definition["timeout_seconds"]),
        "label": definition["label"], "description": definition["description"],
        "enabled_by_default": definition["enabled_by_default"], "source": "external",
        "file": definition["file"], "runtime_available": external_python_available(),
        "schema": {"type": "function", "function": {"name": definition["name"], "description": definition["description"], "parameters": definition["parameters"]}},
    }


def _parse_external_definition_text(text: str, *, suffix: str = "") -> Any:
    """Parse an external tool definition from JSON or YAML text."""
    suffix = suffix.lower()
    if suffix == ".json":
        return json.loads(text)
    if suffix in {".yaml", ".yml"}:
        return yaml.safe_load(text)

    # Definition text entered through the UI has no filename. Prefer JSON for
    # backward compatibility, then fall back to YAML.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return yaml.safe_load(text)


def reload_external_tools() -> list[str]:
    EXTERNAL_DEFINITIONS_DIR.mkdir(parents=True, exist_ok=True)
    EXTERNAL_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    TOOL_REGISTRY.clear(); TOOL_REGISTRY.update(BUILTIN_TOOL_REGISTRY)
    errors: list[str] = []

    definition_paths = sorted(
        path
        for path in EXTERNAL_DEFINITIONS_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in {".json", ".yaml", ".yml"}
    )

    for path in definition_paths:
        try:
            raw = _parse_external_definition_text(
                path.read_text(encoding="utf-8"),
                suffix=path.suffix,
            )
            definition = validate_external_definition(raw)
            TOOL_REGISTRY[definition["name"]] = _entry_from_external(definition)
        except Exception as error:
            errors.append(f"{path.name}: {type(error).__name__}: {error}")
    _refresh_legacy_exports()
    return errors


def register_external_tool_definition(definition_text: str) -> dict[str, Any]:
    EXTERNAL_DEFINITIONS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        raw = _parse_external_definition_text(definition_text)
    except (json.JSONDecodeError, yaml.YAMLError) as error:
        raise ValueError(f"Invalid JSON/YAML tool definition: {error}") from error

    definition = validate_external_definition(raw)

    # Keep UI-created definitions in JSON for backward compatibility. The
    # loader accepts .json, .yaml and .yml files equally.
    path = EXTERNAL_DEFINITIONS_DIR / f"{definition['name']}.json"
    path.write_text(json.dumps(definition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    errors = reload_external_tools()
    if definition["name"] not in TOOL_REGISTRY:
        raise RuntimeError("Definition was saved but the tool failed to reload: " + "; ".join(errors))
    return definition



def _definition_paths_for_name(name: str) -> list[Path]:
    safe = str(name or "").strip()
    return [EXTERNAL_DEFINITIONS_DIR / f"{safe}{suffix}" for suffix in (".yaml", ".yml", ".json")]


def _find_external_definition_path(name: str) -> Path | None:
    for path in _definition_paths_for_name(name):
        if path.is_file():
            return path
    return None


def _validate_python_bundle(code: str, definition: dict[str, Any]) -> None:
    if not isinstance(code, str) or not code.strip():
        raise ValueError("Python implementation is required.")
    filename = definition["file"]
    try:
        tree = ast.parse(code, filename=filename)
    except SyntaxError as error:
        raise ValueError(f"Python syntax error: {error}") from error
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
    }
    function_name = definition["function"]
    node = functions.get(function_name)
    if node is None:
        raise ValueError(f"Function '{function_name}' was not found in {filename}")

    parameters = definition.get("parameters") or {}
    properties = parameters.get("properties") or {}
    required = parameters.get("required") or []
    if not isinstance(properties, dict):
        raise ValueError("parameters.properties must be a mapping")
    if not isinstance(required, list) or any(x not in properties for x in required):
        raise ValueError("parameters.required must list only declared properties")

    accepted = {arg.arg for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]}
    has_kwargs = node.args.kwarg is not None
    unknown = [key for key in properties if key not in accepted and not has_kwargs]
    if unknown:
        raise ValueError(
            "Schema parameter(s) are not accepted by the Python function: " + ", ".join(unknown)
        )


def normalize_external_tool_bundle(definition_value: Any, code: str) -> tuple[dict[str, Any], str]:
    definition = validate_external_definition(definition_value, require_file=False)
    _validate_python_bundle(code, definition)
    yaml_text = yaml.safe_dump(
        definition,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    ).strip() + "\n"
    return definition, yaml_text


def list_external_tool_records() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    EXTERNAL_DEFINITIONS_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(EXTERNAL_DEFINITIONS_DIR.iterdir()):
        if not path.is_file() or path.suffix.lower() not in {".json", ".yaml", ".yml"}:
            continue
        try:
            raw = _parse_external_definition_text(path.read_text(encoding="utf-8"), suffix=path.suffix)
            definition = validate_external_definition(raw, require_file=False)
            name = definition["name"]
            if name in seen:
                continue
            seen.add(name)
            live = TOOL_REGISTRY.get(name)
            records.append({
                "name": name,
                "label": definition["label"],
                "description": definition["description"],
                "file": definition["file"],
                "function": definition["function"],
                "definition_file": path.name,
                "loaded": bool(live and live.get("source") == "external"),
                "runtime_available": bool((live or {}).get("runtime_available", external_python_available())),
            })
        except Exception as error:
            records.append({
                "name": path.stem,
                "label": path.stem,
                "description": f"Invalid definition: {type(error).__name__}: {error}",
                "definition_file": path.name,
                "loaded": False,
                "invalid": True,
            })
    return records


def read_external_tool_bundle(name: str) -> dict[str, Any]:
    path = _find_external_definition_path(name)
    if path is None:
        raise FileNotFoundError(f"External tool not found: {name}")
    raw = _parse_external_definition_text(path.read_text(encoding="utf-8"), suffix=path.suffix)
    definition = validate_external_definition(raw, require_file=False)
    script = _find_external_script(definition["file"])
    code = script.read_text(encoding="utf-8") if script and script.is_file() else ""
    normalized, yaml_text = normalize_external_tool_bundle(definition, code)
    return {
        "definition": normalized,
        "yaml": yaml_text,
        "code": code,
        "loaded": normalized["name"] in TOOL_REGISTRY,
        "definition_file": path.name,
    }


def save_external_tool_bundle(
    definition_value: Any,
    code: str,
    *,
    original_name: str | None = None,
) -> dict[str, Any]:
    definition, yaml_text = normalize_external_tool_bundle(definition_value, code)
    name = definition["name"]
    if original_name and name != original_name:
        raise ValueError("Changing a saved tool's name is not allowed. Use Save as New instead.")
    existing_path = _find_external_definition_path(name)
    if not original_name and existing_path is not None:
        raise FileExistsError(f"External tool already exists: {name}")
    if original_name and existing_path is None:
        raise FileNotFoundError(f"External tool not found: {original_name}")

    EXTERNAL_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    EXTERNAL_DEFINITIONS_DIR.mkdir(parents=True, exist_ok=True)
    py_path = EXTERNAL_TOOLS_DIR / definition["file"]
    yaml_path = EXTERNAL_DEFINITIONS_DIR / f"{name}.yaml"

    previous: dict[Path, bytes | None] = {}
    affected = {py_path, yaml_path, *_definition_paths_for_name(name)}
    for path in affected:
        previous[path] = path.read_bytes() if path.is_file() else None

    tmp_py = py_path.with_name(py_path.name + ".tmp")
    tmp_yaml = yaml_path.with_name(yaml_path.name + ".tmp")
    try:
        tmp_py.write_text(code.rstrip() + "\n", encoding="utf-8")
        tmp_yaml.write_text(yaml_text, encoding="utf-8")
        os.replace(tmp_py, py_path)
        os.replace(tmp_yaml, yaml_path)
        # YAML is canonical for Tool Editor-managed tools. Remove an older JSON/YML
        # definition only after the validated replacement is on disk.
        for other in _definition_paths_for_name(name):
            if other != yaml_path:
                other.unlink(missing_ok=True)
        errors = reload_external_tools()
        live = TOOL_REGISTRY.get(name)
        if not live or live.get("source") != "external":
            own = [e for e in errors if e.lower().startswith(name.lower() + ".")]
            raise RuntimeError("Tool failed to hot-load" + (": " + "; ".join(own or errors) if (own or errors) else ""))
    except Exception:
        for path, content in previous.items():
            try:
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
            except Exception:
                pass
        tmp_py.unlink(missing_ok=True)
        tmp_yaml.unlink(missing_ok=True)
        reload_external_tools()
        raise

    return {
        "definition": definition,
        "yaml": yaml_text,
        "code": code.rstrip() + "\n",
        "loaded": True,
        "warnings": errors,
    }


def delete_external_tool_bundle(name: str) -> dict[str, Any]:
    path = _find_external_definition_path(name)
    if path is None:
        raise FileNotFoundError(f"External tool not found: {name}")
    raw = _parse_external_definition_text(path.read_text(encoding="utf-8"), suffix=path.suffix)
    definition = validate_external_definition(raw, require_file=False)
    filename = definition["file"]
    for candidate in _definition_paths_for_name(name):
        candidate.unlink(missing_ok=True)

    # Delete the implementation only if no remaining external definition uses it.
    in_use = False
    for record_path in EXTERNAL_DEFINITIONS_DIR.iterdir():
        if not record_path.is_file() or record_path.suffix.lower() not in {".json", ".yaml", ".yml"}:
            continue
        try:
            other = _parse_external_definition_text(record_path.read_text(encoding="utf-8"), suffix=record_path.suffix)
            if isinstance(other, dict) and Path(str(other.get("file") or "")).name == filename:
                in_use = True
                break
        except Exception:
            continue
    if not in_use:
        (EXTERNAL_TOOLS_DIR / filename).unlink(missing_ok=True)
    reload_external_tools()
    return {"deleted": name, "file_deleted": not in_use}


def get_tool_descriptors() -> list[dict[str, Any]]:
    result = []
    for name, entry in TOOL_REGISTRY.items():
        schema_function = entry.get("schema", {}).get("function", {})
        result.append({
            "name": name, "label": str(entry.get("label") or name.replace("_", " ").title()),
            "description": str(entry.get("description") or schema_function.get("description") or ""),
            "enabled_by_default": bool(entry.get("enabled_by_default", True)),
            "source": entry.get("source", "built_in"),
            "file": entry.get("file"),
            "runtime_available": entry.get("runtime_available", True),
        })
    return result


def normalize_tool_overrides(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict): return {}
    return {name: bool(value[name]) for name in TOOL_REGISTRY if name in value}


def is_tool_enabled(settings: dict[str, Any] | None, name: str) -> bool:
    """Return whether a registered built-in/external capability is enabled."""
    settings = settings or {}
    if not bool(settings.get("tools_enabled", True)):
        return False
    entry = TOOL_REGISTRY.get(name)
    if entry is None:
        return False
    overrides = normalize_tool_overrides(settings.get("tool_overrides"))
    return overrides.get(name, bool(entry.get("enabled_by_default", True)))


def get_enabled_tool_bundle(settings: dict[str, Any] | None):
    settings = settings or {}
    if not bool(settings.get("tools_enabled", True)): return {}, []
    functions, schemas = {}, []
    for name, entry in TOOL_REGISTRY.items():
        if not is_tool_enabled(settings, name):
            continue
        # Capability-only entries (such as direct fenced file output) appear in
        # the Tools UI but are handled by the agent itself rather than emitted
        # as YAML-callable functions.
        function = entry.get("function")
        schema = entry.get("schema")
        if callable(function) and isinstance(schema, dict):
            functions[name] = function
            schemas.append(schema)
    return functions, schemas


def _refresh_legacy_exports() -> None:
    global tool_functions, tools
    tool_functions = {
        name: e["function"]
        for name, e in TOOL_REGISTRY.items()
        if bool(e.get("enabled_by_default", True)) and callable(e.get("function"))
    }
    tools = [
        e["schema"]
        for e in TOOL_REGISTRY.values()
        if bool(e.get("enabled_by_default", True)) and isinstance(e.get("schema"), dict)
    ]


tool_functions: dict[str, Any] = {}
tools: list[dict[str, Any]] = []
reload_external_tools()
