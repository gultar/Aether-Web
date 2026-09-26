"""Conversation-history compaction for Tiny Local Agent.

The compactor preserves the system message and original user messages, removes
old tool-call/tool-result chains, and replaces old final assistant answers with
short model-generated summaries. Recent turns are left untouched.
"""

from __future__ import annotations
import os
from dataclasses import dataclass
from typing import Any, Callable, Iterable


COMPACTED_PREFIX = "[Compressed summary of previous assistant response]\n"
TOOL_RESULT_PREFIX = "Tool result from "
MODEL_VERBOSE = os.environ.get("TINY_AGENT_VERBOSE", "0") == "1"

@dataclass
class CompactionResult:
    compacted: bool
    turns_compacted: int
    tool_chains_collapsed: int
    context_tokens_before: int
    estimated_tokens_after: int


def _content(message: dict[str, Any]) -> str:
    value = message.get("content", "")
    return value if isinstance(value, str) else str(value)


def _is_tool_result_message(message: dict[str, Any]) -> bool:
    return (
        message.get("role") == "user"
        and _content(message).lstrip().startswith(TOOL_RESULT_PREFIX)
    )


def _is_original_user_message(message: dict[str, Any]) -> bool:
    return message.get("role") == "user" and not _is_tool_result_message(message)


def _is_compacted_turn(turn: list[dict[str, Any]]) -> bool:
    if len(turn) != 2:
        return False

    return (
        turn[0].get("role") == "user"
        and turn[1].get("role") == "assistant"
        and _content(turn[1]).startswith(COMPACTED_PREFIX)
    )


def split_turns(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    """Split history into leading system messages and completed user turns.

    Internal tool-result messages use role="user" in this project, so only
    user messages that do *not* begin with "Tool result from " start a new
    conversational turn.
    """

    prefix: list[dict[str, Any]] = []
    turns: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []

    for message in messages:
        if not turns and not current and message.get("role") == "system":
            prefix.append(message.copy())
            continue

        if _is_original_user_message(message):
            if current:
                turns.append(current)
            current = [message.copy()]
        elif current:
            current.append(message.copy())
        else:
            # Preserve any unexpected pre-turn message rather than dropping it.
            prefix.append(message.copy())

    if current:
        turns.append(current)

    return prefix, turns


def estimate_message_tokens(llm: Any, messages: Iterable[dict[str, Any]]) -> int:
    """Cheap token estimate for a message list.

    The live llama.cpp context count is preferred for deciding *when* to
    compact. This function is used mainly to estimate the size of the rebuilt
    compacted history before the next real chat-completion call.
    """

    total = 0

    for message in messages:
        role = str(message.get("role", ""))
        content = _content(message)
        serialized = f"<{role}>\n{content}\n"

        try:
            total += len(
                llm.tokenize(
                    serialized.encode("utf-8"),
                    add_bos=False,
                )
            )
        except TypeError:
            # Compatibility with llama-cpp-python versions without add_bos.
            total += len(
                llm.tokenize(
                    serialized.encode("utf-8")
                )
            )

        # Small allowance for chat-template separators/special tokens.
        total += 4

    return total


def current_context_tokens(llm: Any, messages: list[dict[str, Any]]) -> int:
    """Return the best available count for the active conversation context."""

    try:
        count = int(llm.n_tokens)
    except (AttributeError, TypeError, ValueError):
        count = 0

    if count > 0:
        return count

    return estimate_message_tokens(llm, messages)


def _collapse_tool_chain(turn: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Remove internal tool plumbing while preserving the visible turn.

    A tool-using turn in this project can look like:

        user question
        assistant tool call
        user tool result
        assistant tool call
        user tool result
        assistant final answer

    Once the final answer exists, the raw tool chain is no longer needed for
    conversational continuity. We keep the original user message and the final
    assistant response verbatim.
    """

    if len(turn) <= 2 or not turn:
        return [message.copy() for message in turn], False

    assistant_indexes = [
        index
        for index, message in enumerate(turn)
        if message.get("role") == "assistant"
    ]

    if not assistant_indexes:
        return [message.copy() for message in turn], False

    final_assistant = turn[assistant_indexes[-1]].copy()

    collapsed = [
        turn[0].copy(),
        final_assistant,
    ]

    return collapsed, True


def _summary_source(turn: list[dict[str, Any]]) -> str:
    """Build a compact summarizer input without copying raw tool-result bodies."""

    if not turn:
        return ""

    original_user = _content(turn[0])

    assistant_messages = [
        _content(message)
        for message in turn
        if message.get("role") == "assistant"
    ]

    if not assistant_messages:
        return f"USER:\n{original_user}\n\nASSISTANT:\n[No assistant response]"

    final_answer = assistant_messages[-1]
    intermediate = assistant_messages[:-1]

    parts = [
        "USER:",
        original_user,
    ]

    if intermediate:
        parts.extend([
            "\nINTERMEDIATE TOOL CALLS / WORKING OUTPUT:",
            "\n".join(intermediate),
        ])

    parts.extend([
        "\nFINAL ASSISTANT RESPONSE:",
        final_answer,
    ])

    return "\n".join(parts)


def summarize_turn(
    llm: Any,
    turn: list[dict[str, Any]],
    *,
    max_summary_tokens: int = 180,
) -> str:
    """Summarize one old completed turn with a fresh model call.

    Raw tool-result messages are deliberately omitted from the summarizer input.
    The final assistant answer has already distilled those results, while
    retaining the raw pages/search dumps would make compaction itself expensive.
    """

    source = _summary_source(turn)

    response = llm.create_chat_completion(
        messages=[
            {
                "role": "system",
                "content": (
                    "You compact old conversation turns for long-term context. "
                    "Write a concise factual summary of the assistant's previous "
                    "response. Preserve details that could matter later: names, "
                    "numbers, dates, URLs, technical settings, user constraints, "
                    "decisions, conclusions, and unresolved questions. Remove "
                    "repetition, filler, formatting, and step-by-step exposition. "
                    "Do not add facts. Do not call tools. Do not address the user. "
                    "Output only the summary."
                ),
            },
            {
                "role": "user",
                "content": source,
            },
        ],
        temperature=0.05,
        max_tokens=max_summary_tokens,
        stream=False,
    )

    try:
        summary = response["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        summary = ""

    summary = summary.strip()

    # If summarization unexpectedly fails, retain a truncated form of the final
    # assistant answer instead of deleting the turn's substance.
    if not summary:
        assistant_messages = [
            _content(message)
            for message in turn
            if message.get("role") == "assistant"
        ]

        if assistant_messages:
            summary = assistant_messages[-1].strip()[:2000]
        else:
            summary = "No assistant response was recorded for this turn."

    return summary


def compact_conversation_if_needed(
    *,
    llm: Any,
    messages: list[dict[str, Any]],
    threshold_tokens: int = 3200,
    target_tokens: int = 2000,
    keep_recent_turns: int = 2,
    max_summary_tokens: int = 180,
    log_callback: Callable[[str], None] | None = None,
) -> CompactionResult:
    """Run hybrid cleanup after a completed assistant turn.

    Stage 1 always runs and requires no model inference:
      * Preserve system messages and every original user message.
      * Collapse completed tool-call/result chains to the original user
        message plus the final assistant answer.

    Stage 2 runs only when the sanitized conversation is still at or above
    ``threshold_tokens``:
      * Preserve the most recent ``keep_recent_turns`` turns verbatim.
      * Summarize older assistant answers until the rebuilt history approaches
        ``target_tokens``.
      * Already-compacted turns are never summarized again.

    This function is intended to be called only AFTER the final assistant
    answer for a user turn has been appended to ``messages``. It should never
    be called between tool calls in an active agent loop.
    """

    # ``llm.n_tokens`` still reflects the just-finished, uncompressed model
    # context. Keep it only as a useful before-value for reporting.
    before = current_context_tokens(llm, messages)

    prefix, turns = split_turns(messages)

    if not turns:
        estimated = estimate_message_tokens(llm, messages)
        return CompactionResult(
            compacted=False,
            turns_compacted=0,
            tool_chains_collapsed=0,
            context_tokens_before=before,
            estimated_tokens_after=estimated,
        )

    # -----------------------------------------------------------------
    # Stage 1: ALWAYS remove completed raw tool plumbing.
    # -----------------------------------------------------------------

    sanitized_turns: list[list[dict[str, Any]]] = []
    tool_chains_collapsed = 0

    for turn in turns:
        collapsed_turn, did_collapse = _collapse_tool_chain(turn)
        sanitized_turns.append(collapsed_turn)

        if did_collapse:
            tool_chains_collapsed += 1

    sanitized_messages: list[dict[str, Any]] = [
        message.copy()
        for message in prefix
    ]

    for turn in sanitized_turns:
        sanitized_messages.extend(message.copy() for message in turn)

    sanitized_estimate = estimate_message_tokens(llm, sanitized_messages)

    # Commit free tool-chain cleanup immediately, even if the conversation is
    # nowhere near the summarization threshold.
    if tool_chains_collapsed > 0:
        messages.clear()
        messages.extend(sanitized_messages)

        if log_callback is not None:
            log_callback(
                f"Conversation cleanup: removed {tool_chains_collapsed} "
                f"completed tool chain(s); estimated context "
                f"{sanitized_estimate:,} tokens."
            )

    # The threshold applies AFTER raw tool results have been removed. This
    # avoids paying for a summary call when deleting a web dump was enough.
    if sanitized_estimate < threshold_tokens:
        return CompactionResult(
            compacted=tool_chains_collapsed > 0,
            turns_compacted=0,
            tool_chains_collapsed=tool_chains_collapsed,
            context_tokens_before=before,
            estimated_tokens_after=sanitized_estimate,
        )

    if log_callback is not None:
        log_callback(
            f"Compacting conversation at {sanitized_estimate:,} tokens "
            f"after tool cleanup (threshold {threshold_tokens:,})..."
        )

    # -----------------------------------------------------------------
    # Stage 2: summarize only older assistant answers.
    # -----------------------------------------------------------------

    cutoff = max(0, len(sanitized_turns) - keep_recent_turns)
    old_turns = sanitized_turns[:cutoff]
    recent_turns = sanitized_turns[cutoff:]

    rebuilt: list[dict[str, Any]] = [message.copy() for message in prefix]
    turns_compacted = 0

    for index, turn in enumerate(old_turns):
        if not turn:
            continue

        if _is_compacted_turn(turn):
            rebuilt.extend(message.copy() for message in turn)
        elif not any(message.get("role") == "assistant" for message in turn):
            rebuilt.extend(message.copy() for message in turn)
        else:
            original_user = turn[0].copy()

            summary = summarize_turn(
                llm,
                turn,
                max_summary_tokens=max_summary_tokens,
            )

            rebuilt.append(original_user)
            rebuilt.append({
                "role": "assistant",
                "content": COMPACTED_PREFIX + summary,
            })

            turns_compacted += 1

        # Stop spending summary calls as soon as the projected final history
        # is small enough. Unprocessed turns remain verbatim in that projection.
        remaining_old = old_turns[index + 1:]
        projected = [message.copy() for message in rebuilt]

        for remaining_turn in remaining_old:
            projected.extend(message.copy() for message in remaining_turn)

        for recent_turn in recent_turns:
            projected.extend(message.copy() for message in recent_turn)

        if estimate_message_tokens(llm, projected) <= target_tokens:
            rebuilt = projected
            break

    else:
        for recent_turn in recent_turns:
            rebuilt.extend(message.copy() for message in recent_turn)

    # If there were no old turns to process, the threshold was reached entirely
    # by protected recent turns. Keep them intact rather than violating the
    # keep_recent_turns policy.
    if not old_turns:
        rebuilt = [message.copy() for message in prefix]
        for recent_turn in recent_turns:
            rebuilt.extend(message.copy() for message in recent_turn)

    estimated_after = estimate_message_tokens(llm, rebuilt)

    messages.clear()
    messages.extend(rebuilt)

    changed = (turns_compacted > 0 or tool_chains_collapsed > 0)

    if log_callback is not None:
        if turns_compacted > 0:
            log_callback(
                f"Compaction complete: {turns_compacted} turn(s) summarized; "
                f"estimated context {estimated_after:,} tokens "
                f"(target {target_tokens:,})."
            )
        elif estimated_after > target_tokens:
            log_callback(
                f"Compaction threshold reached, but only the protected "
                f"{keep_recent_turns} recent turn(s) remain eligible to keep "
                f"verbatim; estimated context is {estimated_after:,} tokens."
            )

    return CompactionResult(
        compacted=changed,
        turns_compacted=turns_compacted,
        tool_chains_collapsed=tool_chains_collapsed,
        context_tokens_before=before,
        estimated_tokens_after=estimated_after,
    )

