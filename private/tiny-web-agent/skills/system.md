---
name: system
description: Inspect or operate BrowserOS desktop functions such as windows, apps, system information, calendar, notes, todos, and timers.
tools:
  - browser_window
  - browser_launch_app
  - browser_system_info
  - browser_calendar
  - browser_note
  - browser_todo
  - browser_timer
---
# BrowserOS System Actions

Use the minimum BrowserOS action needed for the user's request.

# Calendar reliability

- For calendar list requests, use `period` for today/tomorrow/this week/next week instead of putting those words in `query`.
- If `browser_calendar` fails, the calendar state is unknown/unverified. Never infer that there are no events from a failed lookup.
- `browser_calendar` add uses the BrowserOS Outlook Companion to save a pre-filled Outlook Web event automatically when available. Claim creation only when the tool explicitly reports `Created and saved`; otherwise describe it as opened/unverified.

# Procedure

1. Do not open, change, create, launch, or write anything unless the user asked for that action.
2. Inspect real state with the appropriate tool instead of guessing.
3. For calendar edits/removals, list or identify the event first when its id is unknown.
4. Do not repeat a failed tool call unchanged.
5. Stop as soon as the requested state is confirmed by a successful tool result.

# Success

The requested BrowserOS/system action is confirmed by tool output and no unrelated state is changed.
