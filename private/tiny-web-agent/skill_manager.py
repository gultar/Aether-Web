from __future__ import annotations

import hashlib
import json
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from runtime_paths import APP_DIR, DATA_DIR, RESOURCE_DIR
from tools.web_search import EMBEDDING_MODEL, _cosine_similarity, _embedding_lock, _get_embedding_model

_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
_CATEGORY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 _&/\-]{0,47}$")
_FRONTMATTER_RE = re.compile(r"\A---\s*\r?\n(?P<meta>.*?)\r?\n---\s*\r?\n(?P<body>.*)\Z", re.DOTALL)
_INDEX_LOCK = threading.RLock()
STARTER_SKILL_NAMES = frozenset({"general", "browser-os-dev", "browse", "research", "system", "news"})

DEFAULT_CATEGORY_DESCRIPTIONS = {
    "General": "General conversation, explanation, everyday assistance, and specialized skills that do not belong to a narrower category.",
    "Coding": "Programming, software development, debugging, scripting, code generation, and development work outside BrowserOS itself.",
    "BrowserOS": "BrowserOS development, desktop/system actions, app launching, configuration, automation, and BrowserOS-specific maintenance.",
    "Research": "Web browsing, current information, news, source reading, and multi-source research.",
    "Translation": "Translation, localization, terminology, bilingual rewriting, and language-specific translation workflows.",
    "Writing": "Drafting, rewriting, editing, summarizing, and other writing workflows.",
    "Creative": "Creative writing, games, divination, worldbuilding, and other creative workflows.",
}
CATEGORY_DESCRIPTIONS = dict(DEFAULT_CATEGORY_DESCRIPTIONS)


# Runtime paths must exist before category state is loaded during module import.
# In source builds RESOURCE_DIR == APP_DIR. In frozen builds bundled defaults live
# in RESOURCE_DIR while learned/user-approved skills live beside the executable.
BUNDLED_SKILLS_DIR = RESOURCE_DIR / "skills"
SKILLS_DIR = APP_DIR / "skills"
SKILL_INDEX_PATH = DATA_DIR / "skill_index.json"
DELETED_SKILLS_PATH = DATA_DIR / "deleted_skills.json"
SKILL_CATEGORIES_PATH = DATA_DIR / "skill_categories.json"


def _clean_category(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())[:48]
    if not text:
        return "General"
    for known in CATEGORY_DESCRIPTIONS:
        if text.casefold() == known.casefold():
            return known
    return text[:1].upper() + text[1:]

def _category_name(value: str) -> str:
    name = re.sub(r"\s+", " ", str(value or "").strip())[:48]
    if not name or not _CATEGORY_RE.fullmatch(name):
        raise ValueError("Category name must start with a letter and contain only letters, numbers, spaces, -, _, &, or / (max 48 characters).")
    return name


def _category_description(value: str) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > 320:
        raise ValueError("Category description must be 320 characters or fewer.")
    return text


def _read_category_store() -> dict[str, str]:
    if not SKILL_CATEGORIES_PATH.exists():
        return dict(DEFAULT_CATEGORY_DESCRIPTIONS)
    try:
        raw = json.loads(SKILL_CATEGORIES_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("categories"), list):
            result: dict[str, str] = {}
            for item in raw["categories"]:
                if not isinstance(item, dict):
                    continue
                try:
                    name = _category_name(item.get("name"))
                except ValueError:
                    continue
                result[name] = _category_description(item.get("description"))
            if result:
                if "General" not in result:
                    result["General"] = DEFAULT_CATEGORY_DESCRIPTIONS["General"]
                return result
    except Exception:
        pass
    return dict(DEFAULT_CATEGORY_DESCRIPTIONS)


def _write_category_store(categories: dict[str, str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    normalized = []
    for name in sorted(categories, key=lambda value: (value != "General", value.casefold())):
        normalized.append({"name": name, "description": _category_description(categories[name])})
    temp = SKILL_CATEGORIES_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps({"categories": normalized}, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(SKILL_CATEGORIES_PATH)


def refresh_category_descriptions() -> dict[str, str]:
    CATEGORY_DESCRIPTIONS.clear()
    CATEGORY_DESCRIPTIONS.update(_read_category_store())
    return dict(CATEGORY_DESCRIPTIONS)


def load_category_descriptions(*, include_skills: bool = True) -> dict[str, str]:
    categories = refresh_category_descriptions()
    if include_skills:
        # Categories that predate the category manager remain visible until the
        # user explicitly edits/deletes them.
        for skill in load_skills().values():
            categories.setdefault(skill.category, f"Skills categorized as {skill.category}.")
    return categories


def _resolve_category_name(value: str, categories: dict[str, str] | None = None) -> str:
    wanted = _category_name(value)
    pool = categories or load_category_descriptions(include_skills=True)
    for existing in pool:
        if existing.casefold() == wanted.casefold():
            return existing
    raise ValueError(f"Unknown category: {wanted}")


def _replace_skill_category_text(text: str, category: str) -> str:
    clean = _category_name(category)
    lines = str(text or "").splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("Skill must contain YAML frontmatter.")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration as error:
        raise ValueError("Skill must contain YAML frontmatter.") from error
    replaced = False
    for i in range(1, end):
        if re.match(r"^\s*category\s*:", lines[i], re.I):
            lines[i] = f"category: {clean}"
            replaced = True
            break
    if not replaced:
        insert_at = end
        for i in range(1, end):
            if re.match(r"^\s*description\s*:", lines[i], re.I):
                insert_at = i + 1
                break
        lines.insert(insert_at, f"category: {clean}")
    return "\n".join(lines).strip() + "\n"


def _rewrite_skill_categories(source: str, target: str) -> list[str]:
    changed: list[str] = []
    for skill in list(load_skills().values()):
        if skill.category.casefold() != source.casefold():
            continue
        text = skill.path.read_text(encoding="utf-8")
        updated = _replace_skill_category_text(text, target)
        temp = skill.path.with_suffix(skill.path.suffix + ".tmp")
        temp.write_text(updated, encoding="utf-8")
        temp.replace(skill.path)
        _drop_skill_index_record(skill.name)
        changed.append(skill.name)
    return changed


def create_category(name: str, description: str = "") -> dict[str, Any]:
    categories = load_category_descriptions(include_skills=True)
    clean = _category_name(name)
    if any(existing.casefold() == clean.casefold() for existing in categories):
        raise FileExistsError(f"Category already exists: {clean}")
    stored = refresh_category_descriptions()
    stored[clean] = _category_description(description) or f"Skills categorized as {clean}."
    _write_category_store(stored)
    refresh_category_descriptions()
    return {"name": clean, "description": CATEGORY_DESCRIPTIONS[clean]}


def update_category(name: str, *, new_name: str | None = None, description: str | None = None) -> dict[str, Any]:
    all_categories = load_category_descriptions(include_skills=True)
    current = _resolve_category_name(name, all_categories)
    target = current if new_name is None else _category_name(new_name)
    if current == "General" and target != "General":
        raise PermissionError("General is the protected fallback category and cannot be renamed.")
    for existing in all_categories:
        if existing.casefold() == target.casefold() and existing.casefold() != current.casefold():
            raise FileExistsError(f"Category already exists: {target}")

    stored = refresh_category_descriptions()
    old_description = all_categories.get(current, f"Skills categorized as {current}.")
    if current in stored:
        stored.pop(current, None)
    stored[target] = _category_description(description) if description is not None else old_description
    _write_category_store(stored)
    changed = []
    if target != current:
        changed = _rewrite_skill_categories(current, target)
    refresh_category_descriptions()
    return {"name": target, "description": CATEGORY_DESCRIPTIONS.get(target, old_description), "renamed_from": current, "updated_skills": changed}


def delete_category(name: str, *, reassign_to: str = "General") -> dict[str, Any]:
    all_categories = load_category_descriptions(include_skills=True)
    current = _resolve_category_name(name, all_categories)
    if current == "General":
        raise PermissionError("General is the protected fallback category and cannot be deleted.")
    target = _resolve_category_name(reassign_to or "General", all_categories)
    if target.casefold() == current.casefold():
        raise ValueError("Choose a different category for reassignment.")
    changed = _rewrite_skill_categories(current, target)
    stored = refresh_category_descriptions()
    stored.pop(current, None)
    _write_category_store(stored)
    refresh_category_descriptions()
    return {"deleted": current, "reassigned_to": target, "updated_skills": changed}


def ensure_category_registered(name: str) -> str:
    clean = _clean_category(name)
    categories = load_category_descriptions(include_skills=False)
    for existing in categories:
        if existing.casefold() == clean.casefold():
            return existing
    stored = refresh_category_descriptions()
    stored[clean] = f"Skills categorized as {clean}."
    _write_category_store(stored)
    refresh_category_descriptions()
    return clean


refresh_category_descriptions()


def _infer_category(name: str, description: str, tools: list[str] | tuple[str, ...]) -> str:
    haystack = " ".join([str(name or ""), str(description or ""), " ".join(tools)]).lower()
    if name == "general":
        return "General"
    if name in {"browser-os-dev", "system", "app-launcher"} or "browseros" in haystack or "browser_" in haystack:
        return "BrowserOS"
    if any(word in haystack for word in ("code", "coding", "programming", "developer", "debug", "python", "javascript", "powershell", "script")):
        return "Coding"
    if name in {"browse", "research", "news"} or any(word in haystack for word in ("research", "web search", "news", "headline", "current information")):
        return "Research"
    if any(word in haystack for word in ("translation", "translator", "localization", "terminology", "bilingual")):
        return "Translation"
    if any(word in haystack for word in ("rewrite", "writing", "draft", "editing", "summarize")):
        return "Writing"
    if any(word in haystack for word in ("creative", "worldbuilding", "story", "fiction", "geomancy", "divination", "game master")):
        return "Creative"
    return "General"



@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    tools: tuple[str, ...]
    body: str
    path: Path
    metadata: dict[str, Any]

    @property
    def retrieval_text(self) -> str:
        # The short description carries most of the retrieval signal. The name is
        # included so literal concepts such as browser-os-dev still match cleanly.
        return f"{self.name.replace('-', ' ')}. {self.description}".strip()

    @property
    def category(self) -> str:
        explicit = self.metadata.get("category")
        if explicit:
            return _clean_category(str(explicit))
        return _infer_category(self.name, self.description, self.tools)

    def public_summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "tools": list(self.tools),
        }


def _default_skill_files() -> list[Path]:
    if not BUNDLED_SKILLS_DIR.is_dir():
        return []
    return sorted(path for path in BUNDLED_SKILLS_DIR.glob("*.md") if path.is_file())


def _load_deleted_skill_names() -> set[str]:
    try:
        raw = json.loads(DELETED_SKILLS_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return {str(name or "").strip().lower() for name in raw if str(name or "").strip()}
        if isinstance(raw, dict):
            values = raw.get("skills")
            if isinstance(values, list):
                return {str(name or "").strip().lower() for name in values if str(name or "").strip()}
    except Exception:
        pass
    return set()


def _save_deleted_skill_names(names: set[str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    normalized = sorted({str(name or "").strip().lower() for name in names if str(name or "").strip()})
    temp = DELETED_SKILLS_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps({"skills": normalized}, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(DELETED_SKILLS_PATH)


def _mark_skill_deleted(name: str) -> None:
    names = _load_deleted_skill_names()
    names.add(str(name or "").strip().lower())
    _save_deleted_skill_names(names)


def _clear_skill_deleted(name: str) -> None:
    names = _load_deleted_skill_names()
    normalized = str(name or "").strip().lower()
    if normalized in names:
        names.remove(normalized)
        _save_deleted_skill_names(names)


def ensure_default_skills() -> None:
    """Install bundled starter skills without replacing user-edited/learned files.

    Built-in skills explicitly deleted by the user stay deleted across restarts.
    """
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    if BUNDLED_SKILLS_DIR.resolve() == SKILLS_DIR.resolve():
        return
    deleted = _load_deleted_skill_names()
    for source in _default_skill_files():
        if source.stem.strip().lower() in deleted:
            continue
        target = SKILLS_DIR / source.name
        if not target.exists():
            target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")


def parse_skill_text(text: str, *, path: Path | None = None) -> Skill:
    match = _FRONTMATTER_RE.match(str(text or "").strip() + "\n")
    if not match:
        # Retry without the helper newline for files that already end exactly.
        match = _FRONTMATTER_RE.match(str(text or "").strip())
    if not match:
        raise ValueError("Skill must contain YAML frontmatter delimited by --- lines.")

    try:
        metadata = yaml.safe_load(match.group("meta")) or {}
    except yaml.YAMLError as error:
        raise ValueError(f"Invalid skill YAML metadata: {error}") from error
    if not isinstance(metadata, dict):
        raise ValueError("Skill YAML metadata must be a mapping.")

    name = str(metadata.get("name") or "").strip().lower()
    if not _NAME_RE.fullmatch(name):
        raise ValueError("Skill name must match [a-z][a-z0-9-]{1,63}.")

    description = " ".join(str(metadata.get("description") or "").split())
    if not description:
        raise ValueError("Skill description is required.")
    if len(description) > 320:
        raise ValueError("Skill description must be 320 characters or fewer.")

    raw_tools = metadata.get("tools") or []
    if isinstance(raw_tools, str):
        raw_tools = [raw_tools]
    if not isinstance(raw_tools, list):
        raise ValueError("Skill tools must be a YAML list.")
    tools: list[str] = []
    for item in raw_tools:
        tool = str(item or "").strip()
        if tool and tool not in tools:
            tools.append(tool)
    if len(tools) > 12:
        raise ValueError("A skill may expose at most 12 specialized tools.")

    body = match.group("body").strip()
    if not body:
        raise ValueError("Skill instructions are empty.")
    if len(body) > 12000:
        raise ValueError("Skill instructions are too large; keep them under 12,000 characters.")

    return Skill(
        name=name,
        description=description,
        tools=tuple(tools),
        body=body,
        path=path or Path(f"{name}.md"),
        metadata=dict(metadata),
    )


def load_skills() -> dict[str, Skill]:
    ensure_default_skills()
    deleted = _load_deleted_skill_names()
    result: dict[str, Skill] = {}
    for path in sorted(SKILLS_DIR.glob("*.md")):
        try:
            skill = parse_skill_text(path.read_text(encoding="utf-8"), path=path)
        except Exception as error:
            print(f"[Skills] ignored {path.name}: {type(error).__name__}: {error}")
            continue
        if skill.name in deleted:
            continue
        # File names do not grant overwrite/alias semantics. The YAML name is the
        # stable skill id and duplicate ids are rejected deterministically.
        if skill.name in result:
            print(f"[Skills] duplicate skill id ignored: {skill.name} ({path.name})")
            continue
        result[skill.name] = skill
    return result


def get_skill(name: str) -> Skill | None:
    return load_skills().get(str(name or "").strip().lower())


def _fingerprint(skill: Skill) -> str:
    return hashlib.sha256(skill.retrieval_text.encode("utf-8")).hexdigest()


def _load_index() -> dict[str, Any]:
    try:
        value = json.loads(SKILL_INDEX_PATH.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    return {"model": EMBEDDING_MODEL, "skills": {}}


def _save_index(index: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = SKILL_INDEX_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    temp.replace(SKILL_INDEX_PATH)


def _embed_texts(texts: list[str], *, query: bool) -> list[list[float]]:
    model = _get_embedding_model()
    with _embedding_lock:
        if query and hasattr(model, "query_embed"):
            vectors = list(model.query_embed(texts))
        elif not query and hasattr(model, "passage_embed"):
            vectors = list(model.passage_embed(texts, batch_size=32))
        else:
            vectors = list(model.embed(texts, batch_size=32))
    return [[float(v) for v in vector] for vector in vectors]


def _lexical_score(query: str, skill: Skill) -> float:
    words = set(re.findall(r"[a-z0-9]+", str(query or "").lower()))
    target = set(re.findall(r"[a-z0-9]+", skill.retrieval_text.lower()))
    if not words or not target:
        return 0.0
    return len(words & target) / max(1.0, (len(words) * len(target)) ** 0.5)


def retrieve_candidates(query: str, *, top_k: int = 5, category: str | None = None) -> list[tuple[Skill, float]]:
    """Return a tiny candidate set for the LLM selector.

    With only a handful of skills, all skills are cheaper than loading embeddings.
    Once the library grows beyond top_k, cached FastEmbed vectors provide semantic
    retrieval. Any embedding/download failure falls back to deterministic lexical
    ranking so BrowserOS remains usable offline.
    """
    skills = load_skills()
    if not skills:
        return []
    top_k = max(1, min(int(top_k), 12))
    category_filter = _clean_category(category) if category else None
    values = [skill for skill in skills.values() if not category_filter or skill.category == category_filter]
    if not values:
        return []
    if len(values) <= top_k:
        return [(skill, 1.0) for skill in values]

    try:
        with _INDEX_LOCK:
            index = _load_index()
            if index.get("model") != EMBEDDING_MODEL:
                index = {"model": EMBEDDING_MODEL, "skills": {}}
            records = index.setdefault("skills", {})
            missing: list[Skill] = []
            for skill in values:
                record = records.get(skill.name)
                if not isinstance(record, dict) or record.get("fingerprint") != _fingerprint(skill) or not isinstance(record.get("vector"), list):
                    missing.append(skill)
            if missing:
                vectors = _embed_texts([skill.retrieval_text for skill in missing], query=False)
                for skill, vector in zip(missing, vectors):
                    records[skill.name] = {"fingerprint": _fingerprint(skill), "vector": vector}
            for stale in set(records) - set(skills):
                records.pop(stale, None)
            _save_index(index)
            query_vector = _embed_texts([str(query or "")], query=True)[0]
            ranked = [
                (skill, _cosine_similarity(query_vector, records[skill.name]["vector"]))
                for skill in values
            ]
    except Exception as error:
        print(f"[Skills] semantic retrieval unavailable; lexical fallback: {type(error).__name__}: {error}")
        ranked = [(skill, _lexical_score(query, skill)) for skill in values]

    ranked.sort(key=lambda item: item[1], reverse=True)
    selected = ranked[:top_k]

    # General is always a safe NONE-like fallback for the selector without
    # permanently exposing every specialized skill.
    general = skills.get("general") if category_filter in {None, "General"} else None
    if general and all(skill.name != "general" for skill, _ in selected):
        if len(selected) >= top_k:
            selected[-1] = (general, 0.0)
        else:
            selected.append((general, 0.0))
    return selected


def validate_skill_tools(skill: Skill, available_tools: set[str]) -> None:
    unknown = [name for name in skill.tools if name not in available_tools]
    if unknown:
        raise ValueError("Skill references unknown tools: " + ", ".join(unknown))


def save_new_skill(text: str, *, available_tools: set[str]) -> Skill:
    """Persist a user-approved skill. Existing skills are never overwritten."""
    ensure_default_skills()
    skill = parse_skill_text(text)
    validate_skill_tools(skill, available_tools)
    ensure_category_registered(skill.category)
    existing = load_skills()
    if skill.name in existing:
        raise FileExistsError(f"Skill already exists: {skill.name}. Existing skills are never overwritten.")
    path = SKILLS_DIR / f"{skill.name}.md"
    if path.exists():
        raise FileExistsError(f"Skill file already exists: {path.name}.")
    normalized = str(text or "").strip() + "\n"
    path.write_text(normalized, encoding="utf-8")
    _clear_skill_deleted(skill.name)
    return parse_skill_text(normalized, path=path)

def is_starter_skill(name: str) -> bool:
    return str(name or "").strip().lower() in STARTER_SKILL_NAMES


def read_skill_text(name: str) -> tuple[Skill, str]:
    skill = get_skill(name)
    if skill is None:
        raise FileNotFoundError(f"Unknown skill: {name}")
    resolved = skill.path.resolve()
    skills_root = SKILLS_DIR.resolve()
    if resolved.parent != skills_root:
        raise ValueError("Skill path is outside the BrowserOS skills directory.")
    return skill, skill.path.read_text(encoding="utf-8")


def _drop_skill_index_record(name: str) -> None:
    try:
        with _INDEX_LOCK:
            index = _load_index()
            records = index.get("skills")
            if isinstance(records, dict) and records.pop(str(name or "").strip().lower(), None) is not None:
                _save_index(index)
    except Exception:
        pass


def update_existing_skill(name: str, text: str, *, available_tools: set[str]) -> Skill:
    """Update exactly one existing skill. Changing the YAML skill id is never implicit."""
    ensure_default_skills()
    existing = get_skill(name)
    if existing is None:
        raise FileNotFoundError(f"Unknown skill: {name}")
    parsed = parse_skill_text(text)
    if parsed.name != existing.name:
        raise ValueError(
            f"This editor is updating '{existing.name}', but the draft declares '{parsed.name}'. "
            "Use Save as New/Duplicate when changing a skill name."
        )
    validate_skill_tools(parsed, available_tools)
    ensure_category_registered(parsed.category)
    resolved = existing.path.resolve()
    skills_root = SKILLS_DIR.resolve()
    if resolved.parent != skills_root:
        raise ValueError("Skill path is outside the BrowserOS skills directory.")
    normalized = str(text or "").strip() + "\n"
    temp = existing.path.with_suffix(existing.path.suffix + ".tmp")
    temp.write_text(normalized, encoding="utf-8")
    temp.replace(existing.path)
    _drop_skill_index_record(existing.name)
    return parse_skill_text(normalized, path=existing.path)


def delete_skill(name: str) -> Skill:
    """Delete any installed skill, including bundled starter skills.

    A small tombstone in Tiny Web Agent's existing data directory prevents bundled
    defaults from silently reappearing after restart. No other user data is changed.
    """
    ensure_default_skills()
    existing = get_skill(name)
    if existing is None:
        raise FileNotFoundError(f"Unknown skill: {name}")
    resolved = existing.path.resolve()
    skills_root = SKILLS_DIR.resolve()
    if resolved.parent != skills_root:
        raise ValueError("Skill path is outside the BrowserOS skills directory.")
    existing.path.unlink()
    _mark_skill_deleted(existing.name)
    _drop_skill_index_record(existing.name)
    return existing

