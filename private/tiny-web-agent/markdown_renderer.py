from __future__ import annotations

import re

import mistune

# escape=True prevents raw HTML emitted by the model from becoming executable.
# hard_wrap=True preserves deliberate single newlines from model output instead
# of collapsing them inside paragraphs.
_markdown = mistune.create_markdown(
    escape=True,
    hard_wrap=True,
    plugins=["table", "strikethrough", "task_lists", "url"],
)


def _normalize_model_markdown(text: str) -> str:
    """Be slightly forgiving of common small-model Markdown mistakes."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")

    # Markdown requires a space after ATX heading markers. Small local models
    # occasionally emit `##Heading`; accept it as `## Heading`.
    text = re.sub(r"(?m)^(#{1,6})(?=[^#\s])", r"\1 ", text)

    return text


def render_markdown(text: str) -> str:
    if not text:
        return ""
    return _markdown(_normalize_model_markdown(text))
