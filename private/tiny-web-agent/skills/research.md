---
name: research
description: Perform in-depth multi-source web research, reading several webpages and synthesizing the evidence into a detailed answer.
tools:
  - duckduckgo_search
  - browser_read_url
limits:
  max_tool_calls: 10
---
# In-Depth Research

1. Search the question with `duckduckgo_search`.
2. Choose 3–5 strong, relevant sources.
3. Read each source with `browser_read_url`; keep each read focused (about 2500–4000 characters).
   Follow a useful in-page link only when it clearly leads to stronger or primary evidence.
4. After each source, retain only key facts, numbers, caveats, and the URL.
5. Search again only when an important gap remains.
6. Compare the sources, note meaningful disagreement, then synthesize one informed answer.

# Rules

- Prefer primary, recent, and independent sources.
- Do not invent facts, quotes, sources, or missing page content.
- Distinguish evidence from inference and state uncertainty when needed.

# Success

The answer is based on multiple consulted webpages and synthesizes their evidence rather than merely listing summaries.
