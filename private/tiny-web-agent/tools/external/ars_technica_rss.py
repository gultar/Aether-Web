
from __future__ import annotations

import html
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from typing import Any

FEED_URL = "https://feeds.arstechnica.com/arstechnica/index"
USER_AGENT = "BrowserOS-ArsRSS/1.0 (+local feed reader)"
MAX_FEED_BYTES = 5 * 1024 * 1024

ATOM_NS = "http://www.w3.org/2005/Atom"
CONTENT_NS = "http://purl.org/rss/1.0/modules/content/"


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self.parts.append(text)

    def text(self) -> str:
        return " ".join(self.parts)


def _clean_text(value: Any, max_chars: int = 500) -> str:
    raw = html.unescape(str(value or "")).strip()

    if not raw:
        return ""

    parser = _TextExtractor()

    try:
        parser.feed(raw)
        cleaned = parser.text()
    except Exception:
        cleaned = re.sub(r"<[^>]+>", " ", raw)

    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    if max_chars > 0 and len(cleaned) > max_chars:
        return cleaned[: max_chars - 1].rstrip() + "…"

    return cleaned


def _text(
    node: ET.Element | None,
    path: str,
    namespaces: dict[str, str] | None = None,
) -> str:
    if node is None:
        return ""

    child = node.find(path, namespaces or {})

    if child is not None and child.text:
        return child.text.strip()

    return ""


def _atom_link(entry: ET.Element) -> str:
    links = entry.findall(f"{{{ATOM_NS}}}link")

    for link in links:
        rel = (link.attrib.get("rel") or "alternate").strip().lower()
        href = (link.attrib.get("href") or "").strip()

        if href and rel == "alternate":
            return href

    for link in links:
        href = (link.attrib.get("href") or "").strip()

        if href:
            return href

    return ""


def _parse_atom(root: ET.Element, limit: int) -> list[dict[str, str]]:
    articles: list[dict[str, str]] = []

    for entry in root.findall(f"{{{ATOM_NS}}}entry")[:limit]:
        description = _text(entry, f"{{{ATOM_NS}}}summary")

        if not description:
            description = _text(entry, f"{{{ATOM_NS}}}content")

        articles.append({
            "title": _clean_text(
                _text(entry, f"{{{ATOM_NS}}}title"),
                300,
            ),
            "description": _clean_text(description, 500),
            "url": _atom_link(entry),
            "date": (
                _text(entry, f"{{{ATOM_NS}}}published")
                or _text(entry, f"{{{ATOM_NS}}}updated")
            ),
        })

    return articles


def _rss_item_link(item: ET.Element) -> str:
    link = _text(item, "link")

    if link:
        return link

    guid = _text(item, "guid")

    if guid.startswith(("http://", "https://")):
        return guid

    return ""


def _parse_rss(root: ET.Element, limit: int) -> list[dict[str, str]]:
    channel = root.find("channel")

    if channel is None:
        channel = root

    articles: list[dict[str, str]] = []

    for item in channel.findall("item")[:limit]:
        description = (
            _text(item, "description")
            or _text(item, f"{{{CONTENT_NS}}}encoded")
        )

        articles.append({
            "title": _clean_text(
                _text(item, "title"),
                300,
            ),
            "description": _clean_text(description, 500),
            "url": _rss_item_link(item),
            "date": _text(item, "pubDate"),
        })

    return articles


def _parse_feed(xml_bytes: bytes, limit: int) -> list[dict[str, str]]:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise RuntimeError(
            f"Ars Technica returned invalid XML: {exc}"
        ) from exc

    local_name = root.tag.rsplit("}", 1)[-1].lower()

    if local_name == "feed" or root.tag.startswith(f"{{{ATOM_NS}}}"):
        return _parse_atom(root, limit)

    if local_name in {"rss", "rdf"} or root.find("channel") is not None:
        return _parse_rss(root, limit)

    raise RuntimeError(
        f"Unsupported feed format: root element {root.tag!r}"
    )


def ars_technica_rss() -> dict[str, Any]:
    """
    Fetch the 10 latest Ars Technica technology / IT news articles.

    Returns only:
    - title
    - description
    - url
    - date
    """

    limit = 10

    request = urllib.request.Request(
        FEED_URL,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": (
                "application/atom+xml, "
                "application/rss+xml, "
                "application/xml, "
                "text/xml;q=0.9"
            ),
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(MAX_FEED_BYTES + 1)

    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Ars Technica feed request failed with HTTP {exc.code}"
        ) from exc

    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Unable to reach Ars Technica feed: {exc.reason}"
        ) from exc

    if len(data) > MAX_FEED_BYTES:
        raise RuntimeError(
            "Ars Technica feed exceeded the 5 MB safety limit"
        )

    articles = _parse_feed(data, limit)

    return {
        "articles": articles
    }
