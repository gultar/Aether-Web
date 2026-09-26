from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from urllib.parse import urlparse
from typing import Any

from ddgs import DDGS

from tools.web_search import clean_text, _semantic_excerpts

DEFAULT_SOURCE_COUNT = 4
MIN_SOURCES = 3
MAX_SOURCES = 5
SEARCH_CANDIDATES = 10
FETCH_CANDIDATES = 7
MAX_EVIDENCE_TOKENS = 2200
# Conservative character approximation for English/French prose. The final
# prompt is still measured by llama.cpp before inference in web_agent.
CHARS_PER_TOKEN = 3.7
MAX_EVIDENCE_CHARS = int(MAX_EVIDENCE_TOKENS * CHARS_PER_TOKEN)


@dataclass
class ResearchSource:
    index: int
    title: str
    url: str
    domain: str
    snippet: str
    date: str
    score: float
    evidence: str

    def public_dict(self) -> dict[str, Any]:
        item = asdict(self)
        item.pop("evidence", None)
        return item


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.removeprefix("www.")
    except Exception:
        return ""


def _normalize_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
    except Exception:
        return url


def _truncate_at_boundary(text: str, max_chars: int) -> str:
    text = clean_text(text)
    if len(text) <= max_chars:
        return text
    clipped = text[:max_chars]
    cut = max(clipped.rfind(". "), clipped.rfind("? "), clipped.rfind("! "), clipped.rfind("; "))
    if cut > max_chars * 0.55:
        clipped = clipped[: cut + 1]
    return clipped.rstrip() + "…"


def _extract_content(ddgs: DDGS, url: str) -> str:
    extracted = ddgs.extract(url, fmt="text_plain")
    raw = extracted.get("content", "") if isinstance(extracted, dict) else ""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="ignore")
    return clean_text(str(raw))


def build_evidence_pack(
    query: str,
    *,
    source_count: int = DEFAULT_SOURCE_COUNT,
    max_evidence_tokens: int = MAX_EVIDENCE_TOKENS,
) -> tuple[str, list[ResearchSource], dict[str, Any]]:
    """Search broadly, select 3–5 useful sources, and return a compact evidence pack."""
    query = clean_text(query)
    if not query:
        raise ValueError("Research query is required.")

    source_count = max(MIN_SOURCES, min(MAX_SOURCES, int(source_count or DEFAULT_SOURCE_COUNT)))
    max_chars = max(2400, int(max_evidence_tokens * CHARS_PER_TOKEN))
    ddgs = DDGS(timeout=12)
    raw_results = list(ddgs.text(
        query,
        backend="brave,yahoo,google",
        max_results=SEARCH_CANDIDATES,
    ) or [])

    # Deduplicate exact/near-identical result URLs before doing any expensive extraction.
    candidates: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for rank, result in enumerate(raw_results, start=1):
        url = str(result.get("href") or result.get("url") or "").strip()
        if not url:
            continue
        key = _normalize_url(url).lower()
        if key in seen_urls:
            continue
        seen_urls.add(key)
        candidates.append({
            "rank": rank,
            "title": clean_text(result.get("title", "")),
            "url": url,
            "domain": _domain(url),
            "snippet": clean_text(result.get("body") or result.get("snippet") or ""),
            "date": clean_text(result.get("date") or result.get("published") or ""),
        })

    if not candidates:
        raise RuntimeError("No web search results were found.")

    enriched: list[dict[str, Any]] = []
    for item in candidates[:FETCH_CANDIDATES]:
        content = ""
        semantic_score = 0.0
        excerpts: list[str] = []
        try:
            content = _extract_content(ddgs, item["url"])
            if content:
                ranked = _semantic_excerpts(query, content, top_k=2)
                if ranked:
                    semantic_score = float(ranked[0][0])
                    excerpts = [clean_text(chunk) for _score, chunk in ranked if clean_text(chunk)]
        except Exception:
            pass

        # A snippet is useful evidence when extraction fails, but extracted relevant
        # passages receive a large score advantage.
        evidence = " ".join(excerpts).strip() or item["snippet"]
        if not evidence:
            continue
        rank_score = 1.0 / max(1, item["rank"])
        item["evidence"] = evidence
        item["score"] = semantic_score * 0.82 + rank_score * 0.18
        enriched.append(item)

    # Fall back to snippets from untouched search results if fewer than three pages
    # could be extracted. This keeps research mode useful on hostile sites.
    if len(enriched) < MIN_SOURCES:
        used = {x["url"] for x in enriched}
        for item in candidates:
            if item["url"] in used or not item["snippet"]:
                continue
            fallback = dict(item)
            fallback["evidence"] = item["snippet"]
            fallback["score"] = (1.0 / max(1, item["rank"])) * 0.15
            enriched.append(fallback)
            if len(enriched) >= source_count:
                break

    enriched.sort(key=lambda x: x["score"], reverse=True)

    # Prefer distinct domains when scores are reasonably close, then fill remaining
    # slots with the strongest sources. This avoids four mirrors of the same story.
    selected: list[dict[str, Any]] = []
    used_domains: set[str] = set()
    for item in enriched:
        domain = item["domain"].lower()
        if domain and domain in used_domains:
            continue
        selected.append(item)
        if domain:
            used_domains.add(domain)
        if len(selected) >= source_count:
            break
    if len(selected) < source_count:
        selected_urls = {x["url"] for x in selected}
        for item in enriched:
            if item["url"] in selected_urls:
                continue
            selected.append(item)
            if len(selected) >= source_count:
                break

    if not selected:
        raise RuntimeError("Search results were found, but no usable evidence could be extracted.")

    # Divide the hard evidence budget across sources while reserving a small amount
    # for metadata labels. Better-ranked sources can naturally use the full quota.
    metadata_reserve = 180 * len(selected)
    evidence_budget = max(1200, max_chars - metadata_reserve)
    per_source = max(500, evidence_budget // len(selected))

    sources: list[ResearchSource] = []
    blocks: list[str] = []
    used_chars = 0
    for idx, item in enumerate(selected, start=1):
        remaining_sources = len(selected) - idx + 1
        remaining = max_chars - used_chars
        this_budget = min(per_source, max(420, remaining // remaining_sources - 120))
        evidence = _truncate_at_boundary(item["evidence"], this_budget)
        source = ResearchSource(
            index=idx,
            title=item["title"] or item["domain"] or item["url"],
            url=item["url"],
            domain=item["domain"],
            snippet=item["snippet"],
            date=item["date"],
            score=round(float(item["score"]), 4),
            evidence=evidence,
        )
        sources.append(source)
        date_part = f" | {source.date}" if source.date else ""
        block = (
            f"[{idx}] {source.title}\n"
            f"Source: {source.domain or source.url}{date_part}\n"
            f"URL: {source.url}\n"
            f"Evidence: {evidence}"
        )
        blocks.append(block)
        used_chars += len(block)

    pack = "\n\n".join(blocks)
    meta = {
        "candidate_results": len(candidates),
        "fetched_candidates": min(FETCH_CANDIDATES, len(candidates)),
        "sources_selected": len(sources),
        "evidence_chars": len(pack),
        "evidence_token_budget": int(max_evidence_tokens),
        "estimated_evidence_tokens": round(len(pack) / CHARS_PER_TOKEN),
    }
    return pack, sources, meta
