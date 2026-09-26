---

name: app-launcher
description: Launch a Windows application from BrowserOS as quickly as possible.
tools:
  - browser_launch_app

---

# Procedure

1. Identify the application the user wants to open.
2. Immediately call `browser_launch_app` with the application name.
3. Do not explain, plan, search, or perform any other action before launching.
4. Use only one tool call unless the launch fails.
5. If the application name is genuinely ambiguous, ask one short clarification question.

# Success

The task is complete when `browser_launch_app` reports that the requested application was launched successfully.

After success, reply briefly that the application was opened.
