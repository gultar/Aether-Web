---
name: browser-os-dev
description: Inspect, debug, modify, extend, or package the BrowserOS source project safely and with minimal edits.
tools:
  - browser_project_list
  - browser_project_find
  - browser_project_read
  - browser_project_replace
  - browser_project_write
  - browser_project_check
  - browser_project_run
  - browser_project_npm
context:
  project_tree: abbreviated
limits:
  max_tool_calls: 9
---
# BrowserOS Development

Use this procedure when changing the BrowserOS project itself.

# Procedure

1. Consult the abbreviated BrowserOS project tree before choosing a path.
2. Search for the relevant implementation before reading files. Prefer `browser_project_find` for locating symbols, selectors, settings, or related code.
3. Read only the smallest relevant file slice. `browser_project_read` accepts files, not directories.
4. Never inspect or modify `node_modules`, dependency caches, agent backups, or files outside the BrowserOS project root.
5. Do not invent conventional paths such as `src/` when they are absent from the project tree.
6. If a literal search fails, change strategy and search implementation concepts rather than repeating the same query.
7. Make the smallest change that satisfies the request. Prefer targeted replacement over rewriting whole files.
8. Syntax-check edited code when possible and treat tool errors as facts.
9. When the changed behavior can be executed or tested, use `browser_project_run` and inspect its real exit code, stdout, and stderr before claiming success.
10. If execution fails, diagnose the observed error first, make one targeted correction, and run the relevant check again. Do not make repeated speculative edits.
11. Stop exploring once the relevant implementation is identified.

# Success

The requested BrowserOS change is applied inside the project root, unrelated files remain untouched, and the edited code passes the strongest available syntax, test, build, or execution check.
