---
name: browse
description: Quickly look up a simple current or external fact online without doing an in-depth investigation.
tools:
  - duckduckgo_search
  - browser_read_url
limits:
  max_tool_calls: 3
---
# Quick Web Lookup

1. Search once with `duckduckgo_search`.
2. Open at most one strong source with `browser_read_url` if the search result is not enough.
3. Answer directly and concisely.
4. Never invent current facts or page contents.

# Success

The question is answered with the minimum web work needed.
