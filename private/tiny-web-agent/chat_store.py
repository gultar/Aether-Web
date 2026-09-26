from __future__ import annotations

import json
import ntpath
import os
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from runtime_paths import APP_DIR, DATA_DIR

DB_PATH = DATA_DIR / "chat.db"

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful agent with access to tools. "
    "Use tools whenever they are needed to complete the user's task. "
    "When using a tool, output the tool call directly without explaining "
    "that you are about to use it. "
    "After receiving tool results, continue working on the original task. "
)

# Default web-agent settings. Optional llama.cpp values remain None/"default"
# unless the user overrides them in the web UI.
DEFAULT_SETTINGS: dict[str, Any] = {
    "temperature": 0.05,
    "max_tokens": 3000,
    "top_p": None,
    "top_k": None,
    "repeat_penalty": None,
    "context_length": 65536,
    "gpu_layers": -1,
    "n_batch": None,
    "n_ubatch": None,
    "threads": 8,
    "flash_attention": True,
    "offload_kqv": None,
    "kv_cache": "default",
    "max_tool_calls": 10,
    "tools_enabled": True,
    "tool_policy_version": 2,
    # "auto" lets Ministral choose from the retrieved candidate skills.
    # A concrete skill name forces that skill for the conversation until the
    # user switches back to Auto in the Tiny Web Agent toolbar.
    "skill_mode": "auto",
    # Per-tool choices. Missing names fall back to the registry default, which
    # keeps old conversations compatible when new tools are added later.
    "tool_overrides": {},
    "compaction_enabled": True,
    "compaction_threshold": 3500,
    "compaction_target": 2500,
    "keep_recent_turns": 2,
    "summary_max_tokens": 180,
    "system_prompt": DEFAULT_SYSTEM_PROMPT,
}


_db_lock = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _quarantine_malformed_db(reason: str) -> Path | None:
    """Preserve a corrupt SQLite database and its WAL sidecars before rebuilding."""
    if not DB_PATH.exists():
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = DB_PATH.with_name(f"{DB_PATH.name}.malformed-{stamp}.bak")
    DB_PATH.replace(backup)
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(DB_PATH) + suffix)
        if sidecar.exists():
            try:
                sidecar.replace(Path(str(backup) + suffix))
            except OSError:
                pass
    print(
        f"[Tiny Agent] SQLite database was malformed ({reason}). "
        f"Preserved it as {backup} and created a fresh database.",
        file=sys.stderr,
    )
    return backup


def _validate_or_recover_db() -> None:
    if not DB_PATH.exists():
        return
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        rows = conn.execute("PRAGMA quick_check").fetchall()
        problems = [str(row[0]) for row in rows if row and str(row[0]).lower() != "ok"]
        if problems:
            raise sqlite3.DatabaseError("; ".join(problems[:3]))
    except sqlite3.DatabaseError as error:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            conn = None
        _quarantine_malformed_db(str(error))
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _merge_settings(value: str | dict[str, Any] | None) -> dict[str, Any]:
    settings = DEFAULT_SETTINGS.copy()
    if isinstance(value, str) and value:
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = {}
    if isinstance(value, dict):
        # v2 intentionally narrows the default agent surface to DuckDuckGo + CBC.
        # Older BrowserOS builds persisted broad per-tool overrides in chat.db;
        # carrying those forward would silently defeat the new defaults. Reset
        # legacy overrides once on read. Users can explicitly re-enable tools in
        # the UI afterward, and the saved v2 settings will then preserve them.
        legacy_tool_policy = int(value.get("tool_policy_version") or 0) < 2
        settings.update(value)
        if legacy_tool_policy:
            settings["tool_overrides"] = {}
            settings["tool_policy_version"] = 2
    return settings


def init_db() -> None:
    with _db_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _validate_or_recover_db()
        with _connect() as conn:
            conn.executescript(
                """
            CREATE TABLE IF NOT EXISTS models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                model_id INTEGER,
                settings_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_presets_name
                ON presets(name COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                model_id INTEGER,
                settings_json TEXT NOT NULL,
                agent_state_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                UNIQUE(conversation_id, position)
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation_position
                ON messages(conversation_id, position);

            CREATE TABLE IF NOT EXISTS tool_traces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                assistant_message_id INTEGER NOT NULL,
                sequence INTEGER NOT NULL,
                name TEXT NOT NULL,
                arguments_json TEXT NOT NULL,
                result TEXT NOT NULL,
                duration_seconds REAL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                FOREIGN KEY(assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_tool_traces_message_sequence
                ON tool_traces(assistant_message_id, sequence);
                """
            )


def normalize_model_path(path: str) -> str:
    """Normalize a user-entered model path without resolving symlinks/drives."""
    raw = str(path or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"\"", "'"}:
        raw = raw[1:-1].strip()
    raw = os.path.expandvars(os.path.expanduser(raw))

    if sys.platform == "win32":
        # Accept both C:\\Models\\model.gguf and C:/Models/model.gguf.
        raw = raw.replace("/", "\\")
        if not ntpath.isabs(raw):
            raw = ntpath.join(str(APP_DIR), raw)
        return ntpath.normpath(raw)

    p = Path(raw)
    if not p.is_absolute():
        p = APP_DIR / p
    return os.path.normpath(str(p))


def resolve_model_path(path: str) -> Path:
    return Path(normalize_model_path(path))


# Backward-compatible private alias used by older code in this project.
def _resolve_model_path(path: str) -> Path:
    return resolve_model_path(path)


def add_model(path: str, name: str | None = None) -> dict[str, Any]:
    normalized = normalize_model_path(path)
    p = Path(normalized)
    display_name = (name or p.stem or normalized).strip()
    with _db_lock, _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO models(name, path, created_at) VALUES (?, ?, ?)",
            (display_name, normalized, _now()),
        )
        row = conn.execute("SELECT * FROM models WHERE path = ?", (normalized,)).fetchone()
    return dict(row)


def remove_model(model_id: int) -> None:
    with _db_lock, _connect() as conn:
        conn.execute("DELETE FROM models WHERE id = ?", (model_id,))


def list_models() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM models ORDER BY name COLLATE NOCASE").fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["exists"] = Path(item["path"]).exists()
        result.append(item)
    return result


def get_model(model_id: int | None) -> dict[str, Any] | None:
    if model_id is None:
        return None
    with _connect() as conn:
        row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
    return dict(row) if row else None


def _preset_from_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    item = dict(row)
    item["settings"] = _merge_settings(item.pop("settings_json"))
    return item


def list_presets() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT p.*, m.name AS model_name
            FROM presets p
            LEFT JOIN models m ON m.id = p.model_id
            ORDER BY p.name COLLATE NOCASE
            """
        ).fetchall()
    return [_preset_from_row(row) for row in rows]


def get_preset(preset_id: str | None) -> dict[str, Any] | None:
    if not preset_id:
        return None
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT p.*, m.name AS model_name
            FROM presets p
            LEFT JOIN models m ON m.id = p.model_id
            WHERE p.id = ?
            """,
            (preset_id,),
        ).fetchone()
    return _preset_from_row(row)


def create_preset(
    name: str,
    *,
    description: str = "",
    model_id: int | None = None,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    clean_name = " ".join(str(name or "").strip().split())
    if not clean_name:
        raise ValueError("Preset name cannot be empty")
    preset_id = str(uuid.uuid4())
    now = _now()
    normalized_settings = _merge_settings(settings)
    with _db_lock, _connect() as conn:
        conn.execute(
            """
            INSERT INTO presets(id, name, description, model_id, settings_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                preset_id,
                clean_name,
                str(description or "").strip(),
                model_id,
                json.dumps(normalized_settings, ensure_ascii=False),
                now,
                now,
            ),
        )
    return get_preset(preset_id)


def update_preset(
    preset_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    model_id: int | None | object = ...,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = get_preset(preset_id)
    if current is None:
        raise KeyError("Preset not found")
    new_name = current["name"] if name is None else " ".join(str(name).strip().split())
    if not new_name:
        raise ValueError("Preset name cannot be empty")
    new_description = current["description"] if description is None else str(description or "").strip()
    new_model_id = current["model_id"] if model_id is ... else model_id
    new_settings = current["settings"] if settings is None else _merge_settings(settings)
    with _db_lock, _connect() as conn:
        conn.execute(
            """
            UPDATE presets
            SET name = ?, description = ?, model_id = ?, settings_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                new_name,
                new_description,
                new_model_id,
                json.dumps(new_settings, ensure_ascii=False),
                _now(),
                preset_id,
            ),
        )
    return get_preset(preset_id)


def delete_preset(preset_id: str) -> None:
    with _db_lock, _connect() as conn:
        conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))


def create_conversation(
    model_id: int | None = None,
    *,
    preset_id: str | None = None,
) -> dict[str, Any]:
    conversation_id = str(uuid.uuid4())
    now = _now()

    preset = get_preset(preset_id) if preset_id else None
    if preset_id and preset is None:
        raise KeyError("Preset not found")

    if preset is not None:
        settings = _merge_settings(preset["settings"])
        model_id = preset.get("model_id")
    else:
        settings = DEFAULT_SETTINGS.copy()

    state = [{"role": "system", "content": settings["system_prompt"]}]
    with _db_lock, _connect() as conn:
        conn.execute(
            """
            INSERT INTO conversations(
                id, title, model_id, settings_json, agent_state_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conversation_id,
                "New chat",
                model_id,
                json.dumps(settings, ensure_ascii=False),
                json.dumps(state, ensure_ascii=False),
                now,
                now,
            ),
        )
    return get_conversation(conversation_id, include_messages=True)


def list_conversations() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.title, c.model_id, c.created_at, c.updated_at, m.name AS model_name
            FROM conversations c
            LEFT JOIN models m ON m.id = c.model_id
            ORDER BY c.updated_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def get_conversation(conversation_id: str, include_messages: bool = True) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT c.*, m.name AS model_name, m.path AS model_path
            FROM conversations c
            LEFT JOIN models m ON m.id = c.model_id
            WHERE c.id = ?
            """,
            (conversation_id,),
        ).fetchone()
        if not row:
            return None
        item = dict(row)
        item["settings"] = _merge_settings(item.pop("settings_json"))
        try:
            item["agent_state"] = json.loads(item.pop("agent_state_json"))
        except json.JSONDecodeError:
            item["agent_state"] = [{"role": "system", "content": item["settings"]["system_prompt"]}]
        if include_messages:
            messages = conn.execute(
                "SELECT id, position, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY position",
                (conversation_id,),
            ).fetchall()
            item["messages"] = [dict(message) for message in messages]

            traces = conn.execute(
                """
                SELECT id, assistant_message_id, sequence, name, arguments_json,
                       result, duration_seconds, created_at
                FROM tool_traces
                WHERE conversation_id = ?
                ORDER BY assistant_message_id, sequence, id
                """,
                (conversation_id,),
            ).fetchall()
            traces_by_message: dict[int, list[dict[str, Any]]] = {}
            for trace_row in traces:
                trace = dict(trace_row)
                try:
                    trace["arguments"] = json.loads(trace.pop("arguments_json"))
                except (json.JSONDecodeError, TypeError):
                    trace["arguments"] = {}
                    trace.pop("arguments_json", None)
                traces_by_message.setdefault(int(trace["assistant_message_id"]), []).append(trace)

            for message in item["messages"]:
                message["tool_traces"] = traces_by_message.get(int(message["id"]), [])
    return item


def update_conversation(
    conversation_id: str,
    *,
    title: str | None = None,
    model_id: int | None | object = ...,
    settings: dict[str, Any] | None = None,
    agent_state: list[dict[str, Any]] | None = None,
) -> None:
    current = get_conversation(conversation_id, include_messages=False)
    if current is None:
        raise KeyError("Conversation not found")

    new_title = current["title"] if title is None else title.strip() or "New chat"
    new_model_id = current["model_id"] if model_id is ... else model_id
    new_settings = current["settings"] if settings is None else _merge_settings(settings)
    new_state = current["agent_state"] if agent_state is None else agent_state

    # Keep the state system message synchronized with the editable system prompt.
    system_prompt = str(new_settings.get("system_prompt") or DEFAULT_SYSTEM_PROMPT)
    if new_state and new_state[0].get("role") == "system":
        new_state[0] = {"role": "system", "content": system_prompt}
    else:
        new_state.insert(0, {"role": "system", "content": system_prompt})

    with _db_lock, _connect() as conn:
        conn.execute(
            """
            UPDATE conversations
            SET title = ?, model_id = ?, settings_json = ?, agent_state_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                new_title,
                new_model_id,
                json.dumps(new_settings, ensure_ascii=False),
                json.dumps(new_state, ensure_ascii=False),
                _now(),
                conversation_id,
            ),
        )


def delete_conversation(conversation_id: str) -> None:
    with _db_lock, _connect() as conn:
        conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))


def delete_conversations(conversation_ids: list[str]) -> int:
    """Delete multiple conversations in one transaction and return the number removed."""
    ids = [str(item).strip() for item in conversation_ids if str(item).strip()]
    # Preserve order while removing duplicates.
    ids = list(dict.fromkeys(ids))
    if not ids:
        return 0

    placeholders = ",".join("?" for _ in ids)
    with _db_lock, _connect() as conn:
        cursor = conn.execute(
            f"DELETE FROM conversations WHERE id IN ({placeholders})",
            ids,
        )
        return max(0, int(cursor.rowcount or 0))


def append_message(conversation_id: str, role: str, content: str) -> dict[str, Any]:
    with _db_lock, _connect() as conn:
        position = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM messages WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()[0]
        now = _now()
        cursor = conn.execute(
            "INSERT INTO messages(conversation_id, position, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (conversation_id, position, role, content, now),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        message_id = cursor.lastrowid
    return {
        "id": message_id,
        "position": position,
        "role": role,
        "content": content,
        "created_at": now,
    }



def append_tool_traces(
    conversation_id: str,
    assistant_message_id: int,
    traces: list[dict[str, Any]],
) -> None:
    """Persist inspectable tool activity separately from the model conversation state."""
    if not traces:
        return
    now = _now()
    rows = []
    for index, trace in enumerate(traces, start=1):
        rows.append((
            conversation_id,
            int(assistant_message_id),
            int(trace.get("sequence", index)),
            str(trace.get("name") or "tool"),
            json.dumps(trace.get("arguments") or {}, ensure_ascii=False),
            str(trace.get("result") or ""),
            None if trace.get("duration_seconds") is None else float(trace["duration_seconds"]),
            now,
        ))
    with _db_lock, _connect() as conn:
        conn.executemany(
            """
            INSERT INTO tool_traces(
                conversation_id, assistant_message_id, sequence, name, arguments_json,
                result, duration_seconds, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


def edit_user_message_and_truncate(
    conversation_id: str,
    message_id: int,
    content: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Edit one user message in place and discard everything after it.

    The conversation keeps the same id. The model state is rebuilt only from
    canonical visible messages *before* the edited message so the edited text
    can be passed through the normal agent-turn path exactly once. Deleting
    later messages also deletes their tool traces through SQLite foreign-key
    cascades.
    """
    edited_content = str(content or "").strip()
    if not edited_content:
        raise ValueError("Message cannot be empty")

    with _db_lock, _connect() as conn:
        source = conn.execute(
            "SELECT * FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if source is None:
            raise KeyError("Conversation not found")

        target = conn.execute(
            "SELECT * FROM messages WHERE id = ? AND conversation_id = ?",
            (int(message_id), conversation_id),
        ).fetchone()
        if target is None:
            raise KeyError("Message not found")
        if target["role"] != "user":
            raise ValueError("Only user messages can be edited")

        prior_messages = conn.execute(
            """
            SELECT id, position, role, content, created_at
            FROM messages
            WHERE conversation_id = ? AND position < ?
            ORDER BY position
            """,
            (conversation_id, int(target["position"])),
        ).fetchall()

        try:
            settings = _merge_settings(source["settings_json"])
        except Exception:
            settings = DEFAULT_SETTINGS.copy()

        rebuilt_state: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": str(settings.get("system_prompt") or DEFAULT_SYSTEM_PROMPT),
            }
        ]
        for message in prior_messages:
            if message["role"] in {"user", "assistant"}:
                rebuilt_state.append({
                    "role": message["role"],
                    "content": message["content"],
                })

        now = _now()

        # Preserve manually assigned titles. If the current title is simply the
        # auto-title derived from the old first message, update it to match the
        # edited first message instead.
        title = str(source["title"] or "New chat")
        if int(target["position"]) == 0:
            old_clean = " ".join(str(target["content"] or "").strip().split())
            old_auto_title = old_clean[:52] + ("…" if len(old_clean) > 52 else "")
            new_clean = " ".join(edited_content.split())
            new_auto_title = new_clean[:52] + ("…" if len(new_clean) > 52 else "")
            if title in {"New chat", old_auto_title}:
                title = new_auto_title or "New chat"

        # Remove all responses and later turns first. Their tool traces are
        # removed automatically because tool_traces references messages with
        # ON DELETE CASCADE.
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND position > ?",
            (conversation_id, int(target["position"])),
        )
        conn.execute(
            "UPDATE messages SET content = ? WHERE id = ? AND conversation_id = ?",
            (edited_content, int(message_id), conversation_id),
        )
        conn.execute(
            """
            UPDATE conversations
            SET title = ?, agent_state_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                json.dumps(rebuilt_state, ensure_ascii=False),
                now,
                conversation_id,
            ),
        )

        edited_message = conn.execute(
            "SELECT id, position, role, content, created_at FROM messages WHERE id = ?",
            (int(message_id),),
        ).fetchone()

    conversation = get_conversation(conversation_id, include_messages=True)
    if conversation is None or edited_message is None:
        raise KeyError("Conversation not found")
    return conversation, dict(edited_message)

def maybe_set_title_from_first_user_message(conversation_id: str, content: str) -> None:
    with _db_lock, _connect() as conn:
        row = conn.execute("SELECT title FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if not row or row["title"] != "New chat":
            return
        clean = " ".join(content.strip().split())
        if not clean:
            return
        title = clean[:52] + ("…" if len(clean) > 52 else "")
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title, _now(), conversation_id),
        )


def scan_model_path(path: str) -> list[dict[str, Any]]:
    p = _resolve_model_path(path)
    found: list[Path] = []
    if p.is_file() and p.suffix.lower() == ".gguf":
        found = [p]
    elif p.is_dir():
        found = sorted(p.glob("*.gguf"))
    else:
        raise FileNotFoundError(f"Path does not exist: {p}")

    result = []
    for model_path in found:
        result.append(add_model(str(model_path)))
    return result
