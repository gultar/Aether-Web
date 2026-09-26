from __future__ import annotations

import argparse
import json
from datetime import date, datetime, time as datetime_time
import logging
import os
import queue
import re
import threading
import time
import uuid
import webbrowser
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from werkzeug.utils import secure_filename

import chat_store
from markdown_renderer import render_markdown
from runtime_paths import APP_DIR, RESOURCE_DIR
from web_agent import model_manager, run_agent_turn, run_background_composition
from browser_os_tools import OS_TOOL_FUNCTIONS, OS_TOOL_SCHEMAS, PROJECT_ROOT
from project_context import build_project_tree
from skill_manager import (
    CATEGORY_DESCRIPTIONS, Skill, create_category, delete_category, delete_skill, get_skill,
    is_starter_skill, load_category_descriptions, load_skills, parse_skill_text, read_skill_text,
    retrieve_candidates, save_new_skill, update_category, update_existing_skill, validate_skill_tools,
)
from research_pipeline import build_evidence_pack
from tools.attachments import build_attachment_context, delete_conversation_attachments, save_attachment
from tools.tool_registry import (
    EXTERNAL_TOOL_TEMPLATE, EXTERNAL_TOOLS_DIR, TOOL_REGISTRY, get_tool_descriptors,
    normalize_tool_overrides, register_external_tool_definition, reload_external_tools,
    list_external_tool_records, read_external_tool_bundle, normalize_external_tool_bundle,
    save_external_tool_bundle, delete_external_tool_bundle,
)

app = Flask(
    __name__,
    template_folder=str(RESOURCE_DIR / "templates"),
    static_folder=str(RESOURCE_DIR / "static"),
)

# This is a local desktop-style app. Never let the browser reuse JS/CSS from
# an older build that happened to run on the same localhost port.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

# One compact filesystem map per devmode session. Re-entering devmode creates a
# new session id in the browser and therefore a fresh tree from the real project.
_DEV_PROJECT_TREE_CACHE: dict[str, str] = {}
_DEV_PROJECT_TREE_LOCK = threading.RLock()

# Persistent Browser-OS agent conversation state, keyed by terminal session.
# This is intentionally in-memory: closing/restarting Browser-OS starts clean.
_OS_SESSION_STATES: dict[str, list[dict[str, Any]]] = {}
_OS_SESSION_LOCK = threading.RLock()
_OS_SESSION_MAX_MESSAGES = 24

def _os_session_key(body: dict[str, Any]) -> str:
    state = body.get("state") if isinstance(body.get("state"), dict) else {}
    return str(body.get("ossession") or state.get("__ossession") or "").strip()[:128]

def _os_session_get(key: str) -> list[dict[str, Any]]:
    if not key:
        return []
    with _OS_SESSION_LOCK:
        return [dict(m) for m in _OS_SESSION_STATES.get(key, [])]

def _os_session_set(key: str, state: list[dict[str, Any]]) -> None:
    if not key:
        return
    messages = [dict(m) for m in (state or []) if isinstance(m, dict)]
    if len(messages) > _OS_SESSION_MAX_MESSAGES:
        system = messages[:1] if messages and messages[0].get("role") == "system" else []
        messages = system + messages[-_OS_SESSION_MAX_MESSAGES:]
    with _OS_SESSION_LOCK:
        if len(_OS_SESSION_STATES) >= 64 and key not in _OS_SESSION_STATES:
            _OS_SESSION_STATES.pop(next(iter(_OS_SESSION_STATES)))
        _OS_SESSION_STATES[key] = messages

def _os_session_clear(key: str) -> None:
    if not key:
        return
    with _OS_SESSION_LOCK:
        _OS_SESSION_STATES.pop(key, None)

def _dev_project_tree(session_id: str) -> str:
    key = str(session_id or '').strip()[:128]
    if not key:
        return build_project_tree(PROJECT_ROOT)
    with _DEV_PROJECT_TREE_LOCK:
        tree = _DEV_PROJECT_TREE_CACHE.get(key)
        if tree is None:
            tree = build_project_tree(PROJECT_ROOT)
            # Bound stale sessions in long-running Browser-OS processes.
            if len(_DEV_PROJECT_TREE_CACHE) >= 32:
                _DEV_PROJECT_TREE_CACHE.pop(next(iter(_DEV_PROJECT_TREE_CACHE)))
            _DEV_PROJECT_TREE_CACHE[key] = tree
        return tree

# Frozen console builds can end up with a Colorama-wrapped stream that fails
# when Werkzeug writes access-log INFO lines. The browser UI already exposes
# request errors, so suppress only the noisy per-request access log.
logging.getLogger("werkzeug").setLevel(logging.ERROR)


def _json_stream_default(value: Any):
    """Serialize common non-JSON Python values used in streamed metadata."""
    if isinstance(value, (datetime, date, datetime_time)):
        return value.isoformat()
    if isinstance(value, os.PathLike):
        return os.fspath(value)
    if isinstance(value, (set, frozenset)):
        return list(value)
    raise TypeError(
        f"Object of type {value.__class__.__name__} is not JSON serializable"
    )


# Pending overwrite confirmations for direct ```file:path blocks.
_pending_file_confirmations: dict[str, dict[str, Any]] = {}
_pending_file_confirmations_lock = threading.Lock()


@app.after_request
def disable_local_asset_cache(response):
    if request.path == "/" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


@app.get("/api/identity")
def agent_identity():
    """Let BrowserOS verify that a localhost port belongs to this exact agent tree."""
    return jsonify({
        "kind": "tiny-web-agent",
        "app_dir": str(APP_DIR.resolve()),
        "skills": True,
        "api_version": 3,
    })


@app.get("/")
def index():
    return render_template("index.html")


def _browser_os_model_and_settings():
    """Use the most recently selected chat model without sharing chat history/tools."""
    conversations = chat_store.list_conversations()
    for item in conversations:
        model_id = item.get("model_id")
        if model_id is None:
            continue
        model = chat_store.get_model(model_id)
        if model and Path(model.get("path", "")).exists():
            full = chat_store.get_conversation(item["id"], include_messages=False)
            settings = dict((full or {}).get("settings") or chat_store.DEFAULT_SETTINGS)
            return model, settings

    # If no conversation currently selects a model, fall back to any registered
    # model that still exists on disk. This does not create or alter a chat.
    for model in chat_store.list_models():
        if model.get("exists"):
            return model, dict(chat_store.DEFAULT_SETTINGS)
    return None, dict(chat_store.DEFAULT_SETTINGS)



# BrowserOS skill routing -----------------------------------------------------
# The normal BrowserOS agent sees only these two baseline tools. Specialized
# BrowserOS capabilities are added only by the selected skill.
_BROWSER_OS_BASE_TOOL_NAMES = ("duckduckgo_search", "cbc_top_stories")
_BROWSER_OS_SKILL_TOP_K = 5


def _recent_tiny_task_context(messages: list[dict[str, Any]] | None) -> str:
    """Compact persistent Tiny Web Agent history into task state for a fresh skill turn."""
    if not messages:
        return ""
    picked: list[str] = []
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        if role not in {"user", "assistant"}:
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        label = "Previous user" if role == "user" else "Previous assistant"
        picked.append(f"{label}: {content[:900]}")
        if len(picked) >= 3:
            break
    return "\n".join(reversed(picked))[:2200]


def _tiny_skill_tool_bundle(skill: Skill, settings: dict[str, Any]):
    """Return the deliberately small tool surface for a Tiny Web Agent turn."""
    if skill.name == "general":
        # General is intentionally tool-free. Returning an explicit empty bundle
        # prevents Tiny Web Agent from falling back to default web/news tools.
        return ({}, [])
    return _browser_os_tool_bundle(skill)


def _tiny_skill_system_prompt(skill: Skill) -> str:
    context_meta = skill.metadata.get("context") if isinstance(skill.metadata.get("context"), dict) else {}
    project_context = ""
    if skill.name == "browser-os-dev" or context_meta.get("project_tree") == "abbreviated":
        project_context = (
            "\n\nBROWSEROS PROJECT TREE (generated from current filesystem):\n"
            + build_project_tree(PROJECT_ROOT)
        )
    return (
        "You are Tiny Web Agent. A routing pass has already selected exactly one procedural skill. "
        "Follow that skill and use only the tools exposed for this turn. Do not invent unavailable tools. "
        "Treat tool errors as facts and do not repeat an unchanged failed call.\n\n"
        f"ACTIVE SKILL: {skill.name}\n"
        f"PURPOSE: {skill.description}\n\n"
        f"{skill.body}{project_context}"
    )


def _browser_os_available_tools() -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    functions: dict[str, Any] = {
        name: fn for name, fn in OS_TOOL_FUNCTIONS.items() if name != "create_tool"
    }
    schemas: dict[str, dict[str, Any]] = {
        str(schema.get("name") or ""): schema
        for schema in OS_TOOL_SCHEMAS
        if isinstance(schema, dict) and schema.get("name") and schema.get("name") != "create_tool"
    }
    # Bridge the deliberately tiny built-in baseline plus user-created external
    # tools. External tools are not enabled by default; they become usable only
    # when a Skill or Scheduled Task explicitly selects them.
    bridged = set(_BROWSER_OS_BASE_TOOL_NAMES)
    bridged.update(
        name for name, entry in TOOL_REGISTRY.items()
        if isinstance(entry, dict) and entry.get("source") == "external"
    )
    for name in bridged:
        entry = TOOL_REGISTRY.get(name) or {}
        fn = entry.get("function")
        schema = entry.get("schema")
        if callable(fn) and isinstance(schema, dict):
            functions[name] = fn
            schemas[name] = schema
    return functions, schemas


def _browser_os_tool_bundle(skill: Skill | None):
    all_functions, all_schemas = _browser_os_available_tools()
    # Specialized skills expose only their declared tools. General deliberately
    # exposes no tools; browse/news/research skills own web-facing tool surfaces.
    if skill is None:
        wanted = set(_BROWSER_OS_BASE_TOOL_NAMES)
    elif skill.name == "general":
        wanted = set()
    else:
        wanted = set(skill.tools)
    functions = {name: fn for name, fn in all_functions.items() if name in wanted}
    schemas = [schema for name, schema in all_schemas.items() if name in wanted]
    return functions, schemas


def _browser_os_named_tool_bundle(tool_names: list[str] | tuple[str, ...]):
    """Build a deliberately constrained BrowserOS tool bundle from explicit names."""
    all_functions, all_schemas = _browser_os_available_tools()
    wanted: list[str] = []
    for raw in tool_names or []:
        name = str(raw or "").strip()
        if name and name not in wanted:
            wanted.append(name)
    unknown = [name for name in wanted if name not in all_functions or name not in all_schemas]
    if unknown:
        raise ValueError("Unknown or unavailable BrowserOS tool(s): " + ", ".join(unknown))
    functions = {name: all_functions[name] for name in wanted}
    schemas = [all_schemas[name] for name in wanted]
    return functions, schemas


def _recent_os_task_context(state: list[dict[str, Any]]) -> str:
    """Keep conversational continuity without reusing the old tool chain/context."""
    if not state:
        return ""
    previous_user = ""
    previous_assistant = ""
    for message in state:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = str(message.get("content") or "").strip()
        if role == "user" and "CURRENT USER:" in content:
            previous_user = content.split("CURRENT USER:", 1)[1].strip()
        elif role == "assistant" and content:
            # The last assistant entry is the final answer. Intermediate YAML
            # calls are followed by user tool results and eventually replaced by
            # a later assistant message.
            previous_assistant = content
    if not previous_user and not previous_assistant:
        return ""
    parts = []
    if previous_user:
        parts.append("Previous user request: " + previous_user[:700])
    if previous_assistant:
        parts.append("Previous assistant result: " + previous_assistant[:900])
    return "\n".join(parts)[:1600]


def _selector_event_bridge(event_callback):
    if event_callback is None:
        return None

    def forward(event: str, payload: dict[str, Any]):
        # Never stream selector tokens into the answer. Model-load information is
        # still useful because the selector is often the first inference after boot.
        if event in {"model_loading", "model_loaded"}:
            event_callback(event, payload)
    return forward


def _select_browser_os_skill(
    *,
    model: dict[str, Any],
    settings: dict[str, Any],
    query: str,
    force_dev: bool = False,
    forced_skill: str | None = None,
    event_callback=None,
) -> tuple[Skill, list[dict[str, Any]], dict[str, Any]]:
    """Route in two stages: category first, then one skill inside that category."""
    skills = load_skills()
    if not skills:
        raise RuntimeError("No BrowserOS skills are installed.")

    def summary(skill: Skill, score: float | None = None) -> dict[str, Any]:
        item = skill.public_summary()
        item["retrieval_score"] = None if score is None else round(float(score), 4)
        return item

    def forced_result(skill: Skill, mode: str, reason: str):
        candidates = [summary(skill)]
        routing = {
            "selection_mode": mode,
            "selected_category": skill.category,
            "category_reason": "Category routing was bypassed because the skill was explicitly selected.",
            "selected_skill": skill.name,
            "reason": reason,
            "candidate_source": mode,
            "categories": [{"name": skill.category, "description": CATEGORY_DESCRIPTIONS.get(skill.category, f"Skills categorized as {skill.category}."), "count": 1}],
            "candidates": candidates,
        }
        return skill, candidates, routing

    if force_dev and "browser-os-dev" in skills:
        return forced_result(skills["browser-os-dev"], "devmode", "BrowserOS devmode explicitly forces the browser-os-dev skill.")

    forced_name = str(forced_skill or "").strip().lower()
    if forced_name:
        skill = skills.get(forced_name)
        if skill is None:
            raise ValueError(f"Unknown BrowserOS skill: {forced_name}")
        return forced_result(skill, "manual", "This skill was manually selected by the user.")

    # STEP 1: category routing. Only compact category summaries are shown here;
    # individual skill descriptions are deliberately hidden from this pass.
    grouped: dict[str, list[Skill]] = {}
    for skill in skills.values():
        grouped.setdefault(skill.category, []).append(skill)
    categories = sorted(grouped)
    category_rows = [
        {
            "name": category,
            "description": CATEGORY_DESCRIPTIONS.get(category, f"Specialized skills categorized as {category}."),
            "count": len(grouped[category]),
        }
        for category in categories
    ]

    if len(categories) == 1:
        selected_category = categories[0]
        category_reason = "Only one skill category is installed."
        category_fallback = False
    else:
        if event_callback is not None:
            event_callback("skill_category_selection_start", {"categories": category_rows})
        category_lines = "\n".join(
            f"- {row['name']}: {row['description']} ({row['count']} skills)" for row in category_rows
        )
        category_prompt = (
            "Choose the ONE category that best matches the user's current task.\n"
            "Do not choose an individual skill yet.\n"
            "Return JSON only in this exact shape:\n"
            '{"category":"exact-category-name","reason":"one short sentence"}\n'
            "Keep reason under 20 words.\n\n"
            f"CATEGORIES:\n{category_lines}\n\n"
            f"TASK:\n{query[:2400]}"
        )
        selector_settings = dict(settings)
        selector_settings.update({
            "temperature": 0.0,
            "max_tokens": 64,
            "max_tool_calls": 0,
            "compaction_enabled": False,
            "compact_tool_prompt": True,
        })
        response, _, _ = run_agent_turn(
            model_path=model["path"], settings=selector_settings, state=[], prompt=category_prompt,
            tool_bundle=({}, []),
            system_prompt_override=(
                "You are the first stage of a hierarchical task router. Select exactly one provided category. "
                "Never select a skill. Return only compact JSON with category and a short reason."
            ),
            event_callback=_selector_event_bridge(event_callback), append_action_summary=False,
        )
        raw = str(response or "").strip()
        cleaned = raw.replace("```json", "").replace("```JSON", "").replace("```", "").strip()
        chosen = ""
        category_reason = ""
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                chosen = str(parsed.get("category") or "").strip()
                category_reason = str(parsed.get("reason") or "").strip()
        except Exception:
            match = re.search(r'\{.*\}', cleaned, re.DOTALL)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                    if isinstance(parsed, dict):
                        chosen = str(parsed.get("category") or "").strip()
                        category_reason = str(parsed.get("reason") or "").strip()
                except Exception:
                    pass
        selected_category = next((name for name in categories if name.casefold() == chosen.casefold()), "")
        if not selected_category:
            lowered = cleaned.casefold()
            selected_category = next((name for name in categories if re.search(rf"\b{re.escape(name.casefold())}\b", lowered)), "")
        category_fallback = not bool(selected_category)
        if not selected_category:
            # Deterministic fallback: prefer General, otherwise the smallest stable category name.
            selected_category = "General" if "General" in grouped else categories[0]
            category_reason = "The category router did not return a valid category, so BrowserOS used its safe fallback."
        elif not category_reason:
            category_reason = f"The task best matches the {selected_category} category."
        category_reason = re.sub(r"\s+", " ", category_reason).strip()[:240]
        if event_callback is not None:
            event_callback("skill_category_selected", {
                "category": selected_category,
                "reason": category_reason,
                "fallback_used": category_fallback,
            })

    # STEP 2: retrieve and select only among skills in the chosen category.
    category_skills = grouped[selected_category]
    raw_candidates = retrieve_candidates(query, top_k=_BROWSER_OS_SKILL_TOP_K, category=selected_category)
    if not raw_candidates:
        raw_candidates = [(category_skills[0], 0.0)]

    retrieval_used = len(category_skills) > _BROWSER_OS_SKILL_TOP_K
    candidate_skills = [item[0] for item in raw_candidates]
    candidates = [summary(skill, score if retrieval_used else None) for skill, score in raw_candidates]

    if len(candidate_skills) == 1:
        selected = candidate_skills[0]
        reason = f"It is the only installed skill in the {selected_category} category."
        skill_fallback = False
    else:
        candidate_lines = "\n".join(f"- {skill.name}: {skill.description}" for skill in candidate_skills)
        general_hint = (
            "Use general when no specialized procedure is genuinely needed.\n"
            if selected_category == "General" and any(skill.name == "general" for skill in candidate_skills)
            else "Choose only from the skills listed below.\n"
        )
        selector_prompt = (
            f"The category router already selected: {selected_category}.\n"
            "Choose the ONE skill inside this category that best matches the current task.\n"
            + general_hint
            + "Return JSON only in this exact shape:\n"
            + '{"skill":"exact-skill-name","reason":"one short sentence explaining the task-to-skill match"}\n'
            + "Keep reason under 24 words. Do not give step-by-step reasoning.\n\n"
            + f"CANDIDATE SKILLS IN {selected_category}:\n{candidate_lines}\n\n"
            + f"TASK:\n{query[:2400]}"
        )
        selector_settings = dict(settings)
        selector_settings.update({
            "temperature": 0.0,
            "max_tokens": 80,
            "max_tool_calls": 0,
            "compaction_enabled": False,
            "compact_tool_prompt": True,
        })
        response, _, _ = run_agent_turn(
            model_path=model["path"], settings=selector_settings, state=[], prompt=selector_prompt,
            tool_bundle=({}, []),
            system_prompt_override=(
                "You are the second stage of a hierarchical task router. The category is already fixed. "
                "Select exactly one provided skill from that category. Return only compact JSON with skill and a short reason."
            ),
            event_callback=_selector_event_bridge(event_callback), append_action_summary=False,
        )
        raw_response = str(response or "").strip()
        cleaned = raw_response.replace("```json", "").replace("```JSON", "").replace("```", "").strip()
        chosen_name = ""
        reason = ""
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                chosen_name = str(parsed.get("skill") or "").strip().lower()
                reason = str(parsed.get("reason") or "").strip()
        except Exception:
            match = re.search(r'\{.*\}', cleaned, re.DOTALL)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                    if isinstance(parsed, dict):
                        chosen_name = str(parsed.get("skill") or "").strip().lower()
                        reason = str(parsed.get("reason") or "").strip()
                except Exception:
                    pass
        lowered = cleaned.lower().replace("`", "").strip()
        selected = next((skill for skill in candidate_skills if chosen_name == skill.name or lowered == skill.name or re.search(rf"\b{re.escape(skill.name)}\b", lowered)), None)
        skill_fallback = selected is None
        if selected is None:
            selected = next((skill for skill in candidate_skills if skill.name == "general"), candidate_skills[0])
            reason = "The skill router did not identify a valid candidate, so BrowserOS used its safe fallback within the selected category."
        elif not reason:
            reason = f"The skill best matches the current task within {selected_category}."

    reason = re.sub(r"\s+", " ", reason).strip()[:320]
    routing = {
        "selection_mode": "auto",
        "selected_category": selected_category,
        "category_reason": category_reason,
        "category_fallback_used": category_fallback,
        "categories": category_rows,
        "selected_skill": selected.name,
        "reason": reason,
        "candidate_source": "category_retrieved_top_k" if retrieval_used else "selected_category",
        "candidate_limit": _BROWSER_OS_SKILL_TOP_K,
        "retrieval_used": retrieval_used,
        "score_note": (
            f"Step 1 selected {selected_category}. Step 2 considered only skills in that category. "
            + ("Retrieval reduced that category to its top candidates." if retrieval_used else "All skills in that category were shown to the skill router.")
        ),
        "fallback_used": bool(category_fallback or skill_fallback),
        "candidates": candidates,
    }
    return selected, candidates, routing

def _browser_os_request_payload(body: dict[str, Any], event_callback=None):
    prompt = str(body.get("prompt") or "").strip()
    state_hint = body.get("state") if isinstance(body.get("state"), dict) else {}
    devmode = bool(body.get("devmode") or state_hint.get("__devmode"))
    forced_skill = str(body.get("skill") or state_hint.get("__skill") or "").strip().lower() or None
    if not prompt:
        raise ValueError("An OS instruction is required.")

    model, settings = _browser_os_model_and_settings()
    if model is None:
        raise RuntimeError("No registered GGUF model is available. Add/select a model in Tiny Web Agent first.")

    session_key = _os_session_key(body)
    previous_context = _recent_os_task_context(_os_session_get(session_key))
    selector_query = prompt if not previous_context else previous_context + "\nCurrent request: " + prompt

    if event_callback is not None:
        event_callback("skill_selection_start", {
            "query": prompt[:240],
            "mode": "devmode" if devmode else ("manual" if forced_skill else "auto"),
            "forced_skill": forced_skill,
        })
    skill, candidates, skill_routing = _select_browser_os_skill(
        model=model,
        settings=settings,
        query=selector_query,
        force_dev=devmode,
        forced_skill=forced_skill,
        event_callback=event_callback,
    )
    if event_callback is not None:
        event_callback("skill_selected", {
            "skill": skill.name,
            "description": skill.description,
            "candidates": candidates,
            "selection_mode": "devmode" if devmode else ("manual" if forced_skill else "auto"),
            "reason": skill_routing.get("reason"),
            "routing": skill_routing,
        })

    all_functions, _ = _browser_os_available_tools()
    validate_skill_tools(skill, set(all_functions))

    settings = dict(settings)
    limits = skill.metadata.get("limits") if isinstance(skill.metadata.get("limits"), dict) else {}
    skill_max_calls = limits.get("max_tool_calls")
    if skill_max_calls is None:
        skill_max_calls = 9 if skill.name == "browser-os-dev" else 6
    settings.update({
        "temperature": min(float(settings.get("temperature", 0.05)), 0.15),
        "max_tokens": min(int(settings.get("max_tokens", 3000)), 700),
        "max_tool_calls": max(0, min(12, int(skill_max_calls))),
        "compaction_enabled": False,
        "compact_tool_prompt": True,
    })

    state = body.get("state") if isinstance(body.get("state"), dict) else {}
    windows = state.get("open_windows") if isinstance(state.get("open_windows"), list) else []
    compact_windows = []
    for item in windows[:24]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:80]
        if title:
            compact_windows.append({"title": title, "minimized": bool(item.get("minimized"))})
    compact_state = {"windows": compact_windows}
    state_text = json.dumps(compact_state, ensure_ascii=False, separators=(",", ":"))

    context_meta = skill.metadata.get("context") if isinstance(skill.metadata.get("context"), dict) else {}
    project_context = ""
    if skill.name == "browser-os-dev" or context_meta.get("project_tree") == "abbreviated":
        devsession = str(body.get("devsession") or state_hint.get("__devsession") or "")
        project_context = (
            "\n\nBROWSEROS PROJECT TREE (generated from current filesystem):\n"
            + _dev_project_tree(devsession)
        )

    os_prompt = (
        "You are the BrowserOS local assistant. A routing pass has already selected exactly one procedural skill. "
        "Follow that skill and use only the tools exposed for this turn. Do not invent unavailable tools. "
        "Questions do not require actions. Never claim an external action succeeded unless a successful tool result confirms it. "
        "Treat tool errors as facts; correct the arguments or stop rather than repeating an invalid call.\n\n"
        f"ACTIVE SKILL: {skill.name}\n"
        f"PURPOSE: {skill.description}\n\n"
        f"{skill.body}"
        + project_context
    )
    history_text = previous_context or "None. This is a fresh task context."
    user_prompt = (
        f"BROWSEROS STATE: {state_text}\n"
        f"RECENT TASK CONTEXT:\n{history_text}\n\n"
        f"CURRENT USER: {prompt}"
    )
    tool_bundle = _browser_os_tool_bundle(skill)
    return model, settings, user_prompt, os_prompt, tool_bundle, skill, candidates


def _clean_skill_draft(text: str) -> str:
    value = str(text or "").strip()
    fenced = re.fullmatch(r"```(?:markdown|md|yaml)?\s*\n(?P<body>.*?)\n```", value, re.DOTALL | re.IGNORECASE)
    if fenced:
        value = fenced.group("body").strip()
    # Keep a complete frontmatter block when the model prefaced it with prose.
    start = value.find("---")
    if start > 0:
        value = value[start:]
    return value.strip() + "\n"


def _skill_slug(value: str, *, fallback: str = "learned-skill") -> str:
    words = re.findall(r"[a-z0-9]+", str(value or "").lower())
    stop = {
        "a", "an", "and", "are", "at", "be", "can", "do", "for", "from", "have",
        "i", "in", "is", "it", "me", "my", "of", "on", "please", "that", "the",
        "this", "to", "what", "when", "with", "you", "your",
    }
    words = [word for word in words if word not in stop][:7]
    slug = "-".join(words).strip("-") or fallback
    if not slug or not slug[0].isalpha():
        slug = f"learned-{slug}"
    slug = re.sub(r"[^a-z0-9-]+", "-", slug).strip("-")[:64].rstrip("-")
    if len(slug) < 2:
        slug = fallback
    return slug


def _unique_skill_name(preferred: str, existing_names: set[str]) -> str:
    base = _skill_slug(preferred)
    if base not in existing_names:
        return base
    # A generated draft is always a new skill. Never reuse/overwrite an existing id.
    for index in range(2, 1000):
        suffix = f"-{index}"
        candidate = (base[: 64 - len(suffix)].rstrip("-") + suffix)
        if candidate not in existing_names:
            return candidate
    return f"learned-skill-{uuid.uuid4().hex[:8]}"


def _extract_draft_field(text: str, field: str) -> str:
    match = re.search(rf"(?im)^\s*{re.escape(field)}\s*:\s*[\"']?(.*?)[\"']?\s*$", str(text or ""))
    return str(match.group(1) if match else "").strip()


def _ensure_skill_sections(body: str, *, task: str, trace_text: str) -> str:
    value = str(body or "").strip()
    # Remove stray YAML-ish metadata when a small model omitted or damaged the
    # frontmatter delimiters. Remove a tools block before removing scalar lines.
    value = re.sub(r"(?ms)^\s*tools\s*:\s*\n(?:\s*-\s*[^\n]+\n?)+", "", value).strip()
    value = re.sub(r"(?im)^\s*(?:name|description|tools|version)\s*:\s*.*$", "", value).strip()
    value = re.sub(r"(?m)^\s*---\s*$", "", value).strip()
    value = value.strip("` \r\n")

    if not value:
        # Last-resort body based on confirmed successful execution, not model recollection.
        compact_steps = []
        for block in str(trace_text or "").split("\n\n")[:8]:
            first = block.splitlines()[0].strip() if block.strip() else ""
            if first:
                compact_steps.append(first)
        steps = "\n".join(f"{i}. {step}" for i, step in enumerate(compact_steps, 1))
        value = steps or f"1. Reproduce the successful procedure used for: {task.strip()}"

    if not re.search(r"(?im)^#\s+procedure\s*$", value):
        value = "# Procedure\n\n" + value
    if not re.search(r"(?im)^#\s+success\s*$", value):
        value += (
            "\n\n# Success\n\n"
            "The requested task is completed successfully and the relevant tool results confirm the intended outcome."
        )
    return value.strip()


def _normalize_skill_draft(
    raw: str, *, task: str, used_tools: list[str], existing_names: set[str], trace_text: str
) -> tuple[str, list[str]]:
    """Return a valid SKILL.md even when Ministral's formatting is imperfect.

    BrowserOS owns the YAML envelope and tool list. The small model supplies the
    procedural semantics; syntax mistakes must not make teaching fail.
    """
    cleaned = _clean_skill_draft(raw)
    notes: list[str] = []
    preferred_name = _extract_draft_field(cleaned, "name")
    description = _extract_draft_field(cleaned, "description")
    category = _extract_draft_field(cleaned, "category")
    body = cleaned

    try:
        parsed = parse_skill_text(cleaned)
        preferred_name = parsed.name
        description = parsed.description
        category = str(parsed.metadata.get("category") or parsed.category)
        body = parsed.body
        if list(parsed.tools) != list(used_tools):
            notes.append("tool list normalized to the tools that actually succeeded")
    except Exception:
        notes.append("YAML/frontmatter repaired by BrowserOS")

    if not preferred_name:
        # Prefer the task itself over an invented opaque id; uniqueness is enforced below.
        preferred_name = task
        notes.append("skill name generated from the successful task")
    name = _unique_skill_name(preferred_name, existing_names)
    if _skill_slug(preferred_name) != name:
        notes.append(f"skill id changed to unique name '{name}'")

    description = " ".join(str(description or "").split())
    if not description:
        description = f"Reusable procedure learned from a successful task: {task.strip()}"
        notes.append("description generated from the successful task")
    description = description[:320].rstrip()
    category = " ".join(str(category or "").split())[:48].strip()
    if not category:
        probe = parse_skill_text(
            "---\nname: temp-skill\ndescription: " + json.dumps(description, ensure_ascii=False) +
            "\ntools: []\n---\n\n# Procedure\n\n1. Temporary.\n\n# Success\n\nDone.\n"
        )
        category = probe.category
        notes.append(f"category inferred as '{category}'")

    body = _ensure_skill_sections(body, task=task, trace_text=trace_text)
    tool_lines = "\n".join(f"  - {json.dumps(name, ensure_ascii=False)}" for name in used_tools)
    tools_yaml = f"tools:\n{tool_lines}" if tool_lines else "tools: []"
    draft = (
        "---\n"
        f"name: {name}\n"
        f"description: {json.dumps(description, ensure_ascii=False)}\n"
        f"{tools_yaml}\n"
        "---\n\n"
        f"{body.strip()}\n"
    )
    return draft, notes


def _compact_success_trace(tool_traces: list[dict[str, Any]]) -> tuple[str, list[str]]:
    lines: list[str] = []
    used_tools: list[str] = []
    for index, trace in enumerate(tool_traces[:20], start=1):
        if not isinstance(trace, dict):
            continue
        name = str(trace.get("name") or "").strip()
        if not name:
            continue
        result = str(trace.get("result") or "").strip()
        lowered = result.lower()
        if lowered.startswith(("tool error:", "tool is disabled", "failed:")):
            raise ValueError("The run contains a failed tool call; only successful runs can be taught as skills.")
        if name not in used_tools:
            used_tools.append(name)
        args = trace.get("arguments") if isinstance(trace.get("arguments"), dict) else {}
        args_text = json.dumps(args, ensure_ascii=False, default=_json_stream_default)[:900]
        lines.append(
            f"Step {index}: {name}\nArguments: {args_text}\nConfirmed result: {result[:1100]}"
        )
    if not lines:
        raise ValueError("There is no successful tool trace to distill into a skill.")
    return "\n\n".join(lines), used_tools


def _skill_model_pass(model: dict[str, Any], settings: dict[str, Any], *, system: str, prompt: str, max_tokens: int) -> str:
    pass_settings = dict(settings)
    pass_settings.update({
        "temperature": 0.05,
        "max_tokens": max_tokens,
        "max_tool_calls": 0,
        "compaction_enabled": False,
        "compact_tool_prompt": True,
    })
    response, _, _ = run_agent_turn(
        model_path=model["path"], settings=pass_settings, state=[], prompt=prompt,
        tool_bundle=({}, []), system_prompt_override=system,
        append_action_summary=False,
    )
    return str(response or "").strip()


def _skill_editor_summary(skill: Skill) -> dict[str, Any]:
    summary = skill.public_summary()
    summary.update({
        "starter": is_starter_skill(skill.name),
        "deletable": True,
        "filename": skill.path.name,
    })
    return summary


def _skill_category_records() -> list[dict[str, Any]]:
    categories = load_category_descriptions(include_skills=True)
    counts: dict[str, int] = {name: 0 for name in categories}
    for skill in load_skills().values():
        counts[skill.category] = counts.get(skill.category, 0) + 1
    return [
        {
            "name": name,
            "description": description,
            "count": counts.get(name, 0),
            "protected": name == "General",
        }
        for name, description in sorted(categories.items(), key=lambda item: (item[0] != "General", item[0].casefold()))
    ]


@app.get("/api/os/skills")
def browser_os_skills_list():
    return jsonify({
        "ok": True,
        "skills": [_skill_editor_summary(skill) for skill in load_skills().values()],
        "categories": _skill_category_records(),
    })


@app.get("/api/os/categories")
def browser_os_categories_list():
    return jsonify({"ok": True, "categories": _skill_category_records()})


@app.post("/api/os/categories")
def browser_os_category_create():
    body = request.get_json(silent=True) or {}
    try:
        category = create_category(str(body.get("name") or ""), str(body.get("description") or ""))
        return jsonify({"ok": True, "category": category, "categories": _skill_category_records()})
    except FileExistsError as error:
        return _json_error(str(error), 409)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.put("/api/os/categories/<name>")
def browser_os_category_update(name: str):
    body = request.get_json(silent=True) or {}
    try:
        category = update_category(
            name,
            new_name=body.get("name") if "name" in body else None,
            description=body.get("description") if "description" in body else None,
        )
        return jsonify({"ok": True, "category": category, "categories": _skill_category_records()})
    except FileExistsError as error:
        return _json_error(str(error), 409)
    except PermissionError as error:
        return _json_error(str(error), 409)
    except (ValueError, FileNotFoundError) as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.delete("/api/os/categories/<name>")
def browser_os_category_delete(name: str):
    body = request.get_json(silent=True) or {}
    try:
        result = delete_category(name, reassign_to=str(body.get("reassign_to") or "General"))
        return jsonify({"ok": True, **result, "categories": _skill_category_records()})
    except PermissionError as error:
        return _json_error(str(error), 409)
    except (ValueError, FileNotFoundError) as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.get("/api/os/tools")
def browser_os_tools_list():
    """Expose only tool metadata needed by the local Scheduled Tasks editor."""
    _functions, schemas = _browser_os_available_tools()
    tools = []
    for name in sorted(schemas):
        schema = schemas[name]
        nested = schema.get("function") if isinstance(schema.get("function"), dict) else {}
        tools.append({
            "name": name,
            "description": str(schema.get("description") or nested.get("description") or "").strip(),
            "baseline": name in _BROWSER_OS_BASE_TOOL_NAMES,
        })
    return jsonify({"ok": True, "tools": tools})



@app.get("/api/os/tool-editor")
def browser_os_tool_editor_list():
    return jsonify({
        "ok": True,
        "tools": list_external_tool_records(),
        "runtime_available": bool(TOOL_REGISTRY),
        "directory": str(EXTERNAL_TOOLS_DIR),
    })


@app.get("/api/os/tool-editor/<name>")
def browser_os_tool_editor_read(name: str):
    try:
        return jsonify({"ok": True, "tool": read_external_tool_bundle(name)})
    except FileNotFoundError as error:
        return _json_error(str(error), 404)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/tool-editor/validate")
def browser_os_tool_editor_validate():
    body = request.get_json(silent=True) or {}
    definition = body.get("definition")
    code = str(body.get("code") or "")
    try:
        normalized, yaml_text = normalize_external_tool_bundle(definition, code)
        return jsonify({
            "ok": True,
            "definition": normalized,
            "yaml": yaml_text,
            "exists": any(x.get("name") == normalized["name"] for x in list_external_tool_records()),
        })
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/tool-editor/save")
def browser_os_tool_editor_save_new():
    body = request.get_json(silent=True) or {}
    try:
        saved = save_external_tool_bundle(body.get("definition"), str(body.get("code") or ""))
        return jsonify({"ok": True, "tool": saved, "tools": get_tool_descriptors()})
    except FileExistsError as error:
        return _json_error(str(error), 409)
    except (ValueError, FileNotFoundError) as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.put("/api/os/tool-editor/<name>")
def browser_os_tool_editor_update(name: str):
    body = request.get_json(silent=True) or {}
    try:
        saved = save_external_tool_bundle(
            body.get("definition"), str(body.get("code") or ""), original_name=name
        )
        return jsonify({"ok": True, "tool": saved, "tools": get_tool_descriptors()})
    except FileNotFoundError as error:
        return _json_error(str(error), 404)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.delete("/api/os/tool-editor/<name>")
def browser_os_tool_editor_delete(name: str):
    try:
        result = delete_external_tool_bundle(name)
        return jsonify({"ok": True, **result, "tools": get_tool_descriptors()})
    except FileNotFoundError as error:
        return _json_error(str(error), 404)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.get("/api/os/skills/<name>")
def browser_os_skill_read(name: str):
    try:
        skill, text = read_skill_text(name)
        return jsonify({"ok": True, "skill": _skill_editor_summary(skill), "text": text})
    except FileNotFoundError as error:
        return _json_error(str(error), 404)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/skills/validate")
def browser_os_skill_validate():
    body = request.get_json(silent=True) or {}
    text = str(body.get("text") or body.get("draft") or "").strip()
    if not text:
        return _json_error("Skill text is required.")
    try:
        all_functions, _ = _browser_os_available_tools()
        parsed = parse_skill_text(text)
        validate_skill_tools(parsed, set(all_functions))
        return jsonify({
            "ok": True,
            "skill": _skill_editor_summary(parsed),
            "exists": parsed.name in load_skills(),
        })
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.put("/api/os/skills/<name>")
def browser_os_skill_update(name: str):
    body = request.get_json(silent=True) or {}
    text = str(body.get("text") or body.get("draft") or "").strip()
    if not text:
        return _json_error("Skill text is required.")
    try:
        all_functions, _ = _browser_os_available_tools()
        skill = update_existing_skill(name, text, available_tools=set(all_functions))
        return jsonify({"ok": True, "skill": _skill_editor_summary(skill)})
    except FileNotFoundError as error:
        return _json_error(str(error), 404)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.delete("/api/os/skills/<name>")
def browser_os_skill_delete(name: str):
    try:
        skill = delete_skill(name)
        return jsonify({"ok": True, "deleted": skill.name})
    except FileNotFoundError as error:
        return _json_error(str(error), 404)
    except PermissionError as error:
        return _json_error(str(error), 409)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/skills/teach")
def browser_os_teach_skill():
    body = request.get_json(silent=True) or {}
    task = str(body.get("task") or "").strip()
    outcome = str(body.get("response") or "").strip()
    traces = body.get("tool_traces") if isinstance(body.get("tool_traces"), list) else []
    force_new = bool(body.get("force_new"))
    if not task:
        return _json_error("The completed task is required.")
    try:
        trace_text, used_tools = _compact_success_trace(traces)
        all_functions, _ = _browser_os_available_tools()
        unknown_used = [name for name in used_tools if name not in all_functions]
        if unknown_used:
            raise ValueError("Successful trace contains tools unavailable to BrowserOS skills: " + ", ".join(unknown_used))

        model, settings = _browser_os_model_and_settings()
        if model is None:
            raise RuntimeError("No registered GGUF model is available.")
        existing = retrieve_candidates(task, top_k=_BROWSER_OS_SKILL_TOP_K)
        existing_lines = "\n".join(f"- {skill.name}: {skill.description}" for skill, _ in existing)

        if not force_new and existing:
            coverage = _skill_model_pass(
                model, settings,
                system="You classify whether an existing procedural skill already covers a successful task. Reply only COVERED:<exact-name> or NEW.",
                prompt=(
                    f"SUCCESSFUL TASK:\n{task}\n\n"
                    f"MOST RELEVANT EXISTING SKILLS:\n{existing_lines}\n\n"
                    "If one existing skill already teaches this kind of task at the procedural level, answer COVERED:<name>. "
                    "Do not require an exact wording match. Otherwise answer NEW."
                ),
                max_tokens=32,
            )
            coverage_l = coverage.lower().replace("`", "").strip()
            for skill, _ in existing:
                if coverage_l.startswith("covered") and skill.name in coverage_l:
                    return jsonify({
                        "ok": True,
                        "status": "covered",
                        "covered_by": skill.public_summary(),
                    })

        forbidden_names = ", ".join(sorted(load_skills()))
        allowed_tools = ", ".join(used_tools)
        draft_prompt = (
            f"SUCCESSFUL TASK:\n{task}\n\n"
            f"SUCCESSFUL TOOL TRACE:\n{trace_text}\n\n"
            f"FINAL OUTCOME:\n{outcome[:1400] or 'The user accepted the completed result.'}\n\n"
            f"TOOLS THAT ACTUALLY SUCCEEDED IN THIS RUN:\n{allowed_tools}\n\n"
            f"EXISTING SKILL NAMES THAT MUST NOT BE REUSED:\n{forbidden_names}\n\n"
            "Create a reusable, compact SKILL.md that distills the successful procedure and removes exploration, failed ideas, and incidental one-off details. "
            "Use only tools from the successful run. Include a short # Procedure and # Success section. "
            "Include a category field such as General, Coding, BrowserOS, Research, Translation, Writing, or Creative. "
            "The description should be useful for semantic retrieval and task routing. Output only the SKILL.md text with YAML frontmatter."
        )
        system = (
            "You distill successful agent trajectories into compact procedural skills for a small local LLM. "
            "Do not overwrite or reuse an existing skill name. Do not invent tools or file paths that were not supported by the successful trace."
        )
        raw_draft = _skill_model_pass(model, settings, system=system, prompt=draft_prompt, max_tokens=750)
        draft, normalization_notes = _normalize_skill_draft(
            raw_draft,
            task=task,
            used_tools=used_tools,
            existing_names=set(load_skills()),
            trace_text=trace_text,
        )
        parsed = parse_skill_text(draft)
        validate_skill_tools(parsed, set(all_functions))
        # These should already be guaranteed by _normalize_skill_draft; keep the
        # checks here as hard backend invariants rather than model instructions.
        if parsed.name in load_skills():
            raise FileExistsError(f"Skill name already exists: {parsed.name}")
        extra = [name for name in parsed.tools if name not in used_tools]
        if extra:
            raise ValueError("Draft references tools not present in the successful trace: " + ", ".join(extra))

        return jsonify({
            "ok": True,
            "status": "draft",
            "draft": draft,
            "skill": parsed.public_summary(),
            "normalization": {
                "repaired": bool(normalization_notes),
                "notes": normalization_notes,
            },
        })
    except ValueError as error:
        return _json_error(str(error))
    except RuntimeError as error:
        return _json_error(str(error), 409)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/skills/save")
def browser_os_save_skill():
    body = request.get_json(silent=True) or {}
    draft = str(body.get("draft") or "").strip()
    if not draft:
        return _json_error("Skill draft is required.")
    try:
        all_functions, _ = _browser_os_available_tools()
        skill = save_new_skill(draft, available_tools=set(all_functions))
        return jsonify({"ok": True, "skill": skill.public_summary()})
    except FileExistsError as error:
        return _json_error(str(error), 409)
    except ValueError as error:
        return _json_error(str(error))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/reset")
def browser_os_reset():
    """Cancel inference and clear only the requested terminal's OS conversation."""
    try:
        body = request.get_json(silent=True) or {}
        session_key = _os_session_key(body)
        _os_session_clear(session_key)
        model_manager.cancel()
        reset = model_manager.reset_context()
        return jsonify({"ok": True, "reset": reset, "context": "os", "session_cleared": bool(session_key)})
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os")
def browser_os_command():
    body = request.get_json(silent=True) or {}
    try:
        model, settings, user_prompt, os_prompt, tool_bundle, skill, candidates = _browser_os_request_payload(body)
        session_key = _os_session_key(body)
        # Every main task starts from a fresh LLM context. Continuity is supplied
        # only by the compact prior-task summary embedded in user_prompt.
        response_text, updated_state, meta = run_agent_turn(
            model_path=model["path"],
            settings=settings,
            state=[],
            prompt=user_prompt,
            tool_bundle=tool_bundle,
            system_prompt_override=os_prompt,
        )
        _os_session_set(session_key, updated_state)
        return jsonify({
            "ok": True,
            "response": response_text.strip(),
            "tool_calls": meta.get("tool_calls", 0),
            "tool_traces": meta.get("tool_traces", []),
            "model": model.get("name"),
            "context": "os",
            "skill": skill.public_summary(),
            "skill_candidates": candidates,
        })
    except ValueError as error:
        return _json_error(str(error))
    except RuntimeError as error:
        return _json_error(str(error), 409)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/os/stream")
def browser_os_stream():
    body = request.get_json(silent=True) or {}

    def event_stream():
        event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        finished = threading.Event()

        def emit(event: str, payload: Any = None, **extra: Any):
            """Normalize Tiny Web Agent callbacks for SSE."""
            normalized: dict[str, Any] = {}
            if isinstance(payload, dict):
                normalized.update(payload)
            elif payload is not None:
                normalized["data"] = payload
            normalized.update(extra)
            event_queue.put({"event": event, **normalized})

        def worker():
            try:
                model, settings, user_prompt, os_prompt, tool_bundle, skill, candidates = _browser_os_request_payload(
                    body, event_callback=emit
                )
                session_key = _os_session_key(body)
                response_text, updated_state, meta = run_agent_turn(
                    model_path=model["path"],
                    settings=settings,
                    state=[],
                    prompt=user_prompt,
                    event_callback=emit,
                    tool_bundle=tool_bundle,
                    system_prompt_override=os_prompt,
                )
                _os_session_set(session_key, updated_state)
                event_queue.put({
                    "event": "complete",
                    "ok": True,
                    "response": response_text.strip(),
                    "tool_calls": meta.get("tool_calls", 0),
                    "tool_traces": meta.get("tool_traces", []),
                    "model": model.get("name"),
                    "context": "os",
                    "skill": skill.public_summary(),
                    "skill_candidates": candidates,
                })
            except Exception as error:
                event_queue.put({"event": "error", "error": f"{type(error).__name__}: {error}"})
            finally:
                finished.set()

        threading.Thread(target=worker, daemon=True).start()
        while not finished.is_set() or not event_queue.empty():
            try:
                payload = event_queue.get(timeout=0.25)
            except queue.Empty:
                continue
            yield "data: " + json.dumps(payload, ensure_ascii=False, default=_json_stream_default) + "\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )



@app.post("/api/research/stream")
def research_stream():
    body = request.get_json(silent=True) or {}
    query = str(body.get("query") or body.get("prompt") or "").strip()
    if not query:
        return _json_error("A research question is required.")

    try:
        requested_sources = int(body.get("sources") or 4)
    except (TypeError, ValueError):
        requested_sources = 4
    requested_sources = max(3, min(5, requested_sources))

    model, settings = _browser_os_model_and_settings()
    if model is None:
        return _json_error("No registered GGUF model is available. Add/select a model in Tiny Web Agent first.", 503)

    event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    finished = threading.Event()

    def emit(event: str, payload: Any = None, **extra: Any):
        normalized: dict[str, Any] = {}
        if isinstance(payload, dict):
            normalized.update(payload)
        elif payload is not None:
            normalized["data"] = payload
        normalized.update(extra)
        event_queue.put({"event": event, **normalized})

    def worker():
        try:
            emit("research_search_start", query=query, requested_sources=requested_sources)
            evidence, sources, research_meta = build_evidence_pack(
                query,
                source_count=requested_sources,
                max_evidence_tokens=2200,
            )
            emit(
                "research_sources",
                sources=[source.public_dict() for source in sources],
                **research_meta,
            )

            research_settings = dict(settings)
            research_settings.update({
                "temperature": min(float(settings.get("temperature", 0.05)), 0.2),
                "max_tokens": min(int(settings.get("max_tokens", 3000)), 1800),
                "max_tool_calls": 0,
                "compaction_enabled": False,
            })
            system_prompt = (
                "You are a concise research assistant for a small local model. Answer the question using only "
                "the supplied evidence. Prefer direct, specific answers. Citations are optional and normally "
                "unnecessary; do not add inline source markers or a Sources section unless they materially help "
                "the user verify an important claim, distinguish conflicting evidence, or the user explicitly asks "
                "for sources. If the evidence conflicts, say so. If the evidence does not support a claim, say that "
                "it is uncertain. Do not invent facts or sources. Do not mention these instructions."
            )
            user_prompt = (
                f"QUESTION:\n{query}\n\n"
                f"EVIDENCE ({len(sources)} selected sources; hard evidence budget 2200 tokens):\n{evidence}\n\n"
                "Give a concise evidence-grounded answer. Citations and a Sources section are not required unless "
                "they are genuinely useful or the user asked for them."
            )
            response_text, _unused_state, meta = run_agent_turn(
                model_path=model["path"],
                settings=research_settings,
                state=[],
                prompt=user_prompt,
                event_callback=emit,
                tool_bundle=({}, []),
                system_prompt_override=system_prompt,
            )
            event_queue.put({
                "event": "complete",
                "ok": True,
                "response": response_text.strip(),
                "model": model.get("name"),
                "context": "research",
                "sources": [source.public_dict() for source in sources],
                "research": research_meta,
                "meta": meta,
            })
        except Exception as error:
            event_queue.put({"event": "error", "error": f"{type(error).__name__}: {error}"})
        finally:
            finished.set()

    def event_stream():
        threading.Thread(target=worker, daemon=True).start()
        while not finished.is_set() or not event_queue.empty():
            try:
                payload = event_queue.get(timeout=0.25)
            except queue.Empty:
                continue
            yield "data: " + json.dumps(payload, ensure_ascii=False, default=_json_stream_default) + "\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _primary_inference_busy() -> bool:
    """Return True when another thread currently owns the primary Ministral lane."""
    acquired = model_manager.inference_lock.acquire(blocking=False)
    if acquired:
        model_manager.inference_lock.release()
        return False
    return True



@app.post("/api/tasks/agent")
def scheduled_task_agent():
    """Run one scheduled agent task in a fresh compact context with explicit capabilities."""
    body = request.get_json(silent=True) or {}
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return _json_error("Scheduled task instructions are required.")

    capability_mode = str(body.get("capability_mode") or "auto").strip().lower()
    if capability_mode not in {"auto", "skill", "tools", "none"}:
        return _json_error("capability_mode must be auto, skill, tools, or none.")
    max_tokens = max(128, min(3000, int(body.get("max_tokens") or 1600)))
    requested_max_calls = max(0, min(12, int(body.get("max_tool_calls") or 6)))
    primary_busy = _primary_inference_busy()

    try:
        selected_skill = None
        candidates: list[dict[str, Any]] = []
        routing: dict[str, Any] = {}
        selected_tools: list[str] = []

        if capability_mode in {"auto", "skill"}:
            forced_skill = str(body.get("skill") or "").strip().lower() if capability_mode == "skill" else None
            if capability_mode == "skill" and not forced_skill:
                raise ValueError("Choose a skill for this scheduled task.")
            model, settings, user_prompt, system_prompt, tool_bundle, selected_skill, candidates = _browser_os_request_payload({
                "prompt": prompt,
                "skill": forced_skill,
                "state": {},
            })
            routing = {
                "mode": capability_mode,
                "selected_skill": selected_skill.name,
            }
            selected_tools = list(tool_bundle[0].keys()) if tool_bundle is not None else list(_BROWSER_OS_BASE_TOOL_NAMES)
        else:
            model, settings = _browser_os_model_and_settings()
            if model is None:
                raise RuntimeError("No registered GGUF model is available. Add/select a model in Tiny Web Agent first.")
            if capability_mode == "tools":
                raw_tools = body.get("tools") if isinstance(body.get("tools"), list) else []
                selected_tools = [str(x or "").strip() for x in raw_tools if str(x or "").strip()]
                if len(selected_tools) > 12:
                    raise ValueError("Scheduled tasks may expose at most 12 manual tools.")
                tool_bundle = _browser_os_named_tool_bundle(selected_tools)
                tool_lines = ", ".join(selected_tools) if selected_tools else "none"
                system_prompt = (
                    "You are the BrowserOS local assistant executing one scheduled task in a fresh context. "
                    "Use only the explicitly selected tools. For current/external facts, retrieve them with a tool before answering. "
                    "NEVER invent tool results or current facts. Never claim an external action succeeded unless a successful tool result confirms it. "
                    "Treat tool errors as facts and do not repeat an unchanged failed call. "
                    f"AVAILABLE TOOLS: {tool_lines}"
                )
            else:
                tool_bundle = ({}, [])
                system_prompt = (
                    "You are the BrowserOS local assistant executing one scheduled text task in a fresh context. "
                    "No tools are available. NEVER invent current or external facts. If the task requires unavailable information, say so concisely."
                )
            user_prompt = prompt
            routing = {"mode": capability_mode, "selected_skill": None}

        settings = dict(settings)
        settings.update({
            "temperature": min(float(settings.get("temperature", 0.05)), 0.12),
            "max_tokens": max_tokens,
            "max_tool_calls": requested_max_calls if capability_mode != "none" else 0,
            "compaction_enabled": False,
            "compact_tool_prompt": True,
        })
        response, _state, meta = run_agent_turn(
            model_path=model["path"],
            settings=settings,
            state=[],
            prompt=user_prompt,
            tool_bundle=tool_bundle,
            system_prompt_override=system_prompt,
            append_action_summary=False,
        )
        public_meta = {
            "model": model.get("name") or Path(model["path"]).name,
            "context_chars": len(str(user_prompt)) + len(str(system_prompt)),
            "inference_lane": "primary_agent_wait" if primary_busy else "primary_agent",
            "temporary_model": False,
            "capability_mode": capability_mode,
            "skill": selected_skill.public_summary() if selected_skill else None,
            "skill_candidates": candidates,
            "routing": routing,
            "tools": selected_tools,
            "tool_calls": int((meta or {}).get("tool_calls") or 0),
            "tool_traces": (meta or {}).get("tool_traces", []),
        }
        for key in ("prompt_tokens", "completion_tokens", "tokens_per_second", "load_seconds", "finish_reason"):
            if key in (meta or {}):
                public_meta[key] = meta[key]
        return jsonify({"ok": True, "response": str(response or "").strip(), "meta": public_meta})
    except ValueError as error:
        return _json_error(str(error))
    except RuntimeError as error:
        return _json_error(str(error), 409)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 503)


@app.post("/api/tasks/import-result")
def import_scheduled_task_result():
    """Create a normal Tiny Web Agent conversation from a completed scheduled-task run."""
    body = request.get_json(silent=True) or {}
    title = " ".join(str(body.get("title") or "Scheduled task").strip().split())[:120] or "Scheduled task"
    task = str(body.get("task") or "Scheduled task").strip()[:6000]
    result = str(body.get("result") or "").strip()
    if not result:
        return _json_error("Scheduled task result is empty.")

    model, _settings = _browser_os_model_and_settings()
    model_id = model.get("id") if isinstance(model, dict) else None
    conversation = chat_store.create_conversation(model_id)
    conversation_id = conversation["id"]
    chat_store.update_conversation(conversation_id, title=title)

    user_text = f"Scheduled task: {title}\n\n{task}" if task else f"Scheduled task: {title}"
    chat_store.append_message(conversation_id, "user", user_text)
    assistant_message = chat_store.append_message(conversation_id, "assistant", result)

    raw_traces = body.get("tool_traces") if isinstance(body.get("tool_traces"), list) else []
    safe_traces = []
    for trace in raw_traces[:20]:
        if not isinstance(trace, dict):
            continue
        safe_traces.append({
            "name": str(trace.get("name") or "tool")[:160],
            "arguments": trace.get("arguments") if isinstance(trace.get("arguments"), dict) else {},
            "result": str(trace.get("result") or "")[:12000],
            "duration_seconds": trace.get("duration_seconds"),
        })
    if safe_traces:
        try:
            chat_store.append_tool_traces(conversation_id, assistant_message["id"], safe_traces)
        except Exception as error:
            logging.warning("[Scheduled Tasks] Could not import tool traces: %s", error)

    # Keep the stored inference state structurally valid for any later follow-up.
    imported = chat_store.get_conversation(conversation_id, include_messages=False)
    settings = imported.get("settings") or {}
    state = [
        {"role": "system", "content": str(settings.get("system_prompt") or chat_store.DEFAULT_SYSTEM_PROMPT)},
        {"role": "user", "content": user_text},
        {"role": "assistant", "content": result},
    ]
    chat_store.update_conversation(conversation_id, agent_state=state)
    return jsonify({
        "ok": True,
        "conversation_id": conversation_id,
        "conversation": chat_store.get_conversation(conversation_id, include_messages=False),
    })


@app.post("/api/cron/compose")
def cron_compose():
    """Compose a scheduled brief using primary Ministral or a temporary CPU-only instance of the same model."""
    body = request.get_json(silent=True) or {}
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return _json_error("Scheduled composition prompt is required.")
    system_prompt = str(body.get("system_prompt") or "").strip() or (
        "You are a concise local assistant. Use only the supplied evidence. Never invent missing facts."
    )
    model, settings = _browser_os_model_and_settings()
    if model is None:
        return _json_error("No registered GGUF model is available. Add/select a model in Tiny Web Agent first.", 409)
    max_tokens = max(96, min(512, int(body.get("max_tokens") or 320)))
    primary_path = str(model["path"])
    primary_busy = _primary_inference_busy()
    # Fast path: if the interactive lane is occupied, run the exact same GGUF
    # in a second temporary CPU-only model instance. The OS can reuse mmap/page-cache
    # pages while this instance keeps its own small Q4 KV cache and compute buffers.
    if primary_busy:
        try:
            response, bg_meta = run_background_composition(
                model_path=primary_path,
                system_prompt=system_prompt,
                prompt=prompt,
                max_tokens=max_tokens,
                context_length=2048,
                threads=3,
                kv_cache="q4_0",
            )
            return jsonify({
                "ok": True,
                "response": str(response or "").strip(),
                "meta": {
                    "model": Path(primary_path).name,
                    "context_chars": len(prompt) + len(system_prompt),
                    "max_tokens": max_tokens,
                    "inference_lane": "background_cpu_q5",
                    "temporary_model": True,
                    **bg_meta,
                },
            })
        except Exception as background_error:
            # Scheduled work should remain reliable even if a particular llama.cpp
            # build cannot create the temporary CPU instance/Q4 KV cache. Fall through
            # and wait for the primary model rather than failing the job.
            logging.warning("Background CPU CRON inference failed; waiting for primary model: %s", background_error)

    compose_settings = dict(settings)
    compose_settings.update({
        "temperature": 0.08,
        "max_tokens": max_tokens,
        "max_tool_calls": 0,
        "compaction_enabled": False,
        "compact_tool_prompt": True,
    })
    try:
        response, _state, meta = run_agent_turn(
            model_path=primary_path,
            settings=compose_settings,
            state=[],
            prompt=prompt,
            tool_bundle=({}, []),
            system_prompt_override=system_prompt,
            append_action_summary=False,
        )
        public_meta = {
            "model": model.get("name") or Path(primary_path).name,
            "context_chars": len(prompt) + len(system_prompt),
            "max_tokens": max_tokens,
            "inference_lane": "primary" if not primary_busy else "primary_after_fallback",
            "temporary_model": False,
        }
        for key in ("prompt_tokens", "completion_tokens", "tokens_per_second", "load_seconds", "finish_reason"):
            if key in (meta or {}):
                public_meta[key] = meta[key]
        return jsonify({"ok": True, "response": str(response or "").strip(), "meta": public_meta})
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 503)


def _runtime_model_status() -> dict[str, Any]:
    return {
        "model_path": model_manager.model_path,
        "loaded": model_manager.llm is not None,
        "idle_timeout_seconds": int(model_manager.idle_timeout_seconds or 0),
        "idle_seconds": round(model_manager.idle_seconds(), 1) if model_manager.llm is not None else None,
        "vram_governor": model_manager.vram_status(),
    }


@app.get("/api/runtime")
def runtime_status():
    return jsonify(_runtime_model_status())


@app.get("/api/bootstrap")
def bootstrap():
    models = chat_store.list_models()
    conversations = chat_store.list_conversations()
    if not conversations:
        # Fresh installs deliberately start with no model selected.
        chat_store.create_conversation(None)
        conversations = chat_store.list_conversations()
    return jsonify({
        "models": models,
        "conversations": conversations,
        "presets": chat_store.list_presets(),
        "defaults": chat_store.DEFAULT_SETTINGS,
        "skills": [skill.public_summary() for skill in load_skills().values()],
        "tools": get_tool_descriptors(),
        "external_tools": {
            "directory": str(EXTERNAL_TOOLS_DIR),
            "template": json.dumps(EXTERNAL_TOOL_TEMPLATE, ensure_ascii=False, indent=2),
        },
        "runtime": _runtime_model_status(),
    })


@app.post("/api/tools/external/import")
def import_external_tool_file():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return _json_error("Choose a Python .py file first.")

    filename = secure_filename(upload.filename)
    if not filename.lower().endswith(".py"):
        return _json_error("External tool files must use the .py extension.")

    EXTERNAL_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    destination = EXTERNAL_TOOLS_DIR / filename
    try:
        upload.save(destination)
        # Validate Python syntax immediately, but the function name is validated
        # later against the JSON definition.
        import ast
        ast.parse(destination.read_text(encoding="utf-8"), filename=str(destination))
    except Exception as error:
        try:
            destination.unlink(missing_ok=True)
        except Exception:
            pass
        return _json_error(f"Unable to import Python file: {type(error).__name__}: {error}")

    print(f"[Tools] imported external Python file: {destination}")
    return jsonify({
        "ok": True,
        "filename": filename,
        "path": str(destination),
        "directory": str(EXTERNAL_TOOLS_DIR),
    })


@app.post("/api/tools/external/register")
def register_external_tool():
    body = request.get_json(silent=True) or {}
    definition_text = body.get("definition")
    if not isinstance(definition_text, str) or not definition_text.strip():
        return _json_error("Paste a JSON tool definition first.")
    try:
        definition = register_external_tool_definition(definition_text)
        print(f"[Tools] registered external tool: {definition['name']}")
        return jsonify({"ok": True, "tool": definition, "tools": get_tool_descriptors()})
    except Exception as error:
        print(f"[Tools] external registration failed: {type(error).__name__}: {error}")
        return _json_error(f"{type(error).__name__}: {error}")


@app.post("/api/tools/reload")
def reload_tools_route():
    errors = reload_external_tools()
    for error in errors:
        print(f"[Tools] reload warning: {error}")
    return jsonify({"ok": True, "tools": get_tool_descriptors(), "errors": errors})


@app.get("/api/models")
def list_models():
    return jsonify(chat_store.list_models())


@app.post("/api/models")
def add_model():
    body = request.get_json(silent=True) or {}
    path = str(body.get("path") or "").strip()
    name = str(body.get("name") or "").strip() or None
    if not path:
        return _json_error("A GGUF file or folder path is required.")
    try:
        normalized = chat_store.normalize_model_path(path)
        print(f"[Models] add request: {path!r} -> {normalized!r}")

        if os.path.isdir(normalized):
            models = chat_store.scan_model_path(normalized)
            if not models:
                return _json_error("No .gguf files were found directly inside that folder.", 404)
            return jsonify({"models": models})

        if not os.path.isfile(normalized):
            return _json_error(f"Path does not exist or is not a file: {normalized}", 404)
        if not normalized.lower().endswith(".gguf"):
            return _json_error("Model files must use the .gguf extension.")

        model = chat_store.add_model(normalized, name=name)
        print(f"[Models] registered id={model['id']} path={model['path']!r}")
        return jsonify({"models": [model]})
    except Exception as error:
        print(f"[Models] add failed: {type(error).__name__}: {error}")
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.post("/api/models/browse")
def browse_model_file():
    """Open a native file picker on the host machine and register the GGUF by path."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except tk.TclError:
            pass
        root.update()

        try:
            selected = filedialog.askopenfilename(
                parent=root,
                title="Select GGUF model",
                filetypes=[
                    ("GGUF models", "*.gguf"),
                    ("All files", "*.*"),
                ],
            )
        finally:
            root.destroy()

        if not selected:
            return jsonify({"cancelled": True})

        normalized = chat_store.normalize_model_path(selected)
        if not os.path.isfile(normalized):
            return _json_error(f"Model file does not exist: {normalized}", 404)
        if not normalized.lower().endswith(".gguf"):
            return _json_error("Choose a .gguf model file.")

        model = chat_store.add_model(normalized)
        print(f"[Models] browsed and registered id={model['id']} path={model['path']!r}")
        return jsonify({"cancelled": False, "model": model})
    except Exception as error:
        print(f"[Models] browse failed: {type(error).__name__}: {error}")
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.delete("/api/models/<int:model_id>")
def remove_model(model_id: int):
    model = chat_store.get_model(model_id)
    if not model:
        return _json_error("Model not found.", 404)
    if model_manager.model_path and Path(model_manager.model_path) == Path(model["path"]):
        with model_manager.inference_lock:
            model_manager.unload()
    chat_store.remove_model(model_id)
    return jsonify({"ok": True})


@app.get("/api/presets")
def list_presets():
    return jsonify(chat_store.list_presets())


@app.post("/api/presets")
def create_preset():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip()
    if not name:
        return _json_error("Preset name cannot be empty.")
    model_value = body.get("model_id")
    try:
        model_id = None if model_value in (None, "") else int(model_value)
    except (TypeError, ValueError):
        return _json_error("Invalid model id.")
    if model_id is not None and chat_store.get_model(model_id) is None:
        return _json_error("Selected model is not registered.", 404)
    settings = body.get("settings")
    if settings is not None and not isinstance(settings, dict):
        return _json_error("Preset settings must be an object.")
    try:
        preset = chat_store.create_preset(
            name,
            description=str(body.get("description") or ""),
            model_id=model_id,
            settings=settings,
        )
        return jsonify(preset)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}")


@app.patch("/api/presets/<preset_id>")
def update_preset(preset_id: str):
    current = chat_store.get_preset(preset_id)
    if current is None:
        return _json_error("Preset not found.", 404)
    body = request.get_json(silent=True) or {}
    kwargs: dict[str, Any] = {}
    if "name" in body:
        kwargs["name"] = str(body.get("name") or "")
    if "description" in body:
        kwargs["description"] = str(body.get("description") or "")
    if "model_id" in body:
        value = body.get("model_id")
        try:
            model_id = None if value in (None, "") else int(value)
        except (TypeError, ValueError):
            return _json_error("Invalid model id.")
        if model_id is not None and chat_store.get_model(model_id) is None:
            return _json_error("Selected model is not registered.", 404)
        kwargs["model_id"] = model_id
    if "settings" in body:
        if not isinstance(body.get("settings"), dict):
            return _json_error("Preset settings must be an object.")
        kwargs["settings"] = body["settings"]
    try:
        return jsonify(chat_store.update_preset(preset_id, **kwargs))
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}")


@app.delete("/api/presets/<preset_id>")
def delete_preset(preset_id: str):
    if chat_store.get_preset(preset_id) is None:
        return _json_error("Preset not found.", 404)
    chat_store.delete_preset(preset_id)
    return jsonify({"ok": True})


@app.get("/api/conversations")
def list_conversations():
    return jsonify(chat_store.list_conversations())


@app.post("/api/conversations")
def create_conversation():
    body = request.get_json(silent=True) or {}
    preset_id = str(body.get("preset_id") or "").strip() or None
    model_id = body.get("model_id")
    if model_id is not None:
        try:
            model_id = int(model_id)
        except (TypeError, ValueError):
            return _json_error("Invalid model id.")
    if preset_id and chat_store.get_preset(preset_id) is None:
        return _json_error("Preset not found.", 404)
    try:
        conversation = chat_store.create_conversation(model_id, preset_id=preset_id)
        return jsonify(conversation)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}")


@app.get("/api/conversations/<conversation_id>")
def get_conversation(conversation_id: str):
    conversation = chat_store.get_conversation(conversation_id, include_messages=True)
    if not conversation:
        return _json_error("Conversation not found.", 404)
    for message in conversation.get("messages", []):
        if message.get("role") == "assistant":
            message["html"] = render_markdown(message.get("content", ""))
    return jsonify(conversation)


@app.patch("/api/conversations/<conversation_id>")
def patch_conversation(conversation_id: str):
    conversation = chat_store.get_conversation(conversation_id, include_messages=False)
    if not conversation:
        return _json_error("Conversation not found.", 404)

    body = request.get_json(silent=True) or {}
    kwargs: dict[str, Any] = {}
    if "title" in body:
        kwargs["title"] = str(body["title"])
    if "model_id" in body:
        value = body["model_id"]
        kwargs["model_id"] = None if value in (None, "") else int(value)
    if "settings" in body:
        merged = conversation["settings"].copy()
        merged.update(body.get("settings") or {})
        kwargs["settings"] = merged

    try:
        chat_store.update_conversation(conversation_id, **kwargs)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)

    return jsonify(chat_store.get_conversation(conversation_id, include_messages=True))


@app.post("/api/conversations/<conversation_id>/model")
def set_conversation_model(conversation_id: str):
    conversation = chat_store.get_conversation(conversation_id, include_messages=False)
    if not conversation:
        return _json_error("Conversation not found.", 404)
    body = request.get_json(silent=True) or {}
    value = body.get("model_id")
    try:
        model_id = None if value in (None, "") else int(value)
    except (TypeError, ValueError):
        return _json_error("Invalid model id.")
    if model_id is not None and chat_store.get_model(model_id) is None:
        return _json_error("Model not found.", 404)
    print(f"[Models] conversation {conversation_id}: model_id -> {model_id}")
    chat_store.update_conversation(conversation_id, model_id=model_id)
    return jsonify(chat_store.get_conversation(conversation_id, include_messages=True))


@app.post("/api/conversations/<conversation_id>/settings")
def save_conversation_settings(conversation_id: str):
    """Atomically persist model selection + settings for one conversation."""
    conversation = chat_store.get_conversation(conversation_id, include_messages=False)
    if not conversation:
        return _json_error("Conversation not found.", 404)

    body = request.get_json(silent=True) or {}
    raw_settings = body.get("settings")
    if not isinstance(raw_settings, dict):
        return _json_error("Settings payload must be an object.")

    value = body.get("model_id", conversation.get("model_id"))
    try:
        model_id = None if value in (None, "") else int(value)
    except (TypeError, ValueError):
        return _json_error("Invalid model id.")
    if model_id is not None and chat_store.get_model(model_id) is None:
        return _json_error("Selected model is not registered.", 404)

    merged = conversation["settings"].copy()
    merged.update(raw_settings)

    try:
        # Normalize basic scalar values once on the server, rather than trusting
        # browser Number() coercion or HTML input state.
        required_ints = (
            "max_tokens", "context_length", "gpu_layers", "threads",
            "max_tool_calls", "compaction_threshold", "compaction_target",
            "keep_recent_turns", "summary_max_tokens",
        )
        optional_ints = ("top_k", "n_batch", "n_ubatch")
        optional_floats = ("top_p", "repeat_penalty")

        merged["temperature"] = float(merged.get("temperature", 0.05))
        for key in required_ints:
            merged[key] = int(merged[key])
        for key in optional_ints:
            merged[key] = None if merged.get(key) in (None, "") else int(merged[key])
        for key in optional_floats:
            merged[key] = None if merged.get(key) in (None, "") else float(merged[key])
        for key in ("flash_attention", "tools_enabled", "compaction_enabled"):
            merged[key] = bool(merged.get(key))
        merged["tool_overrides"] = normalize_tool_overrides(merged.get("tool_overrides"))
        if merged.get("offload_kqv") not in (None, True, False):
            raise ValueError("offload_kqv must be Auto, On, or Off")
        if str(merged.get("kv_cache", "default")) not in {"default", "f16", "q8_0", "q4_0"}:
            raise ValueError("Unsupported KV cache type")
        merged["system_prompt"] = str(merged.get("system_prompt") or "")
        print(f"[Settings] save conversation={conversation_id} model_id={model_id}")
        chat_store.update_conversation(
            conversation_id,
            model_id=model_id,
            settings=merged,
        )
        saved = chat_store.get_conversation(conversation_id, include_messages=True)
        print(f"[Settings] saved conversation={conversation_id}")
        return jsonify(saved)
    except (TypeError, ValueError, KeyError) as error:
        print(f"[Settings] validation failed: {type(error).__name__}: {error}")
        return _json_error(f"Invalid settings: {error}")
    except Exception as error:
        print(f"[Settings] save failed: {type(error).__name__}: {error}")
        return _json_error(f"{type(error).__name__}: {error}", 500)


@app.delete("/api/conversations")
def delete_conversations():
    body = request.get_json(silent=True) or {}
    raw_ids = body.get("ids")
    if not isinstance(raw_ids, list):
        return _json_error("ids must be an array of conversation ids.")

    conversation_ids = [str(item).strip() for item in raw_ids if str(item).strip()]
    conversation_ids = list(dict.fromkeys(conversation_ids))
    if not conversation_ids:
        return _json_error("Select at least one conversation to delete.")
    if len(conversation_ids) > 1000:
        return _json_error("Too many conversations selected at once.")

    try:
        deleted = chat_store.delete_conversations(conversation_ids)
        delete_conversation_attachments(conversation_ids)
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}", 500)

    return jsonify({"ok": True, "deleted": deleted, "requested": len(conversation_ids)})


@app.delete("/api/conversations/<conversation_id>")
def delete_conversation(conversation_id: str):
    if not chat_store.get_conversation(conversation_id, include_messages=False):
        return _json_error("Conversation not found.", 404)
    chat_store.delete_conversation(conversation_id)
    delete_conversation_attachments([conversation_id])
    return jsonify({"ok": True})


@app.post("/api/file-overwrite-confirm/<confirmation_id>")
def confirm_file_overwrite(confirmation_id: str):
    body = request.get_json(silent=True) or {}
    approved = bool(body.get("approved"))

    with _pending_file_confirmations_lock:
        pending = _pending_file_confirmations.get(confirmation_id)
        if pending is None:
            return _json_error("Overwrite confirmation is no longer pending.", 404)
        pending["approved"] = approved
        pending["event"].set()

    return jsonify({"ok": True, "approved": approved})


@app.post("/api/conversations/<conversation_id>/attachments")
def upload_attachment(conversation_id: str):
    if not chat_store.get_conversation(conversation_id, include_messages=False):
        return _json_error("Conversation not found.", 404)

    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return _json_error("Choose a file to attach.")

    try:
        attachment = save_attachment(conversation_id, upload)
        return jsonify({"ok": True, "attachment": attachment})
    except Exception as error:
        return _json_error(f"{type(error).__name__}: {error}")


@app.post("/api/cancel")
def cancel_generation():
    model_manager.cancel()
    return jsonify({"ok": True})


@app.post("/api/chat/<conversation_id>")
def chat(conversation_id: str):
    conversation = chat_store.get_conversation(conversation_id, include_messages=True)
    if not conversation:
        return _json_error("Conversation not found.", 404)

    body = request.get_json(silent=True) or {}
    prompt = str(body.get("message") or "").strip()
    raw_attachment_ids = body.get("attachment_ids") or []
    if not isinstance(raw_attachment_ids, list):
        return _json_error("attachment_ids must be an array.")
    attachment_ids = [str(item).strip() for item in raw_attachment_ids if str(item).strip()]
    if not prompt and not attachment_ids:
        return _json_error("Message cannot be empty.")
    if not prompt:
        prompt = "Please analyze the attached file or files."

    requested_skill_mode = str(
        body.get("skill") or conversation.get("settings", {}).get("skill_mode") or "auto"
    ).strip().lower()
    forced_skill = None if requested_skill_mode in {"", "auto"} else requested_skill_mode

    try:
        attachment_context = build_attachment_context(conversation_id, attachment_ids, prompt)
    except Exception as error:
        return _json_error(f"Attachment error: {type(error).__name__}: {error}")

    inference_prompt = prompt
    if attachment_context:
        inference_prompt = prompt + "\n\n" + attachment_context

    # The toolbar selection is also sent with the chat request. This makes the
    # backend resilient to a stale frontend conversation object: if the user
    # chose a model, persist it here before inference instead of rejecting the
    # prompt with a misleading "Select a model" error.
    requested_model_id = body.get("model_id")
    if requested_model_id not in (None, ""):
        try:
            requested_model_id = int(requested_model_id)
        except (TypeError, ValueError):
            return _json_error("Invalid model id.")
        requested_model = chat_store.get_model(requested_model_id)
        if requested_model is None:
            return _json_error("Selected model is not registered.", 404)
        if conversation.get("model_id") != requested_model_id:
            chat_store.update_conversation(conversation_id, model_id=requested_model_id)
            conversation = chat_store.get_conversation(conversation_id, include_messages=True)

    model = chat_store.get_model(conversation.get("model_id"))
    if model is None:
        return _json_error("Select a GGUF model first.", 409)
    model_path = chat_store.resolve_model_path(model["path"])
    if not model_path.exists():
        return _json_error(f"Model file no longer exists: {model_path}", 409)

    # Normal messages are appended. When editing an existing user message, keep
    # the same conversation id, replace that message in place, remove everything
    # after it, and rebuild a clean inference state from the messages before it.
    edit_message_id = body.get("edit_message_id")
    if edit_message_id not in (None, ""):
        try:
            edit_message_id = int(edit_message_id)
        except (TypeError, ValueError):
            return _json_error("Invalid edit message id.")
        try:
            conversation, user_message = chat_store.edit_user_message_and_truncate(
                conversation_id,
                edit_message_id,
                prompt,
            )
        except KeyError as error:
            return _json_error(str(error).strip("'"), 404)
        except ValueError as error:
            return _json_error(str(error))
    else:
        user_message = chat_store.append_message(conversation_id, "user", prompt)
        chat_store.maybe_set_title_from_first_user_message(conversation_id, prompt)

    event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    event_queue.put({"event": "user_saved", "message": user_message})
    streamed_markdown_parts: list[str] = []

    def on_event(event: str, payload: dict[str, Any]) -> None:
        # Render the accumulated assistant Markdown during generation instead of
        # showing raw Markdown until the final `done` event. This keeps headings,
        # lists, emphasis, tables and code blocks formatted while tokens stream.
        outgoing = dict(payload)
        if event == "token":
            piece = str(outgoing.get("text") or "")
            streamed_markdown_parts.append(piece)
            outgoing["html"] = render_markdown("".join(streamed_markdown_parts))
        event_queue.put({"event": event, **outgoing})

    def request_file_overwrite(path: str) -> bool:
        confirmation_id = uuid.uuid4().hex
        wait_event = threading.Event()
        pending = {"event": wait_event, "approved": False, "path": path}

        with _pending_file_confirmations_lock:
            _pending_file_confirmations[confirmation_id] = pending

        event_queue.put({
            "event": "file_overwrite_confirmation",
            "confirmation_id": confirmation_id,
            "path": path,
        })

        # Avoid leaving the inference worker blocked forever if the browser closes.
        wait_event.wait(timeout=300)

        with _pending_file_confirmations_lock:
            current = _pending_file_confirmations.pop(confirmation_id, pending)

        return bool(current.get("approved"))

    def worker() -> None:
        try:
            recent_context = _recent_tiny_task_context(conversation.get("messages") or [])
            selector_query = inference_prompt
            if recent_context:
                selector_query = recent_context + "\nCurrent request: " + inference_prompt

            on_event("skill_selection_start", {
                "query": prompt[:240],
                "mode": "manual" if forced_skill else "auto",
                "forced_skill": forced_skill,
            })
            selected_skill, skill_candidates, skill_routing = _select_browser_os_skill(
                model=model,
                settings=conversation["settings"],
                query=selector_query,
                forced_skill=forced_skill,
                event_callback=on_event,
            )
            if selected_skill.name != "general":
                all_skill_functions, _ = _browser_os_available_tools()
                validate_skill_tools(selected_skill, set(all_skill_functions))

            on_event("skill_selected", {
                "skill": selected_skill.name,
                "description": selected_skill.description,
                "candidates": skill_candidates,
                "selection_mode": "manual" if forced_skill else "auto",
                "reason": skill_routing.get("reason"),
                "routing": skill_routing,
            })

            skill_settings = dict(conversation["settings"])
            limits = selected_skill.metadata.get("limits") if isinstance(selected_skill.metadata.get("limits"), dict) else {}
            skill_max_calls = limits.get("max_tool_calls")
            if skill_max_calls is None:
                skill_max_calls = min(int(skill_settings.get("max_tool_calls", 10)), 6)
            skill_settings.update({
                "temperature": min(float(skill_settings.get("temperature", 0.05)), 0.15),
                "max_tool_calls": max(0, min(12, int(skill_max_calls))),
                "compaction_enabled": False,
                "compact_tool_prompt": True,
            })

            task_prompt = inference_prompt
            if recent_context:
                task_prompt = f"RECENT TASK CONTEXT:\n{recent_context}\n\nCURRENT USER:\n{inference_prompt}"
            else:
                task_prompt = f"CURRENT USER:\n{inference_prompt}"

            response_text, new_state, meta = run_agent_turn(
                model_path=model["path"],
                settings=skill_settings,
                state=[],
                prompt=task_prompt,
                event_callback=on_event,
                file_overwrite_callback=request_file_overwrite,
                tool_bundle=_tiny_skill_tool_bundle(selected_skill, skill_settings),
                system_prompt_override=_tiny_skill_system_prompt(selected_skill),
            )

            assistant_message = None
            if response_text or meta.get("cancelled"):
                visible_text = response_text or "[Generation stopped]"
                assistant_message = chat_store.append_message(conversation_id, "assistant", visible_text)

            if assistant_message is not None and meta.get("tool_traces"):
                chat_store.append_tool_traces(
                    conversation_id,
                    assistant_message["id"],
                    meta["tool_traces"],
                )

            chat_store.update_conversation(
                conversation_id,
                agent_state=new_state,
            )
            public_meta = dict(meta)
            public_meta["skill"] = selected_skill.public_summary()
            public_meta["skill_candidates"] = skill_candidates
            public_meta["skill_routing"] = skill_routing
            # Full tool results have already been streamed once and persisted in
            # SQLite. Do not duplicate potentially large outputs in the final event.
            public_meta.pop("tool_traces", None)
            event_queue.put({
                "event": "done",
                "response": response_text,
                "response_html": render_markdown(response_text),
                "meta": public_meta,
                "conversation": chat_store.get_conversation(conversation_id, include_messages=False),
            })
        except Exception as error:
            event_queue.put({
                "event": "error",
                "message": f"{type(error).__name__}: {error}",
            })
        finally:
            event_queue.put({"event": "_close"})

    threading.Thread(target=worker, daemon=True).start()

    @stream_with_context
    def generate():
        while True:
            try:
                event = event_queue.get(timeout=10)
            except queue.Empty:
                yield json.dumps({"event": "ping"}) + "\n"
                continue

            if event.get("event") == "_close":
                break
            yield json.dumps(event, ensure_ascii=False, default=_json_stream_default) + "\n"

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def parse_args():
    parser = argparse.ArgumentParser(description="Tiny Local Web Agent")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.verbose:
        os.environ["TINY_AGENT_VERBOSE"] = "1"

    chat_store.init_db()

    url = f"http://{args.host}:{args.port}"
    print(f"Tiny Local Web Agent: {url}")
    print(f"Portable app dir:     {APP_DIR}")
    print(f"Database:             {chat_store.DB_PATH}")
    print("Tools:                " + ", ".join(sorted(__import__('tools.tool_registry', fromlist=['tool_functions']).tool_functions)))

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
