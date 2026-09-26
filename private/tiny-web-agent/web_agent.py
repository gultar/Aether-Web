from __future__ import annotations

import gc
import inspect
import os
import re
import subprocess
import struct
import threading
import time
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any, Callable

import yaml
from llama_cpp import Llama, llama_cpp

from conversation_compactor import compact_conversation_if_needed, estimate_message_tokens
from tools.tool_registry import get_enabled_tool_bundle, is_tool_enabled

EventCallback = Callable[[str, dict[str, Any]], None]
FileOverwriteCallback = Callable[[str], bool]

# llama-cpp-python accepts ggml_type enum values as integers for type_k/type_v.
# These values come from llama.cpp's ggml_type enum.
KV_TYPES = {
    "f16": 1,
    "q4_0": 2,
    "q5_0": 6,
    "q8_0": 8,
}

# Used whenever Settings does not explicitly specify a KV cache type.
KV_CACHE_TYPE = "q8_0"
IS_VERBOSE = True

# Keep the primary model resident while it is actively useful, then release its
# weights/KV buffers after five minutes with no completed inference activity.
# Set TINY_AGENT_IDLE_UNLOAD_SECONDS=0 to disable this behavior if needed.
try:
    PRIMARY_IDLE_UNLOAD_SECONDS = max(0, int(os.environ.get("TINY_AGENT_IDLE_UNLOAD_SECONDS", "300")))
except (TypeError, ValueError):
    PRIMARY_IDLE_UNLOAD_SECONDS = 300


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in {"0", "false", "off", "no"}


# Lightweight NVIDIA VRAM governor. It learns the actual VRAM delta of the
# currently selected model/settings and only reacts to *additional* pressure,
# so a large model does not evict itself merely because it uses VRAM.
VRAM_GOVERNOR_ENABLED = _env_bool("TINY_AGENT_VRAM_GOVERNOR", True)
VRAM_GOVERNOR_GPU_INDEX = _env_int("TINY_AGENT_VRAM_GPU_INDEX", 0)
VRAM_GOVERNOR_POLL_SECONDS = _env_int("TINY_AGENT_VRAM_POLL_SECONDS", 5, 1)
VRAM_GOVERNOR_RESERVE_MB = _env_int("TINY_AGENT_VRAM_RESERVE_MB", 700, 128)
VRAM_GOVERNOR_PRESSURE_DROP_MB = _env_int("TINY_AGENT_VRAM_PRESSURE_DROP_MB", 384, 64)
VRAM_GOVERNOR_PRESSURE_SECONDS = _env_int("TINY_AGENT_VRAM_PRESSURE_SECONDS", 15, 1)
VRAM_GOVERNOR_PROCESS_TRIGGER = _env_bool("TINY_AGENT_VRAM_PROCESS_TRIGGER", True)
VRAM_GOVERNOR_PROCESS_SECONDS = _env_int("TINY_AGENT_VRAM_PROCESS_SECONDS", 10, 1)
VRAM_GOVERNOR_RECOVERY_SECONDS = _env_int("TINY_AGENT_VRAM_RECOVERY_SECONDS", 20, 1)

# Pre-load GGUF GPU-layer planner. This inspects only the GGUF header/tensor
# directory; it never constructs a llama.cpp model just to discover layer count.
GPU_LAYER_PLANNER_ENABLED = _env_bool("TINY_AGENT_AUTO_GPU_LAYERS", True)
GPU_LAYER_PLANNER_RESERVE_MB = _env_int("TINY_AGENT_GPU_LAYER_RESERVE_MB", 256, 64)
GPU_LAYER_PLANNER_OVERHEAD_MB = _env_int("TINY_AGENT_GPU_LAYER_OVERHEAD_MB", 96, 0)
GPU_LAYER_PLANNER_WEIGHT_FACTOR_PERCENT = _env_int("TINY_AGENT_GPU_LAYER_WEIGHT_FACTOR_PERCENT", 106, 100)

def _resolve_kv_cache_type(settings: dict[str, Any]) -> tuple[str, int]:
    """Return the normalized KV-cache name and llama.cpp ggml_type value."""
    raw = settings.get("kv_cache")

    # Missing/None/"default" means use this application's configured default.
    if raw is None:
        name = KV_CACHE_TYPE
    else:
        name = str(raw).strip().lower()
        if name in {"", "default", "auto"}:
            name = KV_CACHE_TYPE

    aliases = {
        "q8": "q8_0",
        "q5": "q5_0",
        "q4": "q4_0",
        "fp16": "f16",
    }
    name = aliases.get(name, name)

    try:
        return name, KV_TYPES[name]
    except KeyError as exc:
        supported = ", ".join(KV_TYPES)
        raise ValueError(
            f"Unsupported KV cache type {raw!r}. "
            f"Supported values: {supported}."
        ) from exc


def _emit(callback: EventCallback | None, event: str, **payload: Any) -> None:
    if callback is not None:
        callback(event, payload)


YAML_TOOL_BLOCK_RE = re.compile(
    # Small local models sometimes indent fences or emit ````` yaml`` with a
    # space before the language tag. Escaped backticks are normalized before
    # this expression is applied.
    r"(?im)^[ \t]*`{3}[ \t]*ya?ml[ \t]*\r?\n"
    r"(?P<body>.*?)"
    r"(?im:^[ \t]*`{3}[ \t]*$)",
    flags=re.DOTALL,
)

RAW_TOOL_START_RE = re.compile(r"^\s*tool\s*:\s*\S.+$", re.IGNORECASE)
RAW_ARGUMENTS_RE = re.compile(r"^\s*arguments\s*:", re.IGNORECASE)


class ToolCallYAMLLoader(yaml.SafeLoader):
    """Safe YAML loader that keeps dates and colon-form times as strings.

    PyYAML's YAML 1.1 implicit resolvers normally turn ``2026-08-27`` into a
    ``datetime.date`` and ``18:00`` into the sexagesimal integer ``1080``.
    Those conversions are surprising for LLM-authored tool arguments and also
    break JSON transport to external tools, so tool calls use a narrower set
    of implicit scalar conversions.
    """


ToolCallYAMLLoader.yaml_implicit_resolvers = {
    key: list(value)
    for key, value in yaml.SafeLoader.yaml_implicit_resolvers.items()
}

# Keep ISO-looking dates as ordinary strings.
for _key, _resolvers in list(ToolCallYAMLLoader.yaml_implicit_resolvers.items()):
    ToolCallYAMLLoader.yaml_implicit_resolvers[_key] = [
        item for item in _resolvers if item[0] != "tag:yaml.org,2002:timestamp"
    ]

# Replace YAML 1.1's integer resolver so HH:MM values are not interpreted as
# sexagesimal integers (for example 18:00 -> 1080). Normal integer literals
# still become Python ints.
for _key, _resolvers in list(ToolCallYAMLLoader.yaml_implicit_resolvers.items()):
    ToolCallYAMLLoader.yaml_implicit_resolvers[_key] = [
        item for item in _resolvers if item[0] != "tag:yaml.org,2002:int"
    ]

_TOOL_INT_RE = re.compile(
    r"^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+)$"
)
ToolCallYAMLLoader.add_implicit_resolver(
    "tag:yaml.org,2002:int",
    _TOOL_INT_RE,
    list("-+0123456789"),
)

# Whole-file output protocol for small local models. The model writes the file
# body as ordinary generated text instead of nesting it inside a tool argument.
# Example:
#   ```file:C:\\project\\hello.py
#   print("hello")
#   ```
FILE_BLOCK_RE = re.compile(
    r"```file:[ \t]*(?P<path>[^\r\n]+)\r?\n(?P<content>.*?)\r?\n```",
    flags=re.DOTALL | re.IGNORECASE,
)


def parse_file_blocks(text: str) -> list[tuple[str, str]]:
    """Return ``(path, content)`` pairs from fenced whole-file blocks."""
    blocks: list[tuple[str, str]] = []
    for match in FILE_BLOCK_RE.finditer(text):
        path = match.group("path").strip()
        content = match.group("content")
        if path:
            blocks.append((path, content))
    return blocks


def write_file_block(
    path_text: str,
    content: str,
    confirm_overwrite: FileOverwriteCallback | None = None,
) -> dict[str, Any]:
    """Write one whole-file block and return structured status for the model."""
    try:
        expanded = os.path.expandvars(os.path.expanduser(path_text.strip()))
        path = Path(expanded)
        if not path.is_absolute():
            path = Path.cwd() / path
        path = path.resolve(strict=False)

        if path.exists():
            if confirm_overwrite is None or not confirm_overwrite(str(path)):
                return {
                    "ok": False,
                    "cancelled": True,
                    "path": str(path),
                    "error": "Overwrite cancelled by user. Do not attempt to overwrite this file again unless the user explicitly asks.",
                }

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return {
            "ok": True,
            "path": str(path),
            "characters": len(content),
            "bytes": len(content.encode("utf-8")),
        }
    except Exception as error:
        return {
            "ok": False,
            "path": path_text,
            "error": f"{type(error).__name__}: {error}",
        }


def _tool_yaml_candidates(text: str) -> list[tuple[str, str]]:
    """Return candidate ``(source, yaml_text)`` tool mappings from model text.

    Fenced YAML is preferred. Backslash-escaped Markdown backticks are
    normalized because small models occasionally emit escaped Markdown fences before ``yaml``. A very
    conservative raw-YAML fallback accepts only a top-level ``tool:`` line
    immediately followed by ``arguments:`` plus any indented argument lines.
    """
    # Normalizing escaped backticks is safe for parsing because we only use the
    # normalized copy to discover tool candidates; the original response is
    # still retained in conversation/output.
    normalized = text.replace(r"\`", "`")
    candidates: list[tuple[int, str, str]] = []
    covered_spans: list[tuple[int, int]] = []

    for match in YAML_TOOL_BLOCK_RE.finditer(normalized):
        body = match.group("body").strip()
        if body:
            candidates.append((match.start(), "fenced", body))
            covered_spans.append(match.span())

    lines = normalized.splitlines(keepends=True)
    offsets: list[int] = []
    cursor = 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line)

    def inside_fence(position: int) -> bool:
        return any(left <= position < right for left, right in covered_spans)

    index = 0
    while index < len(lines):
        line_text = lines[index].rstrip("\r\n")
        position = offsets[index]
        if inside_fence(position) or not RAW_TOOL_START_RE.match(line_text):
            index += 1
            continue

        if index + 1 >= len(lines):
            index += 1
            continue
        arguments_line = lines[index + 1].rstrip("\r\n")
        if not RAW_ARGUMENTS_RE.match(arguments_line):
            index += 1
            continue

        block_lines = [line_text, arguments_line]
        index += 2

        # Multiline argument mappings are indented beneath ``arguments:``.
        # Stop as soon as ordinary unindented prose resumes.
        while index < len(lines):
            continuation = lines[index].rstrip("\r\n")
            if not continuation.strip():
                break
            if continuation[:1].isspace():
                block_lines.append(continuation)
                index += 1
                continue
            break

        candidates.append((position, "raw", "\n".join(block_lines).strip()))

    candidates.sort(key=lambda item: item[0])
    seen: set[str] = set()
    result: list[tuple[str, str]] = []
    for _, source, body in candidates:
        key = body.strip()
        if key in seen:
            continue
        seen.add(key)
        result.append((source, body))
    return result


def parse_tool_calls(
    text: str,
    active_functions: dict[str, Any],
) -> tuple[list[tuple[str, dict[str, Any]]], list[dict[str, Any]]]:
    """Parse YAML tool calls embedded anywhere in an assistant response.

    Small local models are allowed to surround a call with explanatory prose.
    Fences may be indented, contain whitespace before ``yaml``, or have escaped
    Markdown backticks. A raw top-level ``tool:``/``arguments:`` mapping is also
    accepted when—and only when—the referenced tool is currently enabled.

    Ordinary YAML examples remain ordinary answer content unless they contain a
    top-level ``tool`` key naming an enabled tool.
    """
    calls: list[tuple[str, dict[str, Any]]] = []
    parse_errors: list[dict[str, Any]] = []

    if not active_functions:
        return calls, parse_errors

    for source, yaml_text in _tool_yaml_candidates(text):
        try:
            data = yaml.load(yaml_text, Loader=ToolCallYAMLLoader)
        except yaml.YAMLError as error:
            # Only treat malformed YAML as a tool failure when it clearly tried
            # to use the tool protocol.
            if not re.search(r"(?m)^\s*tool\s*:", yaml_text):
                continue
            mark = getattr(error, "problem_mark", None)
            parse_errors.append({
                "tool": None,
                "message": str(error),
                "line": (mark.line + 1) if mark is not None else None,
                "column": (mark.column + 1) if mark is not None else None,
                "snippet": yaml_text[:500],
                "source": source,
            })
            continue

        # Normal YAML examples/answers are not automatically executable.
        if not isinstance(data, dict) or "tool" not in data:
            continue

        name = data.get("tool")
        arguments = data.get("arguments", {})
        if not isinstance(name, str) or not name.strip():
            parse_errors.append({
                "tool": None, "message": "Missing or invalid 'tool' name.",
                "line": None, "column": None, "snippet": yaml_text[:500],
                "source": source,
            })
            continue

        name = name.strip()
        if name not in active_functions:
            parse_errors.append({
                "tool": name, "message": f"Tool is disabled or unknown: {name}",
                "line": None, "column": None, "snippet": yaml_text[:500],
                "source": source,
            })
            continue

        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            parse_errors.append({
                "tool": name, "message": "'arguments' must be a YAML mapping.",
                "line": None, "column": None, "snippet": yaml_text[:500],
                "source": source,
            })
            continue

        calls.append((name, arguments))

    return calls, parse_errors

def looks_like_agent_action(
    text: str,
    active_functions: dict[str, Any],
    *,
    file_output_enabled: bool = True,
) -> bool:
    """Suppress direct-at-start agent action blocks while streaming."""
    stripped = text.lstrip()
    if not stripped:
        return True

    lowered = stripped.lower()
    prefixes: tuple[str, ...] = ()
    if file_output_enabled:
        prefixes += ("```file:",)
    if active_functions:
        prefixes += ("```yaml", "```yml")
    if not prefixes:
        return False

    return any(prefix.startswith(lowered) for prefix in prefixes) or lowered.startswith(prefixes)


def _validate_tool_arguments(
    name: str,
    arguments: dict[str, Any],
    active_tool_schemas: list[dict[str, Any]] | None,
) -> str | None:
    """Return a concise validation error, or None when arguments match the schema."""
    schema = next(
        (item for item in (active_tool_schemas or []) if str(item.get("name") or item.get("function", {}).get("name") or "") == name),
        None,
    )
    if not isinstance(schema, dict):
        return None
    function = schema.get("function", schema)
    params = function.get("parameters") if isinstance(function, dict) else None
    if not isinstance(params, dict):
        return None
    props = params.get("properties") or {}
    required = params.get("required") or []
    for key in required:
        if key not in arguments:
            return f"missing required argument: {key}"
    for key, value in arguments.items():
        spec = props.get(key)
        if not isinstance(spec, dict):
            return f"unknown argument: {key}"
        expected = spec.get("type")
        if expected == "string" and not isinstance(value, str):
            return f"{key} must be a string"
        if expected == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            return f"{key} must be an integer"
        if expected == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            return f"{key} must be a number"
        if expected == "boolean" and not isinstance(value, bool):
            return f"{key} must be a boolean"
        enum_values = spec.get("enum")
        if isinstance(enum_values, list) and value not in enum_values:
            return f"{key} must be one of: {'|'.join(str(item) for item in enum_values)}"
    return None


def execute_tool(
    name: str,
    arguments: dict[str, Any],
    event_callback: EventCallback | None,
    active_functions: dict[str, Any],
    active_tool_schemas: list[dict[str, Any]] | None = None,
    *,
    sequence: int,
) -> tuple[str, dict[str, Any]]:
    call_id = f"tool-{sequence}"
    _emit(
        event_callback,
        "tool_start",
        call_id=call_id,
        sequence=sequence,
        name=name,
        arguments=arguments,
    )
    started = time.perf_counter()
    function = active_functions.get(name)
    validation_error = _validate_tool_arguments(name, arguments, active_tool_schemas)
    if function is None:
        result = f"Tool is disabled or unknown: {name}"
    elif validation_error:
        result = f"Tool error: invalid arguments for {name}: {validation_error}"
    else:
        try:
            result = str(function(**arguments))
        except Exception as error:
            result = f"Tool error: {type(error).__name__}: {error}"

    duration_seconds = round(time.perf_counter() - started, 3)
    trace = {
        "call_id": call_id,
        "sequence": sequence,
        "name": name,
        "arguments": arguments,
        "result": result,
        "duration_seconds": duration_seconds,
    }
    _emit(event_callback, "tool_end", **trace)
    return result, trace


_GGUF_LAYOUT_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}
_GGUF_LAYOUT_CACHE_LOCK = threading.Lock()
_GGUF_FIXED_VALUE_SIZES = {
    0: 1,   # UINT8
    1: 1,   # INT8
    2: 2,   # UINT16
    3: 2,   # INT16
    4: 4,   # UINT32
    5: 4,   # INT32
    6: 4,   # FLOAT32
    7: 1,   # BOOL
    10: 8,  # UINT64
    11: 8,  # INT64
    12: 8,  # FLOAT64
}
_GGUF_SCALAR_FORMATS = {
    0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i",
    6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d",
}


def _gguf_exact(handle: Any, count: int) -> bytes:
    data = handle.read(count)
    if len(data) != count:
        raise EOFError("Unexpected end of GGUF file")
    return data


def _gguf_u32(handle: Any) -> int:
    return struct.unpack("<I", _gguf_exact(handle, 4))[0]


def _gguf_u64(handle: Any) -> int:
    return struct.unpack("<Q", _gguf_exact(handle, 8))[0]


def _gguf_string(handle: Any) -> str:
    length = _gguf_u64(handle)
    if length > 256 * 1024 * 1024:
        raise ValueError(f"Unreasonable GGUF string length: {length}")
    return _gguf_exact(handle, length).decode("utf-8", errors="replace")


def _gguf_skip_value(handle: Any, value_type: int) -> None:
    if value_type in _GGUF_FIXED_VALUE_SIZES:
        handle.seek(_GGUF_FIXED_VALUE_SIZES[value_type], os.SEEK_CUR)
        return
    if value_type == 8:  # STRING
        length = _gguf_u64(handle)
        handle.seek(length, os.SEEK_CUR)
        return
    if value_type == 9:  # ARRAY
        element_type = _gguf_u32(handle)
        count = _gguf_u64(handle)
        if count > 100_000_000:
            raise ValueError(f"Unreasonable GGUF array length: {count}")
        fixed = _GGUF_FIXED_VALUE_SIZES.get(element_type)
        if fixed is not None:
            handle.seek(fixed * count, os.SEEK_CUR)
            return
        for _ in range(count):
            _gguf_skip_value(handle, element_type)
        return
    raise ValueError(f"Unsupported GGUF metadata value type: {value_type}")


def _gguf_read_scalar(handle: Any, value_type: int) -> Any:
    if value_type == 8:
        return _gguf_string(handle)
    fmt = _GGUF_SCALAR_FORMATS.get(value_type)
    if fmt is None:
        _gguf_skip_value(handle, value_type)
        return None
    return struct.unpack(fmt, _gguf_exact(handle, struct.calcsize(fmt)))[0]


def _inspect_gguf_layout(model_path: str | Path) -> dict[str, Any]:
    """Read GGUF metadata/tensor offsets without loading model weights.

    Tensor storage is measured from offsets rather than guessed from GGML type,
    so this keeps working with newer quantization types without maintaining a
    fragile block-size table.
    """
    path = Path(model_path)
    stat = path.stat()
    cache_key = (str(path.resolve(strict=False)), int(stat.st_size), int(stat.st_mtime_ns))
    with _GGUF_LAYOUT_CACHE_LOCK:
        cached = _GGUF_LAYOUT_CACHE.get(cache_key)
        if cached is not None:
            return deepcopy(cached)

    interesting_suffixes = (
        ".block_count", ".embedding_length", ".attention.head_count",
        ".attention.head_count_kv", ".attention.key_length",
        ".attention.value_length",
    )
    metadata: dict[str, Any] = {}
    tensors: list[tuple[str, int]] = []

    with path.open("rb") as handle:
        if _gguf_exact(handle, 4) != b"GGUF":
            raise ValueError("File is not GGUF")
        version = _gguf_u32(handle)
        if version not in {2, 3}:
            raise ValueError(f"Unsupported GGUF version: {version}")
        tensor_count = _gguf_u64(handle)
        metadata_count = _gguf_u64(handle)
        if tensor_count > 10_000_000 or metadata_count > 10_000_000:
            raise ValueError("Unreasonable GGUF header counts")

        for _ in range(metadata_count):
            key = _gguf_string(handle)
            value_type = _gguf_u32(handle)
            wanted = (
                key in {"general.architecture", "general.alignment"}
                or key.endswith(interesting_suffixes)
            )
            if wanted and value_type != 9:
                metadata[key] = _gguf_read_scalar(handle, value_type)
            else:
                _gguf_skip_value(handle, value_type)

        for _ in range(tensor_count):
            name = _gguf_string(handle)
            dimensions = _gguf_u32(handle)
            if dimensions > 8:
                raise ValueError(f"Unreasonable GGUF tensor rank: {dimensions}")
            for _dim in range(dimensions):
                _gguf_u64(handle)
            _gguf_u32(handle)  # ggml_type; offsets let us avoid type-size guesses.
            offset = _gguf_u64(handle)
            tensors.append((name, int(offset)))

        alignment = int(metadata.get("general.alignment") or 32)
        alignment = max(1, min(alignment, 4096))
        pos = handle.tell()
        data_start = pos + ((alignment - (pos % alignment)) % alignment)

    file_size = int(stat.st_size)
    data_size = max(0, file_size - data_start)
    ordered = sorted(tensors, key=lambda item: item[1])
    tensor_storage: list[tuple[str, int]] = []
    for index, (name, offset) in enumerate(ordered):
        next_offset = ordered[index + 1][1] if index + 1 < len(ordered) else data_size
        size = max(0, min(data_size, next_offset) - max(0, offset))
        tensor_storage.append((name, size))

    block_re = re.compile(r"(?:^|\.)(?:blk|block|layers?)\.(\d+)(?:\.|$)")
    detected_blocks: dict[int, int] = {}
    non_block_bytes = 0
    for name, size in tensor_storage:
        match = block_re.search(name)
        if match:
            block_index = int(match.group(1))
            detected_blocks[block_index] = detected_blocks.get(block_index, 0) + int(size)
        else:
            non_block_bytes += int(size)

    architecture = str(metadata.get("general.architecture") or "unknown")
    block_count = None
    architecture_key = f"{architecture}.block_count"
    if architecture_key in metadata:
        try:
            block_count = int(metadata[architecture_key])
        except (TypeError, ValueError):
            block_count = None
    if not block_count:
        for key, value in metadata.items():
            if key.endswith(".block_count"):
                try:
                    block_count = int(value)
                    break
                except (TypeError, ValueError):
                    pass
    if not block_count and detected_blocks:
        block_count = max(detected_blocks) + 1
    if not block_count or block_count <= 0:
        raise ValueError("Could not determine transformer block count from GGUF")

    block_bytes = [int(detected_blocks.get(i, 0)) for i in range(block_count)]
    if not any(block_bytes):
        raise ValueError("Could not identify per-layer tensors in GGUF tensor table")

    layout = {
        "version": version,
        "architecture": architecture,
        "block_count": int(block_count),
        "block_bytes": block_bytes,
        "non_block_bytes": int(non_block_bytes),
        "file_size": file_size,
        "metadata": metadata,
    }
    with _GGUF_LAYOUT_CACHE_LOCK:
        # Drop stale entries for the same path while keeping a tiny process cache.
        for key in list(_GGUF_LAYOUT_CACHE):
            if key[0] == cache_key[0] and key != cache_key:
                _GGUF_LAYOUT_CACHE.pop(key, None)
        _GGUF_LAYOUT_CACHE[cache_key] = deepcopy(layout)
    return layout


def _gguf_meta_int(metadata: dict[str, Any], architecture: str, suffix: str) -> int | None:
    exact = f"{architecture}{suffix}"
    candidates = [exact] + [key for key in metadata if key.endswith(suffix) and key != exact]
    for key in candidates:
        if key not in metadata:
            continue
        try:
            value = int(metadata[key])
            if value > 0:
                return value
        except (TypeError, ValueError):
            continue
    return None


def _kv_scalar_bytes(kv_name: str) -> float:
    # Storage ratios from ggml block formats. Add a little alignment slack later.
    return {
        "f16": 2.0,
        "q8_0": 34.0 / 32.0,
        "q5_0": 22.0 / 32.0,
        "q4_0": 18.0 / 32.0,
    }.get(kv_name, 2.0)


class ModelManager:
    """Own exactly one llama.cpp model and serialize inference/reloads."""

    def __init__(self) -> None:
        self.llm: Llama | None = None
        self.signature: tuple[Any, ...] | None = None
        self.model_path: str | None = None
        self.load_lock = threading.RLock()
        self.inference_lock = threading.RLock()
        self.cancel_event = threading.Event()
        self._activity_lock = threading.Lock()
        self._last_activity = time.monotonic()
        self.idle_timeout_seconds = 0
        self._idle_label = "model"
        self._idle_stop = threading.Event()
        self._idle_thread: threading.Thread | None = None

        # VRAM governor state. All measurements are in MiB as reported by
        # nvidia-smi. Footprints are learned per llama.cpp load signature.
        self.vram_governor_enabled = bool(VRAM_GOVERNOR_ENABLED)
        self.vram_gpu_index = int(VRAM_GOVERNOR_GPU_INDEX)
        self.vram_poll_seconds = int(VRAM_GOVERNOR_POLL_SECONDS)
        self.vram_reserve_mb = int(VRAM_GOVERNOR_RESERVE_MB)
        self.vram_pressure_drop_mb = int(VRAM_GOVERNOR_PRESSURE_DROP_MB)
        self.vram_pressure_seconds = int(VRAM_GOVERNOR_PRESSURE_SECONDS)
        self.vram_process_trigger = bool(VRAM_GOVERNOR_PROCESS_TRIGGER)
        self.vram_process_seconds = int(VRAM_GOVERNOR_PROCESS_SECONDS)
        self.vram_recovery_seconds = int(VRAM_GOVERNOR_RECOVERY_SECONDS)
        self._vram_lock = threading.RLock()
        self._vram_stop = threading.Event()
        self._vram_thread: threading.Thread | None = None
        self._vram_available: bool | None = None
        self._vram_unavailable_reason: str | None = None
        self._vram_state = "disabled" if not self.vram_governor_enabled else "normal"
        self._vram_reason: str | None = None
        self._vram_last_sample: dict[str, int | float] | None = None
        self._vram_loaded_baseline_free_mb: int | None = None
        self._vram_loaded_baseline_used_mb: int | None = None
        self._vram_last_footprint_mb: int | None = None
        self._vram_footprints: dict[tuple[Any, ...], int] = {}
        self._vram_active_signature: tuple[Any, ...] | None = None
        self._vram_pressure_since: float | None = None
        self._vram_process_since: float | None = None
        self._vram_recovery_since: float | None = None
        self._vram_reserved = False
        self._vram_loaded_gpu_pids: set[int] = set()
        self._vram_external_gpu_processes: list[dict[str, Any]] = []
        self._vram_trigger_pids: set[int] = set()
        # If the governor itself evicts a model, remember exactly what it
        # displaced so it can be restored after the GPU is free again.
        # Idle/manual unloads never populate this request.
        self._vram_restore_request: dict[str, Any] | None = None
        self._active_load_settings: dict[str, Any] | None = None
        self._gpu_layer_plan: dict[str, Any] | None = None

    def touch(self) -> None:
        """Reset the idle-unload countdown after real model activity."""
        with self._activity_lock:
            self._last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        with self._activity_lock:
            return max(0.0, time.monotonic() - self._last_activity)

    def start_idle_unloader(self, timeout_seconds: int, *, label: str = "model") -> None:
        """Unload an idle model without ever interrupting an active agent turn."""
        self.idle_timeout_seconds = max(0, int(timeout_seconds))
        self._idle_label = str(label or "model")
        if self.idle_timeout_seconds <= 0 or (self._idle_thread and self._idle_thread.is_alive()):
            return

        def monitor() -> None:
            # Check often enough that a five-minute timeout feels exact, while
            # consuming effectively no CPU when the model is idle or unloaded.
            interval = min(15.0, max(1.0, self.idle_timeout_seconds / 10.0))
            while not self._idle_stop.wait(interval):
                if self.llm is None or self.idle_seconds() < self.idle_timeout_seconds:
                    continue

                # run_agent_turn owns this same lock for the complete turn,
                # including tool calls. Never unload underneath active work.
                acquired = self.inference_lock.acquire(blocking=False)
                if not acquired:
                    continue
                try:
                    if self.llm is None or self.idle_seconds() < self.idle_timeout_seconds:
                        continue
                    old_path = self.model_path
                    idle_for = self.idle_seconds()
                    self.unload()
                    print(
                        f"[Model] Unloaded {self._idle_label} model after "
                        f"{idle_for:.0f}s idle: {old_path or 'unknown model'}"
                    )
                finally:
                    self.inference_lock.release()

        self._idle_thread = threading.Thread(
            target=monitor,
            name=f"{self._idle_label}-model-idle-unloader",
            daemon=True,
        )
        self._idle_thread.start()

    def _sample_vram(self) -> dict[str, int | float] | None:
        """Return a quiet nvidia-smi VRAM snapshot, or None when unavailable."""
        if not self.vram_governor_enabled:
            return None

        command = [
            "nvidia-smi",
            "-i",
            str(self.vram_gpu_index),
            "--query-gpu=memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
        ]
        kwargs: dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "timeout": 3,
            "check": False,
        }
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        try:
            proc = subprocess.run(command, **kwargs)
            if proc.returncode != 0:
                message = (proc.stderr or proc.stdout or "nvidia-smi failed").strip()
                raise RuntimeError(message[:240])
            line = next((x.strip() for x in proc.stdout.splitlines() if x.strip()), "")
            parts = [x.strip() for x in line.split(",")]
            if len(parts) < 2:
                raise ValueError(f"Unexpected nvidia-smi output: {line!r}")

            def number(value: str, default: int = 0) -> int:
                match = re.search(r"-?\d+(?:\.\d+)?", value)
                return int(float(match.group(0))) if match else default

            used = max(0, number(parts[0]))
            total = max(1, number(parts[1]))
            util = max(0, min(100, number(parts[2]) if len(parts) > 2 else 0))
            sample: dict[str, int | float] = {
                "used_mb": used,
                "total_mb": total,
                "free_mb": max(0, total - used),
                "utilization_percent": util,
                "timestamp": time.time(),
            }
            with self._vram_lock:
                self._vram_available = True
                self._vram_unavailable_reason = None
                self._vram_last_sample = sample
            return sample
        except Exception as error:
            with self._vram_lock:
                self._vram_available = False
                self._vram_unavailable_reason = f"{type(error).__name__}: {error}"
                if self._vram_state not in {"reserved", "recovering"}:
                    self._vram_state = "unavailable"
            return None

    def _sample_gpu_processes(self) -> list[dict[str, Any]]:
        """Return NVIDIA graphics/compute processes visible in nvidia-smi.

        On Windows/WDDM, per-process VRAM is often unavailable, but the process
        list itself is still useful. That gives the governor a second signal:
        a newly launched GPU application can request an unload even when WDDM
        reshuffles VRAM and total memory.used barely changes.
        """
        if not self.vram_governor_enabled or not self.vram_process_trigger:
            return []

        kwargs: dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "timeout": 3,
            "check": False,
        }
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        try:
            proc = subprocess.run(["nvidia-smi", "-i", str(self.vram_gpu_index)], **kwargs)
            if proc.returncode != 0:
                return []
            rows: list[dict[str, Any]] = []
            valid_types = {"C", "G", "C+G", "M", "M+C", "O"}
            for raw in proc.stdout.splitlines():
                line = raw.strip()
                if not line.startswith("|"):
                    continue
                fields = line.strip("| 	").split()
                if not fields or not fields[0].isdigit():
                    continue
                for idx, token in enumerate(fields):
                    if token not in valid_types or idx < 1 or not fields[idx - 1].isdigit():
                        continue
                    pid = int(fields[idx - 1])
                    tail = fields[idx + 1:]
                    if tail and (tail[-1] == "N/A" or tail[-1].endswith("MiB")):
                        tail = tail[:-1]
                    name = " ".join(tail).strip() or f"PID {pid}"
                    rows.append({"pid": pid, "type": token, "name": name})
                    break
            return rows
        except Exception:
            return []

    @staticmethod
    def _ignore_gpu_process(process: dict[str, Any]) -> bool:
        pid = int(process.get("pid") or 0)
        if pid <= 0 or pid == os.getpid():
            return True
        name = str(process.get("name") or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
        # Persistent Windows desktop processes can appear/disappear as displays
        # sleep or shells restart. They are not a reason to evict the model.
        return name in {
            "dwm.exe", "explorer.exe", "searchhost.exe",
            "shellexperiencehost.exe", "startmenuexperiencehost.exe",
            "textinputhost.exe", "applicationframehost.exe",
            "lockapp.exe", "systemsettings.exe",
        }

    def _wait_for_vram_settle(self, *, timeout_seconds: float = 4.0) -> dict[str, int | float] | None:
        """Wait briefly for CUDA/WDDM to publish VRAM released by model.close()."""
        if not self.vram_governor_enabled:
            return None
        deadline = time.monotonic() + max(0.2, float(timeout_seconds))
        previous: dict[str, int | float] | None = None
        stable = 0
        latest: dict[str, int | float] | None = None
        while time.monotonic() < deadline:
            latest = self._sample_vram()
            if latest is None:
                return None
            if previous is not None and abs(int(latest["free_mb"]) - int(previous["free_mb"])) <= 8:
                stable += 1
                if stable >= 2:
                    return latest
            else:
                stable = 0
            previous = latest
            time.sleep(0.15)
        return latest

    def _estimate_kv_per_gpu_layer_mb(
        self,
        layout: dict[str, Any],
        settings: dict[str, Any],
    ) -> float:
        """Conservatively estimate KV-cache bytes contributed by one GPU layer."""
        metadata = layout.get("metadata") if isinstance(layout.get("metadata"), dict) else {}
        architecture = str(layout.get("architecture") or "unknown")
        embedding = _gguf_meta_int(metadata, architecture, ".embedding_length")
        heads = _gguf_meta_int(metadata, architecture, ".attention.head_count")
        kv_heads = _gguf_meta_int(metadata, architecture, ".attention.head_count_kv") or heads
        if not embedding or not heads or not kv_heads:
            return 0.0
        head_dim = max(1, embedding // heads)
        key_length = _gguf_meta_int(metadata, architecture, ".attention.key_length") or head_dim
        value_length = _gguf_meta_int(metadata, architecture, ".attention.value_length") or head_dim
        n_ctx = max(512, int(settings.get("context_length", 65536)))
        kv_name = _resolve_kv_cache_type(settings)[0]
        bytes_per_scalar = _kv_scalar_bytes(kv_name)
        scalars = n_ctx * kv_heads * (key_length + value_length)
        # 5% covers block padding/alignment and avoids pretending the estimate is exact.
        return (scalars * bytes_per_scalar * 1.05) / (1024.0 * 1024.0)

    def _plan_gpu_layers(
        self,
        model_path: str,
        settings: dict[str, Any],
        sample: dict[str, int | float] | None,
    ) -> tuple[int, dict[str, Any] | None]:
        """Choose n_gpu_layers before constructing Llama.

        An explicit non-negative gpu_layers value is authoritative (clamped only
        to the model's actual block count). A negative value means Auto and lets
        the VRAM planner choose as many layers as it estimates will safely fit.
        For explicit values, the planner remains advisory and may warn when the
        request exceeds its conservative estimate, but it never silently lowers
        the user's requested offload.
        """
        requested = int(settings.get("gpu_layers", -1))
        if requested == 0 or not GPU_LAYER_PLANNER_ENABLED or sample is None:
            return requested, None

        try:
            layout = _inspect_gguf_layout(model_path)
        except Exception as error:
            plan = {
                "enabled": True,
                "status": "inspection_failed",
                "error": f"{type(error).__name__}: {error}",
                "requested_gpu_layers": requested,
            }
            self._gpu_layer_plan = plan
            print(f"[VRAM] GGUF layer planner unavailable for {Path(model_path).name}: {plan['error']}")
            # If the user requested automatic/all-layer offload, do not blindly
            # attempt full GPU loading when inspection failed. CPU-only is the
            # safe fallback; an explicit numeric layer count remains respected.
            fallback = 0 if requested < 0 else requested
            plan["effective_gpu_layers"] = fallback
            plan["status"] = "inspection_failed_cpu_fallback" if requested < 0 else "inspection_failed_explicit_fallback"
            return fallback, plan

        block_count = int(layout["block_count"])
        requested_max = block_count if requested < 0 else max(0, min(requested, block_count))
        block_bytes = [int(x) for x in layout.get("block_bytes", [])[:block_count]]
        if len(block_bytes) < block_count:
            block_bytes.extend([0] * (block_count - len(block_bytes)))

        free_mb = max(0, int(sample.get("free_mb") or 0))
        total_mb = max(1, int(sample.get("total_mb") or 1))
        reserve_mb = min(GPU_LAYER_PLANNER_RESERVE_MB, max(64, total_mb // 3))
        overhead_mb = min(GPU_LAYER_PLANNER_OVERHEAD_MB, max(0, free_mb // 4))
        usable_mb = max(0.0, float(free_mb - reserve_mb - overhead_mb))
        weight_factor = max(1.0, GPU_LAYER_PLANNER_WEIGHT_FACTOR_PERCENT / 100.0)
        kv_per_layer_mb = self._estimate_kv_per_gpu_layer_mb(layout, settings)

        # llama.cpp offloads the final N transformer blocks first, so evaluate
        # the actual suffix of the model rather than assuming every block is identical.
        # For an explicit request this is advisory only; for Auto it determines
        # the actual n_gpu_layers passed to llama.cpp.
        safe_layers = 0
        estimated_requested_mb = 0.0
        suffix_weight_bytes = 0
        for count in range(1, requested_max + 1):
            layer_index = block_count - count
            suffix_weight_bytes += block_bytes[layer_index]
            weight_mb = (suffix_weight_bytes / (1024.0 * 1024.0)) * weight_factor
            candidate_mb = weight_mb + kv_per_layer_mb * count
            estimated_requested_mb = candidate_mb
            if candidate_mb <= usable_mb:
                safe_layers = count

        auto_mode = requested < 0
        effective = safe_layers if auto_mode else requested_max
        exceeds_estimate = requested_max > safe_layers
        if auto_mode:
            status = "auto_capped" if safe_layers < requested_max else "auto_all_fit"
        else:
            status = "explicit_over_estimate" if exceeds_estimate else "requested_fits"

        plan = {
            "enabled": True,
            "status": status,
            "architecture": str(layout.get("architecture") or "unknown"),
            "model_layers": block_count,
            "requested_gpu_layers": requested,
            "requested_max_layers": requested_max,
            "planner_safe_layers": safe_layers,
            "effective_gpu_layers": effective,
            "explicit_request_honored": not auto_mode,
            "free_mb_before_load": free_mb,
            "total_mb": total_mb,
            "planner_reserve_mb": reserve_mb,
            "planner_overhead_mb": overhead_mb,
            "usable_mb_for_layers": round(usable_mb, 1),
            "estimated_gpu_layer_mb": round(estimated_requested_mb, 1),
            "estimated_kv_per_layer_mb": round(kv_per_layer_mb, 2),
            "weight_factor_percent": GPU_LAYER_PLANNER_WEIGHT_FACTOR_PERCENT,
        }
        self._gpu_layer_plan = plan

        if auto_mode:
            print(
                f"[VRAM] GGUF preflight {Path(model_path).name}: "
                f"{block_count} layers, requested Auto, planner selected {effective} GPU layers | "
                f"{free_mb} MiB free, planner reserve {reserve_mb} MiB, "
                f"estimated allocation ~{estimated_requested_mb:.0f} MiB"
            )
        else:
            advisory = (
                f"planner advisory {safe_layers} layers"
                if exceeds_estimate
                else "planner estimate fits"
            )
            print(
                f"[VRAM] GGUF preflight {Path(model_path).name}: "
                f"{block_count} layers, requested {requested}, honoring {effective} GPU layers | "
                f"{advisory}; {free_mb} MiB free, planner reserve {reserve_mb} MiB, "
                f"estimated requested allocation ~{estimated_requested_mb:.0f} MiB"
            )

        return effective, plan

    def _vram_needed_for_signature(self, signature: tuple[Any, ...] | None) -> int | None:
        if signature is None:
            return self._vram_last_footprint_mb
        # Never borrow another model/settings profile. During a model switch the
        # new GGUF may have a radically different footprint.
        with self._vram_lock:
            return self._vram_footprints.get(signature)

    def _vram_required_free_mb(
        self,
        sample: dict[str, int | float],
        footprint_mb: int | None,
    ) -> int:
        """Return a physically achievable free-VRAM threshold for (re)loading.

        The configured reserve is a preference, not a reason to deadlock a model
        that has already proven it can load on this GPU. On a 4 GiB card a model
        may legitimately consume ~3.9 GiB; footprint + 700 MiB can therefore
        exceed the GPU's total capacity. Cap the requirement just below total
        VRAM so an otherwise-empty GPU can recover and reload the model.
        """
        total_mb = max(1, int(sample.get("total_mb") or 1))
        # Leave a tiny amount of room for the display driver while still allowing
        # very tight 4 GiB configurations that previously loaded successfully.
        max_achievable = max(64, total_mb - min(64, max(16, total_mb // 64)))
        if footprint_mb and int(footprint_mb) > 0:
            requested = int(footprint_mb) + int(self.vram_reserve_mb)
        else:
            requested = int(self.vram_reserve_mb) + 512
        return max(64, min(requested, max_achievable))

    def _set_vram_reserved(self, reason: str, *, footprint_mb: int | None = None) -> None:
        with self._vram_lock:
            self._vram_reserved = True
            self._vram_state = "reserved"
            self._vram_reason = reason
            self._vram_pressure_since = None
            self._vram_process_since = None
            self._vram_recovery_since = None
            if footprint_mb and footprint_mb > 0:
                self._vram_last_footprint_mb = int(footprint_mb)

    def _clear_vram_reservation(self) -> None:
        with self._vram_lock:
            self._vram_reserved = False
            self._vram_state = "normal"
            self._vram_reason = None
            self._vram_pressure_since = None
            self._vram_process_since = None
            self._vram_recovery_since = None
            self._vram_trigger_pids = set()
            self._vram_external_gpu_processes = []

    def _queue_vram_restore(self, model_path: str | None, settings: dict[str, Any] | None) -> None:
        if not model_path or not settings:
            return
        with self._vram_lock:
            self._vram_restore_request = {
                "model_path": str(model_path),
                "settings": deepcopy(settings),
            }

    def _attempt_vram_restore(self) -> bool:
        """Restore only a model that this governor previously evicted."""
        with self._vram_lock:
            request = deepcopy(self._vram_restore_request) if self._vram_restore_request else None
            reserved = self._vram_reserved
        if reserved or not request or self.llm is not None:
            return False

        acquired = self.inference_lock.acquire(blocking=False)
        if not acquired:
            with self._vram_lock:
                self._vram_state = "reload_pending"
                self._vram_reason = "GPU recovered; waiting for the active agent turn before restoring the model"
            return False

        try:
            if self.llm is not None:
                with self._vram_lock:
                    self._vram_restore_request = None
                return False
            model_path = str(request.get("model_path") or "")
            settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
            if not model_path:
                with self._vram_lock:
                    self._vram_restore_request = None
                return False

            with self._vram_lock:
                self._vram_state = "reloading"
                self._vram_reason = f"GPU recovered; restoring {Path(model_path).name}"
            print(f"[VRAM] GPU recovered; restoring primary model: {model_path}")
            try:
                self.ensure_loaded(model_path, settings)
            except RuntimeError as error:
                # A fresh VRAM preflight can legitimately reserve the GPU again
                # if another workload appeared during the recovery window. Keep
                # the restore request so the governor can retry later.
                with self._vram_lock:
                    if not self._vram_reserved:
                        self._vram_state = "reload_pending"
                        self._vram_reason = f"automatic reload deferred: {error}"
                print(f"[VRAM] Automatic model restore deferred: {error}")
                return False
            except Exception as error:
                with self._vram_lock:
                    self._vram_restore_request = None
                    self._vram_state = "restore_failed"
                    self._vram_reason = f"automatic model restore failed: {type(error).__name__}: {error}"
                print(f"[VRAM] Automatic model restore failed: {type(error).__name__}: {error}")
                return False

            with self._vram_lock:
                self._vram_restore_request = None
                self._vram_state = "normal"
                self._vram_reason = None
            # Treat automatic restoration as fresh residency so the ordinary
            # five-minute idle timer does not immediately evict the model again.
            self.touch()
            print(f"[VRAM] Primary model restored after GPU recovery: {model_path}")
            return True
        finally:
            self.inference_lock.release()

    def _record_loaded_vram(
        self,
        signature: tuple[Any, ...],
        before: dict[str, int | float] | None,
        after: dict[str, int | float] | None,
        *,
        gpu_layers: int,
    ) -> None:
        # gpu_layers=0 is a deliberate CPU-only model and needs no governor.
        if not self.vram_governor_enabled or gpu_layers == 0 or after is None:
            with self._vram_lock:
                self._vram_active_signature = None
                self._vram_loaded_baseline_free_mb = None
                self._vram_loaded_baseline_used_mb = None
            return

        footprint: int | None = None
        if before is not None:
            footprint = max(0, int(after["used_mb"]) - int(before["used_mb"]))
            # Tiny deltas are usually display-driver noise, not a useful model profile.
            if footprint >= 64:
                with self._vram_lock:
                    self._vram_footprints[signature] = footprint
                    self._vram_last_footprint_mb = footprint

        gpu_processes = self._sample_gpu_processes()
        baseline_pids = {
            int(item.get("pid") or 0)
            for item in gpu_processes
            if not self._ignore_gpu_process(item)
        }

        with self._vram_lock:
            self._vram_active_signature = signature
            self._vram_loaded_baseline_free_mb = int(after["free_mb"])
            self._vram_loaded_baseline_used_mb = int(after["used_mb"])
            self._vram_loaded_gpu_pids = baseline_pids
            self._vram_external_gpu_processes = []
            self._vram_trigger_pids = set()
            self._vram_reserved = False
            self._vram_state = "normal"
            self._vram_reason = None
            self._vram_pressure_since = None
            self._vram_process_since = None
            self._vram_recovery_since = None

        learned = footprint if footprint is not None else self._vram_last_footprint_mb
        learned_text = f"~{learned} MiB" if learned else "unknown"
        print(
            f"[VRAM] Model footprint {learned_text} | "
            f"used {int(after['used_mb'])}/{int(after['total_mb'])} MiB | "
            f"free {int(after['free_mb'])} MiB | reserve {self.vram_reserve_mb} MiB | "
            f"GPU-process baseline {len(baseline_pids)}"
        )

    def _vram_preflight(self, signature: tuple[Any, ...], *, gpu_layers: int) -> dict[str, int | float] | None:
        """Refuse a known-unsafe reload while the GPU is deliberately reserved."""
        if not self.vram_governor_enabled or gpu_layers == 0:
            return None

        sample = self._sample_vram()
        if sample is None:
            return None  # nvidia-smi failure must never make the agent unusable.

        with self._vram_lock:
            reserved = self._vram_reserved
            state = self._vram_state
            reason = self._vram_reason
        footprint = self._vram_needed_for_signature(signature)
        required = self._vram_required_free_mb(sample, footprint) if footprint else None

        if reserved:
            if required and int(sample["free_mb"]) >= required:
                # Recovery still needs to remain stable for the configured period;
                # the monitor owns that timer rather than a single lucky sample.
                pass
            raise RuntimeError(
                "VRAM governor is reserving the NVIDIA GPU"
                f" ({state}: {reason or 'VRAM pressure'}). "
                f"Free VRAM: {int(sample['free_mb'])} MiB"
                + (f"; model + reserve needs about {required} MiB." if required else ".")
                + " Wait for GPU pressure to clear or set TINY_AGENT_VRAM_GOVERNOR=0 to override."
            )

        # Once a footprint has been learned, do not knowingly reload a model into
        # a GPU that cannot accommodate it while retaining the safety reserve.
        # WDDM/nvidia-smi can jitter by a few MiB on an otherwise idle GPU.
        # Do not reserve the GPU over a 1--64 MiB accounting difference.
        preflight_slack_mb = 64
        if required and int(sample["free_mb"]) + preflight_slack_mb < required:
            reason = (
                f"only {int(sample['free_mb'])} MiB free; learned model footprint "
                f"~{footprint} MiB plus {self.vram_reserve_mb} MiB reserve needs ~{required} MiB"
            )
            self._set_vram_reserved(reason, footprint_mb=footprint)
            raise RuntimeError(
                "VRAM governor blocked model loading: " + reason + ". "
                "The reservation will clear automatically after GPU memory is available again."
            )
        return sample

    def start_vram_governor(self) -> None:
        """Monitor external VRAM pressure and release the primary model safely."""
        if not self.vram_governor_enabled or (self._vram_thread and self._vram_thread.is_alive()):
            return

        # Probe once at startup so /api/runtime can immediately report support.
        self._sample_vram()

        def monitor() -> None:
            while not self._vram_stop.wait(self.vram_poll_seconds):
                # When neither a model nor a reservation exists there is nothing
                # to govern. Avoid spawning nvidia-smi forever just for telemetry.
                with self._vram_lock:
                    reserved = self._vram_reserved
                    restore_pending = self._vram_restore_request is not None
                if self.llm is None and not reserved and restore_pending:
                    self._attempt_vram_restore()
                    continue
                if self.llm is None and not reserved:
                    continue

                sample = self._sample_vram()
                if sample is None:
                    continue
                now = time.monotonic()

                if self.llm is not None:
                    with self._vram_lock:
                        baseline_free = self._vram_loaded_baseline_free_mb
                        baseline_pids = set(self._vram_loaded_gpu_pids)
                    if baseline_free is None:
                        continue

                    free_mb = int(sample["free_mb"])
                    extra_drop = max(0, int(baseline_free) - free_mb)

                    # v4.2: make the memory trigger proportional to whatever
                    # headroom the model actually left. The old fixed 384 MiB
                    # delta could literally be impossible on a nearly-full 4 GB
                    # GPU (for example, if only 250 MiB was free after loading).
                    dynamic_drop = min(
                        self.vram_pressure_drop_mb,
                        max(64, int(max(1, baseline_free) * 0.20)),
                    )
                    memory_pressure = (
                        free_mb < self.vram_reserve_mb
                        and extra_drop >= dynamic_drop
                    ) or (
                        free_mb < 128
                        and extra_drop >= 64
                    )

                    gpu_processes = self._sample_gpu_processes()
                    external_processes = [
                        item for item in gpu_processes
                        if not self._ignore_gpu_process(item)
                        and int(item.get("pid") or 0) not in baseline_pids
                    ]
                    with self._vram_lock:
                        self._vram_external_gpu_processes = external_processes[:8]

                    # Windows/WDDM may keep total dedicated usage almost flat by
                    # moving allocations around. A newly appearing NVIDIA graphics
                    # or compute process is therefore a separate pressure signal.
                    # Require it to persist for a few seconds so transient helpers
                    # do not cause an immediate unload.
                    process_activity = (
                        int(sample.get("utilization_percent") or 0) >= 5
                        or extra_drop >= 64
                    )
                    process_pressure = (
                        bool(external_processes)
                        and self.vram_process_trigger
                        and process_activity
                    )
                    if process_pressure:
                        with self._vram_lock:
                            first_seen = self._vram_process_since is None
                            if first_seen:
                                self._vram_process_since = now
                            process_elapsed = now - self._vram_process_since
                        if first_seen:
                            print(
                                "[VRAM] New NVIDIA GPU process detected: "
                                + ", ".join(
                                    f"{item.get('name') or 'unknown'} (PID {item.get('pid')})"
                                    for item in external_processes[:3]
                                )
                            )
                    else:
                        with self._vram_lock:
                            self._vram_process_since = None
                            process_elapsed = 0.0

                    pressure = memory_pressure or (
                        process_pressure and process_elapsed >= self.vram_process_seconds
                    )

                    if not pressure:
                        with self._vram_lock:
                            self._vram_pressure_since = None
                            if process_pressure:
                                names = ", ".join(
                                    str(item.get("name") or item.get("pid"))
                                    for item in external_processes[:2]
                                )
                                self._vram_state = "process_detected"
                                self._vram_reason = (
                                    f"new GPU process detected: {names}; "
                                    f"confirming for {self.vram_process_seconds}s"
                                )
                            elif not self._vram_reserved:
                                self._vram_state = "normal"
                                self._vram_reason = None
                        continue

                    names = ", ".join(
                        str(item.get("name") or item.get("pid"))
                        for item in external_processes[:2]
                    )
                    if memory_pressure and process_pressure:
                        reason = (
                            f"new GPU process {names}; {free_mb} MiB free; "
                            f"VRAM dropped {extra_drop} MiB from loaded baseline"
                        )
                    elif process_pressure:
                        reason = f"new GPU process {names} persisted for {process_elapsed:.0f}s"
                    else:
                        reason = (
                            f"free VRAM {free_mb} MiB; {extra_drop} MiB below loaded baseline "
                            f"(trigger {dynamic_drop} MiB)"
                        )

                    with self._vram_lock:
                        if self._vram_pressure_since is None:
                            self._vram_pressure_since = now
                        elapsed = now - self._vram_pressure_since
                        self._vram_state = "pressure"
                        self._vram_reason = reason
                        if process_pressure:
                            self._vram_trigger_pids = {
                                int(item.get("pid") or 0) for item in external_processes
                            }

                    # Memory-only pressure still uses its own confirmation window.
                    # Process pressure has already survived vram_process_seconds.
                    if memory_pressure and not process_pressure and elapsed < self.vram_pressure_seconds:
                        continue

                    # Same lock as run_agent_turn: if inference or a tool call is
                    # active, mark it pending and leave the model alone.
                    acquired = self.inference_lock.acquire(blocking=False)
                    if not acquired:
                        with self._vram_lock:
                            self._vram_state = "waiting_for_turn"
                            self._vram_reason = f"{reason}; unload pending after active agent turn"
                        continue
                    try:
                        if self.llm is None:
                            continue
                        old_path = self.model_path
                        restore_settings = deepcopy(self._active_load_settings) if self._active_load_settings else None
                        footprint = self._vram_needed_for_signature(self._vram_active_signature)
                        self._queue_vram_restore(old_path, restore_settings)
                        self.unload()
                        self._set_vram_reserved(reason, footprint_mb=footprint)
                        after_unload = self._sample_vram()
                        print(
                            f"[VRAM] Unloaded primary model for GPU pressure: "
                            f"{old_path or 'unknown model'} | {reason}"
                            + (
                                f" | now {int(after_unload['free_mb'])} MiB free"
                                if after_unload is not None else ""
                            )
                        )
                    finally:
                        self.inference_lock.release()
                    continue

                # Model is unloaded but GPU is reserved. Only clear the reservation
                # when there is enough room for the learned footprint + reserve,
                # continuously for the recovery window. This prevents load/unload
                # oscillation while a game or GPU application is starting/stopping.
                with self._vram_lock:
                    if not self._vram_reserved:
                        continue
                    footprint = self._vram_last_footprint_mb
                free_mb = int(sample["free_mb"])
                required = self._vram_required_free_mb(sample, footprint)

                gpu_processes = self._sample_gpu_processes()
                current_pids = {int(item.get("pid") or 0) for item in gpu_processes}
                with self._vram_lock:
                    trigger_pids = set(self._vram_trigger_pids)
                triggering_app_still_running = bool(trigger_pids & current_pids)

                # Windows/WDDM can leave a graphics process visible to nvidia-smi
                # after its meaningful GPU allocations are gone. Do not let that
                # stale entry reserve an otherwise-empty GPU forever. If the card
                # has enough free VRAM to restore the model and utilization is
                # essentially idle, treat the process record as non-blocking.
                gpu_idle = int(sample.get("utilization_percent") or 0) <= 3
                stale_process_override = (
                    triggering_app_still_running
                    and free_mb >= required
                    and gpu_idle
                )
                process_blocks_recovery = triggering_app_still_running and not stale_process_override
                recovered = free_mb >= required and not process_blocks_recovery

                if stale_process_override:
                    with self._vram_lock:
                        active = [
                            item for item in gpu_processes
                            if int(item.get("pid") or 0) in trigger_pids
                        ]
                        names = ", ".join(
                            str(item.get("name") or item.get("pid")) for item in active[:2]
                        )
                        self._vram_external_gpu_processes = active[:8]
                        self._vram_reason = (
                            f"ignoring idle/stale GPU process {names or 'detected process'}; "
                            f"{free_mb} MiB free at {int(sample.get('utilization_percent') or 0)}% GPU"
                        )

                if not recovered:
                    with self._vram_lock:
                        self._vram_recovery_since = None
                        self._vram_state = "reserved"
                        if process_blocks_recovery:
                            active = [
                                item for item in gpu_processes
                                if int(item.get("pid") or 0) in trigger_pids
                            ]
                            names = ", ".join(
                                str(item.get("name") or item.get("pid")) for item in active[:2]
                            )
                            self._vram_external_gpu_processes = active[:8]
                            self._vram_reason = f"GPU application still running: {names or 'detected process'}"
                        else:
                            self._vram_reason = (
                                f"waiting for VRAM recovery: {free_mb} MiB free; "
                                f"need ~{required} MiB"
                            )
                    continue

                with self._vram_lock:
                    if self._vram_recovery_since is None:
                        self._vram_recovery_since = now
                    recovery_elapsed = now - self._vram_recovery_since
                    self._vram_state = "recovering"
                    self._vram_reason = (
                        f"{free_mb} MiB free; waiting for {self.vram_recovery_seconds}s stable recovery"
                    )

                if recovery_elapsed >= self.vram_recovery_seconds:
                    self._clear_vram_reservation()
                    print(
                        f"[VRAM] GPU reservation cleared after stable recovery: "
                        f"{free_mb} MiB free (needed ~{required} MiB)."
                    )
                    self._attempt_vram_restore()

        self._vram_thread = threading.Thread(
            target=monitor,
            name="primary-model-vram-governor",
            daemon=True,
        )
        self._vram_thread.start()

    def vram_status(self) -> dict[str, Any]:
        with self._vram_lock:
            sample = dict(self._vram_last_sample) if self._vram_last_sample else None
            pressure_for = (
                max(0.0, time.monotonic() - self._vram_pressure_since)
                if self._vram_pressure_since is not None else None
            )
            process_for = (
                max(0.0, time.monotonic() - self._vram_process_since)
                if self._vram_process_since is not None else None
            )
            recovery_for = (
                max(0.0, time.monotonic() - self._vram_recovery_since)
                if self._vram_recovery_since is not None else None
            )
            return {
                "enabled": self.vram_governor_enabled,
                "available": self._vram_available,
                "gpu_index": self.vram_gpu_index,
                "state": self._vram_state,
                "reason": self._vram_reason,
                "unavailable_reason": self._vram_unavailable_reason,
                "reserve_mb": self.vram_reserve_mb,
                "pressure_drop_mb": self.vram_pressure_drop_mb,
                "pressure_seconds": self.vram_pressure_seconds,
                "process_trigger": self.vram_process_trigger,
                "process_seconds": self.vram_process_seconds,
                "recovery_seconds": self.vram_recovery_seconds,
                "poll_seconds": self.vram_poll_seconds,
                "loaded_baseline_free_mb": self._vram_loaded_baseline_free_mb,
                "model_footprint_mb": self._vram_last_footprint_mb,
                "reserved": self._vram_reserved,
                "pressure_for_seconds": round(pressure_for, 1) if pressure_for is not None else None,
                "process_for_seconds": round(process_for, 1) if process_for is not None else None,
                "recovery_for_seconds": round(recovery_for, 1) if recovery_for is not None else None,
                "external_gpu_processes": [dict(item) for item in self._vram_external_gpu_processes],
                "trigger_pids": sorted(self._vram_trigger_pids),
                "restore_pending": self._vram_restore_request is not None,
                "restore_model": (
                    Path(str(self._vram_restore_request.get("model_path"))).name
                    if self._vram_restore_request and self._vram_restore_request.get("model_path") else None
                ),
                "gpu_layer_planner_enabled": GPU_LAYER_PLANNER_ENABLED,
                "gpu_layer_plan": deepcopy(self._gpu_layer_plan) if self._gpu_layer_plan else None,
                "sample": sample,
            }

    def _load_signature(self, model_path: str, settings: dict[str, Any]) -> tuple[Any, ...]:
        # Keep unspecified llama.cpp options genuinely unspecified instead of
        # silently substituting additional defaults.
        return (
            str(Path(model_path)),
            int(settings.get("context_length", 65536)),
            int(settings.get("gpu_layers", -1)),
            settings.get("n_batch"),
            settings.get("n_ubatch"),
            int(settings.get("threads", 8)),
            bool(settings.get("flash_attention", True)),
            settings.get("offload_kqv"),
            _resolve_kv_cache_type(settings)[0],
        )

    def ensure_loaded(
        self,
        model_path: str,
        settings: dict[str, Any],
        event_callback: EventCallback | None = None,
    ) -> Llama:
        requested_signature = self._load_signature(model_path, settings)
        requested_gpu_layers = int(settings.get("gpu_layers", -1))
        if self.llm is not None and self.signature == requested_signature:
            self._active_load_settings = deepcopy(settings)
            self.touch()
            return self.llm

        with self.load_lock:
            if self.llm is not None and self.signature == requested_signature:
                self._active_load_settings = deepcopy(settings)
                self.touch()
                return self.llm

            path = Path(model_path)
            if not path.exists():
                raise FileNotFoundError(f"Model file does not exist: {model_path}")

            _emit(event_callback, "model_loading", path=str(path), name=path.stem)

            # A model switch must release the old CUDA allocations before the
            # new model is evaluated. WDDM/nvidia-smi can lag model.close() by a
            # fraction of a second, so wait for the free-VRAM reading to settle.
            had_old_model = self.llm is not None
            self.unload()
            clean_sample = self._wait_for_vram_settle() if had_old_model else self._sample_vram()

            # Inspect the GGUF before constructing Llama. Explicit numeric
            # gpu_layers values are honored exactly (up to the model's real block
            # count); only Auto/negative values are chosen by the VRAM planner.
            effective_gpu_layers, layer_plan = self._plan_gpu_layers(
                str(path), settings, clean_sample
            )
            effective_settings = deepcopy(settings)
            effective_settings["gpu_layers"] = int(effective_gpu_layers)
            effective_signature = self._load_signature(str(path), effective_settings)

            # Preflight the actual planned load, never the previous model's
            # signature or its learned footprint.
            vram_before = self._vram_preflight(
                effective_signature,
                gpu_layers=effective_gpu_layers,
            )
            if vram_before is None and clean_sample is not None and effective_gpu_layers != 0:
                vram_before = clean_sample

            params = inspect.signature(Llama.__init__).parameters
            kwargs: dict[str, Any] = {
                "model_path": str(path),
                "n_ctx": max(512, int(settings.get("context_length", 65536))),
                "n_gpu_layers": int(effective_gpu_layers),
                "n_threads": max(1, int(settings.get("threads", 8))),
                "verbose": os.environ.get("TINY_AGENT_VERBOSE", "0") == "1",
                # "type_k":kv_type,
                # "type_v":kv_type,
            }

            # Only pass these when the user explicitly enters an override in Settings.
            n_batch = settings.get("n_batch")
            if n_batch is not None:
                kwargs["n_batch"] = max(32, int(n_batch))

            n_ubatch = settings.get("n_ubatch")
            if n_ubatch is not None and "n_ubatch" in params:
                kwargs["n_ubatch"] = max(32, int(n_ubatch))

            offload_kqv = settings.get("offload_kqv")
            if offload_kqv is not None and "offload_kqv" in params:
                kwargs["offload_kqv"] = bool(offload_kqv)

            flash = bool(settings.get("flash_attention", True))
            if "flash_attn" in params:
                kwargs["flash_attn"] = flash
            elif "use_flash_attention" in params:
                kwargs["use_flash_attention"] = flash

            kv_name, kv_type = _resolve_kv_cache_type(settings)

            # type_k/type_v are the llama-cpp-python parameters that control
            # KV-cache quantization. Do not silently fall back to F16 if the
            # installed binding is too old to expose them.
            missing_kv_params = [
                name for name in ("type_k", "type_v") if name not in params
            ]
            if missing_kv_params:
                raise RuntimeError(
                    "This llama-cpp-python build does not expose "
                    f"{', '.join(missing_kv_params)} in Llama.__init__. "
                    "Upgrade llama-cpp-python before using KV-cache quantization."
                )

            kwargs["type_k"] = kv_type
            kwargs["type_v"] = kv_type
            kwargs["verbose"] = IS_VERBOSE

            started = time.perf_counter()
            self.llm = Llama(**kwargs)
            # Keep the user's requested signature for residency checks. If Auto
            # capped -1 to 22 layers, the next prompt with -1 must reuse this
            # model rather than re-planning/reloading on every turn.
            self.signature = requested_signature
            self.model_path = str(path)
            self._active_load_settings = deepcopy(settings)
            self.touch()
            elapsed = time.perf_counter() - started
            vram_after = self._sample_vram() if self.vram_governor_enabled and effective_gpu_layers != 0 else None
            self._record_loaded_vram(
                effective_signature,
                vram_before,
                vram_after,
                gpu_layers=effective_gpu_layers,
            )

            if layer_plan is not None:
                layer_plan = deepcopy(layer_plan)
                layer_plan["actual_gpu_layers"] = int(effective_gpu_layers)
                if vram_after is not None and vram_before is not None:
                    layer_plan["measured_vram_delta_mb"] = max(
                        0, int(vram_after["used_mb"]) - int(vram_before["used_mb"])
                    )
                self._gpu_layer_plan = layer_plan

            _emit(
                event_callback,
                "model_loaded",
                path=str(path),
                name=path.stem,
                seconds=round(elapsed, 2),
                context_length=kwargs["n_ctx"],
                kv_cache=kv_name,
                gpu_layers_requested=requested_gpu_layers,
                gpu_layers_loaded=int(effective_gpu_layers),
                model_layers=(int(layer_plan.get("model_layers")) if layer_plan and layer_plan.get("model_layers") else None),
            )
            return self.llm

    def unload(self) -> None:
        if self.llm is not None:
            old = self.llm
            self.llm = None
            self.signature = None
            self.model_path = None
            self._active_load_settings = None
            try:
                old.close()
            except Exception:
                pass
            del old
            gc.collect()
        with self._vram_lock:
            self._vram_active_signature = None
            self._vram_loaded_baseline_free_mb = None
            self._vram_loaded_baseline_used_mb = None
            self._vram_pressure_since = None
            if not self._vram_reserved and self.vram_governor_enabled and self._vram_available is not False:
                self._vram_state = "normal"
                self._vram_reason = None

    def cancel(self) -> None:
        self.cancel_event.set()

    def clear_cancel(self) -> None:
        self.cancel_event.clear()

    def reset_context(self) -> bool:
        """Clear llama.cpp's active KV/context state without unloading the model."""
        with self.inference_lock:
            if self.llm is None:
                self.clear_cancel()
                return False
            try:
                self.llm.reset()
            finally:
                self.clear_cancel()
            return True


model_manager = ModelManager()
model_manager.start_idle_unloader(PRIMARY_IDLE_UNLOAD_SECONDS, label="primary")
model_manager.start_vram_governor()
# Independent, temporary CPU-only lane for short scheduled/background composition.
# It never shares the primary model's inference lock or KV state and is already
# unloaded immediately after every background completion.
background_model_manager = ModelManager()


def run_background_composition(
    *,
    model_path: str,
    system_prompt: str,
    prompt: str,
    max_tokens: int = 320,
    context_length: int = 2048,
    threads: int = 3,
    kv_cache: str = "q4_0",
) -> tuple[str, dict[str, Any]]:
    """Run one no-tools completion on a temporary CPU-only llama.cpp instance.

    This is deliberately separate from run_agent_turn(): no conversation state, no
    tools, no skill router, and no primary inference lock. The model is unloaded as
    soon as the composition finishes so the background lane does not reserve RAM.
    """
    settings: dict[str, Any] = {
        "context_length": max(512, int(context_length)),
        "gpu_layers": 0,
        "threads": max(1, int(threads)),
        "flash_attention": True,
        "kv_cache": str(kv_cache or "q4_0"),
    }
    messages = [
        {"role": "system", "content": str(system_prompt or "").strip()},
        {"role": "user", "content": str(prompt or "").strip()},
    ]
    started = time.perf_counter()
    with background_model_manager.inference_lock:
        try:
            llm = background_model_manager.ensure_loaded(model_path, settings)
            load_finished = time.perf_counter()
            result = llm.create_chat_completion(
                messages=messages,
                temperature=0.08,
                max_tokens=max(1, min(512, int(max_tokens))),
                stream=False,
            )
            finished = time.perf_counter()
            try:
                content = str(result["choices"][0]["message"].get("content") or "").strip()
            except Exception as exc:
                raise RuntimeError("Background model returned no text response.") from exc
            usage = result.get("usage") if isinstance(result, dict) else None
            meta: dict[str, Any] = {
                "load_seconds": round(load_finished - started, 3),
                "generation_seconds": round(finished - load_finished, 3),
                "total_seconds": round(finished - started, 3),
                "context_length": settings["context_length"],
                "threads": settings["threads"],
                "gpu_layers": 0,
                "kv_cache": settings["kv_cache"],
            }
            if isinstance(usage, dict):
                for source, target in (("prompt_tokens", "prompt_tokens"), ("completion_tokens", "completion_tokens"), ("total_tokens", "total_tokens")):
                    if source in usage:
                        meta[target] = usage[source]
            completion_tokens = int(meta.get("completion_tokens") or 0)
            generation_seconds = float(meta.get("generation_seconds") or 0.0)
            if completion_tokens > 0 and generation_seconds > 0:
                meta["tokens_per_second"] = round(completion_tokens / generation_seconds, 2)
            return content, meta
        finally:
            # Temporary means temporary: free the second model and its KV cache
            # immediately after every scheduled composition.
            background_model_manager.unload()


def _brief_action_summary(tool_traces: list[dict[str, Any]]) -> str:
    """Build a one-line factual recap from actions that actually executed."""
    if not tool_traces:
        return "Action: Answered without external actions."

    phrases: list[str] = []
    for trace in tool_traces:
        name = str(trace.get("name") or "tool").strip()
        args = trace.get("arguments") if isinstance(trace.get("arguments"), dict) else {}
        result = str(trace.get("result") or "").strip()
        lowered = result.lower()
        failed = lowered.startswith(("tool error:", "tool is disabled", "failed:"))

        if failed:
            phrase = f"{name} failed"
        elif name == "browser_calendar":
            action = str(args.get("action") or "").lower()
            title = str(args.get("title") or "").strip()
            if action == "list":
                phrase = "listed calendar events"
            elif action in {"add", "create"}:
                if "created and saved outlook event" in lowered:
                    phrase = "created calendar event" + (f" ‘{title[:60]}’" if title else "")
                else:
                    phrase = "opened calendar event for saving" + (f" ‘{title[:60]}’" if title else "")
            else:
                verb = {"edit": "updated", "update": "updated", "remove": "removed", "delete": "removed"}.get(action, "used")
                phrase = f"{verb} calendar event" + (f" ‘{title[:60]}’" if title else "")
        elif name in {"browser_project_write", "browser_project_replace"}:
            path = str(args.get("path") or "").strip()
            phrase = "updated project file" + (f" {path[:80]}" if path else "")
        elif name in {"browser_project_read", "browser_project_find", "browser_project_list"}:
            phrase = "inspected project files"
        elif name == "browser_project_check":
            phrase = "checked project syntax"
        elif name == "browser_project_run":
            phrase = "ran project code/tests"
        elif name == "browser_project_npm":
            phrase = "ran a project package command"
        elif name == "browser_window":
            action = str(args.get("action") or "").strip().lower()
            target = str(args.get("target") or "window").strip()
            verb = {"open": "opened", "close": "closed", "minimize": "minimized", "restore": "restored"}.get(action, "changed")
            phrase = f"{verb} {target} window"
        elif name == "browser_launch_app":
            target = str(args.get("target") or args.get("app") or "application").strip()
            phrase = f"launched {target}"
        elif name == "browser_system_info":
            phrase = "checked system resources"
        elif name == "browser_research":
            phrase = "researched the requested topic"
        elif name == "browser_read_url":
            phrase = "read the requested web page"
        elif name == "browser_note":
            phrase = "updated notes"
        elif name == "browser_todo":
            phrase = "updated the todo list"
        elif name == "browser_timer":
            phrase = "set a timer"
        elif name == "create_tool":
            phrase = "created an agent tool"
        else:
            phrase = f"used {name}"

        if phrase not in phrases:
            phrases.append(phrase)

    shown = phrases[:3]
    suffix = f"; +{len(phrases) - 3} more" if len(phrases) > 3 else ""
    return "Action: " + "; ".join(shown) + suffix + "."


def _perf_payload(llm: Llama, start: float, first_token: float | None, end: float) -> dict[str, Any]:
    try:
        perf = llama_cpp.llama_perf_context(llm.ctx)
        prompt_seconds = perf.t_p_eval_ms / 1000.0
        generation_seconds = perf.t_eval_ms / 1000.0
        prompt_tokens = int(perf.n_p_eval)
        generated_tokens = int(perf.n_eval)
        return {
            "prompt_seconds": round(prompt_seconds, 3),
            "prompt_tokens": prompt_tokens,
            "prompt_tps": round(prompt_tokens / prompt_seconds, 2) if prompt_seconds else 0.0,
            "ttft_seconds": round(first_token - start, 3) if first_token else None,
            "generation_seconds": round(generation_seconds, 3),
            "generated_tokens": generated_tokens,
            "generation_tps": round(generated_tokens / generation_seconds, 2) if generation_seconds else 0.0,
            "wall_seconds": round(end - start, 3),
            "context_tokens": int(getattr(llm, "n_tokens", 0) or 0),
        }
    except Exception:
        return {"wall_seconds": round(end - start, 3)}


def _yaml_tool_instructions(active_tool_schemas: list[dict[str, Any]] | None) -> str:
    """Create compact YAML tool instructions from enabled tool schemas."""
    if not active_tool_schemas:
        return ""

    sections: list[str] = []
    for schema in active_tool_schemas:
        function = schema.get("function", schema)
        if not isinstance(function, dict):
            continue

        name = str(function.get("name") or "").strip()
        if not name:
            continue

        description = str(function.get("description") or "").strip()
        parameters = function.get("parameters")

        lines = [f"- {name}"]
        if description:
            lines.append(f"  Description: {description}")

        if isinstance(parameters, dict):
            properties = parameters.get("properties")
            required = set(parameters.get("required") or [])
            if isinstance(properties, dict) and properties:
                lines.append("  Arguments:")
                for arg_name, arg_schema in properties.items():
                    if not isinstance(arg_schema, dict):
                        arg_schema = {}
                    arg_type = arg_schema.get("type", "value")
                    req = "required" if arg_name in required else "optional"
                    arg_desc = str(arg_schema.get("description") or "").strip()
                    line = f"    - {arg_name} ({arg_type}, {req})"
                    enum_values = arg_schema.get("enum") if isinstance(arg_schema, dict) else None
                    if enum_values:
                        line += " = " + "|".join(str(item) for item in enum_values)
                    if arg_desc:
                        line += f": {arg_desc}"
                    lines.append(line)
            else:
                lines.append("  Arguments: none")

        sections.append("\n".join(lines))

    if not sections:
        return ""

    return (
        "\n\nTOOL USE PROTOCOL\n"
        "When a tool is needed, include a fenced Markdown YAML block in your response. "
        "Normal prose may appear before or after it. Use this shape:\n\n"
        "```yaml\n"
        "tool: TOOL_NAME\n"
        "arguments:\n"
        "  ARGUMENT_NAME: VALUE\n"
        "```\n\n"
        "For multiline commands or text, use a YAML literal block:\n\n"
        "```yaml\n"
        "tool: run_powershell_command\n"
        "arguments:\n"
        "  cmd: |\n"
        "    Get-ChildItem -LiteralPath 'C:\\Program Files (x86)'\n"
        "```\n\n"
        "Rules:\n"
        "- Use YAML tool calls, not JSON tool calls.\n"
        "- Windows paths can be written normally in YAML; do not double backslashes for JSON.\n"
        "- Use only enabled tools listed below and only their documented argument names.\n"
        "- Do not guess actual computer, file, application, process, web, or other tool-provided state; use a tool when that state is needed.\n"
        "- After a tool result, continue the original task and use another tool if necessary.\n\n"
        "ENABLED TOOLS\n"
        + "\n".join(sections)
    )


def _compact_yaml_tool_instructions(active_tool_schemas: list[dict[str, Any]] | None) -> str:
    """Small, strict tool prompt for dedicated Browser-OS turns."""
    if not active_tool_schemas:
        return ""

    rows: list[str] = []
    for schema in active_tool_schemas:
        function = schema.get("function", schema)
        if not isinstance(function, dict):
            continue
        name = str(function.get("name") or "").strip()
        if not name:
            continue
        description = str(function.get("description") or "").strip()
        parameters = function.get("parameters") or {}
        properties = parameters.get("properties") if isinstance(parameters, dict) else {}
        required = set(parameters.get("required") or []) if isinstance(parameters, dict) else set()
        args: list[str] = []
        if isinstance(properties, dict):
            for arg_name, arg_schema in properties.items():
                spec = arg_schema if isinstance(arg_schema, dict) else {}
                token = f"{arg_name}{'*' if arg_name in required else ''}:{spec.get('type', 'value')}"
                enum_values = spec.get("enum")
                if isinstance(enum_values, list) and enum_values:
                    token += " allowed=[" + ", ".join(str(v) for v in enum_values) + "]"
                args.append(token)
        signature = f"{name}({'; '.join(args)})" if args else f"{name}()"
        rows.append(f"- {signature}" + (f" — {description}" if description else ""))

    return (
        "\n\nTOOLS\n"
        "Use tools only when needed. Tool calls are fenced YAML blocks; normal prose may appear around them.\n"
        "```yaml\ntool: TOOL_NAME\narguments: {ARG: VALUE}\n```\n"
        "Multiple tool calls are allowed when the task requires them. After results, continue the original task and call another tool only if needed.\n"
        "Use only listed arguments and allowed values.\n"
        + "\n".join(rows)
    )


def _file_output_instructions() -> str:
    return (
        "\n\nFILE OUTPUT PROTOCOL\n"
        "When the task requires creating or completely rewriting a text file, you may write it directly "
        "using a fenced file block. This is not a YAML tool call. Use exactly this shape:\n\n"
        "```file:C:\\path\\to\\file.py\n"
        "print(\"hello\")\n"
        "```\n\n"
        "Rules:\n"
        "- Put the destination path immediately after `file:` on the opening fence.\n"
        "- Everything between the opening and closing fences is written verbatim as UTF-8 file content.\n"
        "- Do not place the file contents inside YAML, JSON, PowerShell, or another tool argument.\n"
        "- When using a file block, output the file block directly without introductory prose.\n"
        "- Use this for whole-file creation or whole-file replacement. Use normal tools to inspect existing files when needed.\n"
        "- After Tiny Web Agent reports the write result, continue the original task and verify with a tool if verification is needed.\n"
    )


def _system_message(
    settings: dict[str, Any],
    active_tool_schemas: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    base = str(settings.get("system_prompt") or "You are a helpful assistant.").strip()
    file_instructions = (
        _file_output_instructions() if is_tool_enabled(settings, "direct_file_output") else ""
    )
    tool_instructions = (
        _compact_yaml_tool_instructions(active_tool_schemas)
        if settings.get("compact_tool_prompt")
        else _yaml_tool_instructions(active_tool_schemas)
    )
    return {
        "role": "system",
        "content": f"{base} Today's date is {str(date.today())}.{file_instructions}{tool_instructions}",
    }


def normalize_state(
    state: list[dict[str, Any]] | None,
    settings: dict[str, Any],
    active_tool_schemas: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    state = deepcopy(state or [])
    system = _system_message(settings, active_tool_schemas)
    if state and state[0].get("role") == "system":
        state[0] = system
    else:
        state.insert(0, system)
    return state


def run_agent_turn(
    *,
    model_path: str,
    settings: dict[str, Any],
    state: list[dict[str, Any]] | None,
    prompt: str,
    event_callback: EventCallback | None = None,
    file_overwrite_callback: FileOverwriteCallback | None = None,
    tool_bundle: tuple[dict[str, Callable[..., Any]], list[dict[str, Any]]] | None = None,
    system_prompt_override: str | None = None,
    append_action_summary: bool = True,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """Run one full user turn, including any tool calls, using local state."""

    prompt = prompt.strip()
    if not prompt:
        return "", normalize_state(state, settings), {}

    with model_manager.inference_lock:
        model_manager.clear_cancel()
        effective_settings = dict(settings)
        if system_prompt_override is not None:
            effective_settings["system_prompt"] = system_prompt_override
        if tool_bundle is not None:
            # Dedicated contexts (such as Browser-OS control) explicitly own their
            # small tool surface and never inherit general chat/file tools.
            overrides = dict(effective_settings.get("tool_overrides") or {})
            overrides["direct_file_output"] = False
            effective_settings["tool_overrides"] = overrides
            active_tool_functions, active_tool_schemas = tool_bundle
            file_output_enabled = False
        else:
            active_tool_functions, active_tool_schemas = get_enabled_tool_bundle(effective_settings)
            file_output_enabled = is_tool_enabled(effective_settings, "direct_file_output")
        llm = model_manager.ensure_loaded(model_path, effective_settings, event_callback=event_callback)
        messages = normalize_state(state, effective_settings, active_tool_schemas)
        messages.append({"role": "user", "content": prompt})

        tool_count = 0
        max_tool_calls = max(0, int(effective_settings.get("max_tool_calls", 10)))
        timings: list[dict[str, Any]] = []
        tool_traces: list[dict[str, Any]] = []

        while True:
            # Once the tool-call budget is exhausted, remove tool instructions from
            # the system prompt so the model is steered toward a final answer.
            prompt_settings = effective_settings
            if tool_count >= max_tool_calls and file_output_enabled:
                # Exhausting the shared action budget temporarily suppresses the
                # direct-file capability from the system prompt as well.
                prompt_settings = dict(effective_settings)
                overrides = dict(prompt_settings.get("tool_overrides") or {})
                overrides["direct_file_output"] = False
                prompt_settings["tool_overrides"] = overrides
            messages[0] = _system_message(
                prompt_settings,
                active_tool_schemas if tool_count < max_tool_calls else [],
            )

            # Only temperature, max_tokens and streaming are explicitly set by
            # default. Extra sampling knobs are optional
            # web overrides and are omitted when left on Auto.
            request: dict[str, Any] = {
                "messages": messages,
                "temperature": float(effective_settings.get("temperature", 0.05)),
                "max_tokens": max(1, int(effective_settings.get("max_tokens", 3000))),
                "stream": True,
            }

            if effective_settings.get("top_p") is not None:
                request["top_p"] = float(effective_settings["top_p"])
            if effective_settings.get("top_k") is not None:
                request["top_k"] = max(0, int(effective_settings["top_k"]))
            if effective_settings.get("repeat_penalty") is not None:
                request["repeat_penalty"] = float(effective_settings["repeat_penalty"])

            try:
                llama_cpp.llama_perf_context_reset(llm.ctx)
            except Exception:
                pass

            start = time.perf_counter()
            first_token: float | None = None
            _emit(
                event_callback,
                "inference_start",
                estimated_context_tokens=estimate_message_tokens(llm, messages),
                tools=(len(active_tool_schemas) if tool_count < max_tool_calls else 0),
            )

            stream = llm.create_chat_completion(**request)
            content = ""
            streaming_answer = False
            cancelled = False
            finish_reason: str | None = None

            for chunk in stream:
                if model_manager.cancel_event.is_set():
                    cancelled = True
                    break

                try:
                    choice = chunk["choices"][0]
                    if choice.get("finish_reason"):
                        finish_reason = str(choice.get("finish_reason"))
                    delta = choice["delta"]
                except (KeyError, IndexError, TypeError):
                    continue

                piece = delta.get("content") or ""
                if not piece:
                    continue

                if first_token is None:
                    first_token = time.perf_counter()
                content += piece

                if not streaming_answer:
                    if not looks_like_agent_action(
                        content,
                        active_tool_functions,
                        file_output_enabled=(file_output_enabled and tool_count < max_tool_calls),
                    ):
                        _emit(event_callback, "token", text=content)
                        streaming_answer = True
                else:
                    _emit(event_callback, "token", text=piece)

            end = time.perf_counter()
            # Start/restart the five-minute idle countdown from the end of the
            # most recent generation. The inference lock remains held until the
            # full agent turn ends, so long tool calls are also protected.
            model_manager.touch()
            perf = _perf_payload(llm, start, first_token, end)
            timings.append(perf)
            _emit(event_callback, "timing", **perf)

            if cancelled:
                # Finalize the interrupted generation as a real assistant turn.
                # This is important because a new prompt may be queued immediately
                # afterward; preserving this boundary keeps strict role alternation:
                # user -> assistant(partial) -> user -> assistant.
                interrupted_content = content.rstrip()
                if interrupted_content:
                    interrupted_content += "\n\n[Interrupted by user]"
                else:
                    interrupted_content = "[Interrupted by user]"

                if not streaming_answer:
                    _emit(event_callback, "token", text=interrupted_content)
                elif interrupted_content != content:
                    _emit(event_callback, "token", text="\n\n[Interrupted by user]")

                messages.append({"role": "assistant", "content": interrupted_content})
                return interrupted_content, messages, {
                    "timings": timings,
                    "tool_calls": tool_count,
                    "tool_traces": tool_traces,
                    "cancelled": True,
                }

            file_blocks = parse_file_blocks(content) if file_output_enabled else []
            if file_blocks:
                write_results: list[str] = []
                compact_records: list[str] = []

                for path_text, file_content in file_blocks:
                    if tool_count >= max_tool_calls:
                        write_results.append(
                            f"File write skipped for {path_text}: maximum agent-action count reached."
                        )
                        continue

                    tool_count += 1
                    result = write_file_block(
                        path_text,
                        file_content,
                        confirm_overwrite=file_overwrite_callback,
                    )
                    if result.get("ok"):
                        compact_records.append(
                            f"[File written: {result['path']} ({result['bytes']} bytes)]"
                        )
                        write_results.append(
                            "File write succeeded:\n"
                            f"Path: {result['path']}\n"
                            f"Characters: {result['characters']}\n"
                            f"Bytes: {result['bytes']}"
                        )
                    else:
                        compact_records.append(f"[File write failed: {path_text}]")
                        write_results.append(
                            "File write failed:\n"
                            f"Path: {result.get('path', path_text)}\n"
                            f"Error: {result.get('error', 'Unknown error')}"
                        )

                # Do not retain the potentially huge generated file body in the
                # model's next context. The file itself is now the source of truth.
                messages.append(
                    {
                        "role": "assistant",
                        "content": "\n".join(compact_records) or "[File output processed]",
                    }
                )

                if tool_count >= max_tool_calls:
                    continuation = (
                        "\n\nThe maximum number of agent actions has been reached. "
                        "Do not write another file or call another tool. Answer the original request now."
                    )
                else:
                    continuation = (
                        "\n\nContinue the original task. Do not rewrite the same file again unless correction is needed. "
                        "If verification or further computer work is needed, use a fenced YAML tool call. "
                        "Otherwise answer the user normally."
                    )

                messages.append(
                    {
                        "role": "user",
                        "content": "\n\n".join(write_results) + continuation,
                    }
                )
                continue

            parsed_calls, tool_parse_errors = parse_tool_calls(content, active_tool_functions)

            if tool_parse_errors and not parsed_calls:
                messages.append({"role": "assistant", "content": content})
                error_blocks: list[str] = []

                for error in tool_parse_errors:
                    location = ""
                    if error.get("line") is not None:
                        location = f" (line {error['line']}, column {error.get('column') or '?'})"
                    tool_line = f"Tool: {error['tool']}\n" if error.get("tool") else ""
                    error_blocks.append(
                        "Your attempted YAML tool call could not be executed.\n"
                        f"{tool_line}"
                        f"YAML/tool parser error{location}: {error['message']}\n"
                        f"Invalid block excerpt:\n{error['snippet']}\n\n"
                        "Correct it and try again using a fenced YAML block. Do not switch to JSON. "
                        "For multiline PowerShell commands, use `cmd: |` and write Windows paths normally."
                    )

                messages.append({"role": "user", "content": "\n\n".join(error_blocks)})
                continue

            if parsed_calls:
                messages.append({"role": "assistant", "content": content})
                results: list[str] = []
                tool_failed = False

                for name, arguments in parsed_calls:
                    if tool_count >= max_tool_calls:
                        break
                    tool_count += 1
                    result, trace = execute_tool(
                        name, arguments, event_callback, active_tool_functions, active_tool_schemas, sequence=tool_count
                    )
                    tool_traces.append(trace)
                    if result.startswith("Tool error:") or result.startswith("Tool is disabled or unknown:"):
                        tool_failed = True
                    results.append(f"Tool result from {name}:\n\n{result}")

                if tool_count >= max_tool_calls:
                    instruction = (
                        "\n\nYou have reached the maximum number of tool calls. "
                        "Do not call another tool. Answer the original request now using the information gathered."
                    )
                elif tool_failed:
                    instruction = (
                        "\n\nIMPORTANT: At least one tool call failed. The requested external action has NOT "
                        "been confirmed as completed. Do not claim that an event was created, an email was sent, "
                        "a file was changed, or any other action succeeded unless a successful tool result explicitly "
                        "confirms it. If the error can be corrected safely, retry with another fenced YAML tool call. "
                        "Otherwise report the failure briefly and accurately."
                    )
                else:
                    instruction = (
                        "\n\nContinue working on the original request. "
                        "Do not assume success unless the tool result confirms it. "
                        "If more computer or external-state work is needed, use another fenced YAML tool call. "
                        "Otherwise answer the user normally."
                    )

                messages.append({"role": "user", "content": "\n\n".join(results) + instruction})
                continue

            if not streaming_answer and content:
                _emit(event_callback, "token", text=content)

            action_summary = _brief_action_summary(tool_traces)
            final_content = content.rstrip()
            if append_action_summary:
                if final_content:
                    final_content += "\n\n" + action_summary
                    _emit(event_callback, "token", text="\n\n" + action_summary)
                else:
                    final_content = action_summary
                    _emit(event_callback, "token", text=action_summary)

            messages.append({"role": "assistant", "content": final_content})

            if bool(effective_settings.get("compaction_enabled", True)):
                result = compact_conversation_if_needed(
                    llm=llm,
                    messages=messages,
                    threshold_tokens=max(512, int(effective_settings.get("compaction_threshold", 3500))),
                    target_tokens=max(256, int(effective_settings.get("compaction_target", 2500))),
                    keep_recent_turns=max(1, int(effective_settings.get("keep_recent_turns", 2))),
                    max_summary_tokens=max(32, int(effective_settings.get("summary_max_tokens", 180))),
                )
                if result.compacted or result.tool_chains_collapsed:
                    _emit(
                        event_callback,
                        "compaction",
                        compacted=result.compacted,
                        turns_compacted=result.turns_compacted,
                        tool_chains_collapsed=result.tool_chains_collapsed,
                        estimated_tokens_after=result.estimated_tokens_after,
                    )

            return final_content, messages, {
                "timings": timings,
                "tool_calls": tool_count,
                "tool_traces": tool_traces,
                "action_summary": action_summary,
                "cancelled": False,
                "finish_reason": finish_reason,
                "estimated_state_tokens": estimate_message_tokens(llm, messages),
            }