from __future__ import annotations

from email.utils import parsedate_to_datetime
from html import unescape
import re
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

RSS_URL = "https://www.cbc.ca/webfeed/rss/rss-topstories"
_USER_AGENT = "TinyWebAgent/1.0 (+local RSS reader)"
_TAG_RE = re.compile(r"<[^>]+>")


def _clean_text(value: str | None) -> str:
    if not value:
        return ""
    text = unescape(value)
    text = _TAG_RE.sub(" ", text)
    return " ".join(text.split())


def _format_date(value: str | None) -> str:
    text = _clean_text(value)
    if not text:
        return ""
    try:
        dt = parsedate_to_datetime(text)
        return dt.isoformat()
    except Exception:
        return text


def cbc_top_stories(limit: int = 10) -> str:
    """Return the latest headlines from CBC News' official Top Stories RSS feed."""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 10
    limit = max(10, min(25, limit))

    request = Request(
        RSS_URL,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        },
    )

    try:
        with urlopen(request, timeout=15) as response:
            payload = response.read()
    except Exception as error:
        return f"CBC RSS fetch failed: {type(error).__name__}: {error}"

    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        return f"CBC RSS parse failed: {error}"

    items = root.findall("./channel/item")
    if not items:
        return "CBC RSS returned no stories."

    lines = ["CBC News — Top Stories"]

    for index, item in enumerate(items[:limit], start=1):
        title = _clean_text(item.findtext("title")) or "(Untitled)"
        link = _clean_text(item.findtext("link"))
        published = _format_date(item.findtext("pubDate"))
        description = _clean_text(item.findtext("description"))

        lines.append("")
        lines.append(f"{index}. {title}")
        if published:
            lines.append(f"Published: {published}")
        if description:
            lines.append(f"Summary: {description}")
        if link:
            lines.append(f"URL: {link}")

    return "\n".join(lines)
