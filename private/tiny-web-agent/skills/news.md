---
name: news
description: Retrieve and present current news or headlines using live sources; use for latest headlines, news briefs, and current-events checks.
tools:
  - cbc_top_stories
  - duckduckgo_search
  - ars_technica_rss
limits:
  max_tool_calls: 3
---
# Current News

# Procedure

1. Retrieve live news before writing any current headline or current-event claim.
2. For a general headlines request, call `cbc_top_stories` first and request at least 10 results when the tool accepts a count.
3. Use `duckduckgo_search` only when the requested scope is not adequately covered by CBC or when a second source is genuinely useful.
4. Never substitute model memory, plausible events, or invented details for retrieved news.
5. Preserve headline meaning and clearly distinguish retrieved facts from any brief synthesis.
6. Make sure you always have 10 results, and not less.

# Success

The answer is based on live tool results, includes the requested number/scope of headlines when available, and contains no invented current events.
