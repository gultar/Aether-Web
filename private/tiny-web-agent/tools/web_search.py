from __future__ import annotations

import math
import os
import sys
import threading
from typing import Iterable

# A PyInstaller one-file build bundles Playwright's Chromium next to the
# Playwright package inside the temporary extraction directory.
if getattr(sys, "frozen", False):
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = "0"

from ddgs import DDGS
from playwright.sync_api import sync_playwright


# Semantic retrieval settings. These can be overridden without editing code.
EMBEDDING_MODEL = os.environ.get(
    "TINY_AGENT_EMBEDDING_MODEL",
    "sentence-transformers/all-MiniLM-L6-v2",
)
SEMANTIC_CHUNK_WORDS = max(80, int(os.environ.get("TINY_AGENT_CHUNK_WORDS", "180")))
SEMANTIC_CHUNK_OVERLAP = max(0, int(os.environ.get("TINY_AGENT_CHUNK_OVERLAP", "30")))
SEMANTIC_CHUNKS_PER_PAGE = max(1, int(os.environ.get("TINY_AGENT_CHUNKS_PER_PAGE", "2")))
SEMANTIC_MAX_PAGE_CHARS = max(4000, int(os.environ.get("TINY_AGENT_MAX_PAGE_CHARS", "30000")))
SEMANTIC_BATCH_SIZE = max(1, int(os.environ.get("TINY_AGENT_EMBED_BATCH", "32")))

_embedding_model = None
_embedding_lock = threading.RLock()


def log(*args):
    print(*args)


def clean_text(input_text: str) -> str:
    # Keep text compact while preserving enough sentence structure for embeddings.
    return " ".join(str(input_text or "").split())


def _chunk_text(text: str, *, words_per_chunk: int = SEMANTIC_CHUNK_WORDS, overlap: int = SEMANTIC_CHUNK_OVERLAP) -> list[str]:
    """Split cleaned text into overlapping word chunks for semantic retrieval."""
    words = clean_text(text).split()
    if not words:
        return []

    words_per_chunk = max(20, int(words_per_chunk))
    overlap = max(0, min(int(overlap), words_per_chunk - 1))
    step = max(1, words_per_chunk - overlap)

    chunks: list[str] = []
    for start in range(0, len(words), step):
        chunk_words = words[start:start + words_per_chunk]
        if not chunk_words:
            break
        chunks.append(" ".join(chunk_words))
        if start + words_per_chunk >= len(words):
            break
    return chunks


def _get_embedding_model():
    """Lazily load the small CPU embedding model on first web search."""
    global _embedding_model
    if _embedding_model is not None:
        return _embedding_model

    with _embedding_lock:
        if _embedding_model is not None:
            return _embedding_model

        from fastembed import TextEmbedding

        log(f"Loading semantic retrieval model: {EMBEDDING_MODEL}")
        _embedding_model = TextEmbedding(model_name=EMBEDDING_MODEL)
        return _embedding_model


def _cosine_similarity(a: Iterable[float], b: Iterable[float]) -> float:
    """Cosine similarity without requiring an explicit NumPy dependency in this module."""
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for left, right in zip(a, b):
        left_f = float(left)
        right_f = float(right)
        dot += left_f * right_f
        norm_a += left_f * left_f
        norm_b += right_f * right_f
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    return dot / math.sqrt(norm_a * norm_b)


def _semantic_excerpts(query: str, page_text: str, *, top_k: int = SEMANTIC_CHUNKS_PER_PAGE) -> list[tuple[float, str]]:
    """Return the page chunks most semantically similar to the search query."""
    chunks = _chunk_text(page_text[:SEMANTIC_MAX_PAGE_CHARS])
    if not chunks:
        return []

    model = _get_embedding_model()

    # FastEmbed exposes retrieval-specific query/passage encoders. Use those when
    # available so the model can distinguish a search query from source passages.
    with _embedding_lock:
        if hasattr(model, "query_embed"):
            query_vector = next(model.query_embed([query]))
        else:
            query_vector = next(model.embed([query], batch_size=1))

        if hasattr(model, "passage_embed"):
            chunk_vectors = list(model.passage_embed(chunks, batch_size=SEMANTIC_BATCH_SIZE))
        else:
            chunk_vectors = list(model.embed(chunks, batch_size=SEMANTIC_BATCH_SIZE))

    ranked = [
        (_cosine_similarity(query_vector, vector), chunk)
        for chunk, vector in zip(chunks, chunk_vectors)
    ]
    ranked.sort(key=lambda item: item[0], reverse=True)
    return ranked[:max(1, min(top_k, len(ranked)))]


def _format_relevant_page_content(query: str, content: str) -> str:
    """Reduce a fetched page to semantically relevant excerpts for the LLM."""
    content = clean_text(content)
    if not content:
        return ""

    try:
        excerpts = _semantic_excerpts(query, content)
    except Exception as error:
        # Search must remain usable if the embedding model is unavailable or its
        # first-time download fails. Fall back to the old bounded raw-text behavior.
        log(f"Semantic retrieval unavailable; using raw fallback: {type(error).__name__}: {error}")
        return content[:4000]

    if not excerpts:
        return content[:4000]

    rendered = []
    for index, (score, excerpt) in enumerate(excerpts, start=1):
        rendered.append(
            f"Relevant excerpt {index} (semantic similarity {score:.3f}):\n{excerpt}"
        )
    return "\n\n".join(rendered)


def visit_url(url=""):
    text_content = ""
    content_limit_length = 2000
    truncated_content = ""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = None
        try:
            page = context.new_page()
            page.goto(url)

            # Extract the text content from the page
            content = page.inner_text("body")
            text_content = clean_text(content)
            truncated_content = text_content[:content_limit_length]
            log(f"Fetched content of URL {url}")
        except Exception as e:
            print(f"An error occurred while fetching the content from {url}: {e}")
        finally:
            if page is not None:
                page.close()
            context.close()
            browser.close()

    return truncated_content


def duckduckgo_search(query: str) -> str:
    ddgs = DDGS(timeout=10)

    results = DDGS().text(
        query,
        backend="brave,yahoo,google",
        max_results=10,
    )

    output = []

    for i, result in enumerate(results):
        title = result.get("title", "")
        body = result.get("body", "")
        href = result.get("href", "")

        content = ""

        # Fetch actual page content for the top 3 results, but send only the
        # semantically relevant chunks to the LLM instead of dumping page text.
        if i < 3 and href:
            try:
                extracted = ddgs.extract(
                    href,
                    fmt="text_plain",
                )

                raw_content = extracted.get("content", "")

                if isinstance(raw_content, bytes):
                    raw_content = raw_content.decode(
                        "utf-8",
                        errors="ignore",
                    )

                content = _format_relevant_page_content(query, str(raw_content))

            except Exception as e:
                content = f"[Page extraction failed: {e}]"

        result_text = (
            f"Title: {title}\n"
            f"URL: {href}\n"
            f"Snippet: {body}"
        )

        if content:
            result_text += (
                "\n\nRelevant page content:\n"
                f"{content}"
            )

        output.append(result_text)

    return "\n\n" + ("\n\n" + "=" * 60 + "\n\n").join(output)


# print(duckduckgo_search("Monster Hunter Sunbreak best longsword"))
