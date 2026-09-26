# Browser-OS v9 — Outlook Calendar

Agenda is now a full Outlook-backed calendar with **Agenda, Week, Month, and Year** views. It reuses Tiny Web Agent's persistent Playwright Outlook profile; no Entra/Graph client ID is required. Outlook events are cached for five minutes; **Refresh** forces a new scrape. The Year view intentionally shows compact event-count badges rather than full titles.

# Browser-OS + Tiny Web Agent

This build merges the supplied Tiny Web Agent Interface into Browser-OS. Tiny Web Agent remains a Python/Flask + llama-cpp-python service, but Browser-OS supervises it and presents it as a normal Browser-OS tool window.

## First run

1. Run `npm install`.
2. If your current Python environment already has the Tiny Web Agent dependencies, no extra step is needed. Otherwise run `setup-agent.bat`.
3. Run `npm start` (or `start-browser-os.bat`).
4. Open `http://127.0.0.1:8001`.
5. Launch **Tiny Web Agent** from the desktop, menu, command palette, or Terminal command `ai`.

Opening the AI window starts the local Flask service on port 7860. It does **not** load a GGUF model by itself. Model loading remains under Tiny Web Agent's existing logic/settings.


## Local-only networking

This build intentionally binds BrowserOS to `127.0.0.1:8001` and launches Tiny Web Agent on `127.0.0.1:7860`. The shared `--host` / LAN-exposure changes have been removed. BrowserOS is intended to be used on the same computer as the local model.

Tiny Web Agent also checks `chat.db` at startup. If SQLite reports that the database is malformed, the damaged file is preserved as a timestamped `.malformed-...bak` and a fresh database is created so the UI can start.

## Python selection

Browser-OS tries `TINY_AGENT_PYTHON`, then `PYTHON`, then `python`/`py` on Windows. If your CUDA-enabled llama-cpp-python lives in a specific Python installation, launch Browser-OS with for example:

```powershell
$env:TINY_AGENT_PYTHON = "C:\Path\To\python.exe"
npm start
```

## Privacy

Tiny Web Agent is stored under `private/tiny-web-agent`. Browser-OS explicitly blocks `/private` from HTTP static serving. This protects `data/chat.db`, attachments, Python source, and the supplied `outlook_profile`.

## Agent service endpoints

- `GET /api/agent/status`
- `POST /api/agent/start`
- `POST /api/agent/stop`

# Browser-OS local dashboard

This build keeps the original Browser-OS window-manager styling/assets and layers useful local dashboard tools on top.

## Start

```powershell
npm install
npm start
```

Open `http://127.0.0.1:8001` and set it as your browser home page if desired.

## Included tools

- Original Browser-OS Terminal and WinBox-based window manager
- System monitor: CPU, per-core load, RAM, GPU, VRAM, temperatures, battery, uptime
- Processes, network traffic, disk-space and local-service panels
- Clipboard history (captured on demand because browsers require clipboard permission)
- Persistent quick notes, todo list, bookmarks and timers/alarms
- Search launcher and Ctrl+Space command palette
- Allowlisted native Windows application launcher
- Expanded RSS reader with multiple feeds and read/unread state
- Weather via Open-Meteo
- Optional Outlook agenda via Microsoft Graph

## Native app launcher

Edit `config/apps.json`. Only entries in this file can be launched. Browser-OS does **not** expose an arbitrary shell-command API.

Example:

```json
{"id":"powershell","name":"PowerShell","command":"powershell.exe","args":[]}
```

## Local service monitor

Edit `config/services.json` and add the localhost/LAN TCP services you want Browser-OS to watch.

## Outlook agenda

Outlook is optional. Register a **public client/native application** in Microsoft Entra, enable public client/device-code flows, and grant delegated `Calendars.Read` plus `User.Read`. Put the Application (client) ID in:

`config/outlook.json`

```json
{
  "clientId": "YOUR-APPLICATION-CLIENT-ID",
  "tenant": "common"
}
```

Restart Browser-OS, open **Menu → Agenda**, then click **Connect**. Browser-OS stores the MSAL token cache locally in `data/msal-cache.json`.

No client secret belongs in this project.

## Keyboard shortcuts

- `Ctrl+Alt+T` — new Terminal
- `Ctrl+Space` — command palette
- `Ctrl+Tab` — original Browser-OS window cycling

## Terminal additions

Useful dashboard commands include `system`, `news`, `weather`, `agenda`, `processes`, `network`, `disks`, `services`, `launch`, `notes`, `todo`, `clipboard`, `bookmarks`, `timer`, and `palette`.

## Background settings

Open **Menu → Background** (or right-click the desktop → Tools → Background). Browser-OS supports preset gradients, custom two-colour gradients, flat colours, local image files, and image URLs. Local image wallpapers are stored in IndexedDB so they persist without placing large image data in localStorage. The Terminal command `background` opens the same settings window; `background https://...` sets an image URL directly.

## Riftbreakers VTT integration

The supplied Riftbreakers 2e VTT is bundled unchanged at `apps/riftbreakers-vtt.html` and opens inside a Browser-OS `ApplicationWindow`.

Launch it from:
- the Riftbreakers VTT desktop icon (automatically added once to existing layouts),
- Menu → Riftbreakers VTT,
- desktop right-click → Tools → Riftbreakers VTT,
- the command palette,
- Terminal: `riftbreakers` or `vtt`.

The VTT remains a standalone same-origin HTML app, so its existing campaign/session autosave and browser storage continue to work.

## Split Ministral contexts

Browser-OS now gives the same loaded Ministral model two deliberately separate contexts:

- **Chat context** — the normal Tiny Web Agent window. It keeps its existing conversation history, settings, and normal Tiny Web Agent tools.
- **OS context** — a short-lived Browser-OS control context. It does not reuse chat history and cannot see the general chat/web/file/PowerShell/Outlook tools.

The OS context currently exposes only six focused functions: window control, system stats, scratchpad notes, todo creation, timers, and allow-listed native app launching.

Use it from Terminal:

```text
os open weather and start a 20m timer
os add buy batteries to my todo list
os show me system usage
```

Or press **Ctrl+Space** and type a natural-language Browser-OS instruction. Exact launcher names still open directly; other entered text is sent to the OS context.

The Python service is still started lazily and both contexts share the same single llama.cpp model instance; the OS context does not load a second copy of the GGUF.


## OS agent tool detail display

The OS context now streams structured execution events to the Browser-OS Terminal and OS Agent window. During an `os` command, the UI shows model/thinking status, each selected OS tool, its arguments, its returned result, and execution time before the final short OS response. The normal Tiny Web Agent chat remains separate.

## v5 changes
- Browser-OS OS-agent replies now stream token-by-token in the Terminal and OS Agent window. Tool events remain visible inline during multi-step requests.
- Chrome bookmarks are displayed as collapsible nested folders using the folder paths stored in Chrome's Bookmarks file. Chrome sync remains read-only.


## v7.2 clear behavior

`clear` now clears the Terminal immediately, cancels any active OS generation, and resets llama.cpp's active KV/context cache. It does not modify or delete Tiny Web Agent chat conversations. The Browser-OS OS agent already starts each command with an empty message state, so this reset is primarily a hard model-cache reset.


## v8 — YAML tools + create_tool hot-plugging

Browser-OS OS-agent tool definitions now live under `private/tiny-web-agent/os_tools/definitions/*.yaml`. Primitive execution handlers remain trusted Python functions, but the model-facing names, descriptions, parameters, enums, and argument documentation are YAML-defined.

The OS agent also has `create_tool`, which accepts a YAML `type: workflow` definition. Valid workflows are persisted to `private/tiny-web-agent/os_tools/generated/<name>.yaml` and inserted into the live OS tool registry immediately. The new tool is therefore available on the next inference pass—even later in the same `os` request—without restarting Browser-OS, Flask, or the model. Generated workflows may compose existing Browser-OS tools but cannot add arbitrary Python, JavaScript, PowerShell, shell handlers, or replace built-in primitive names.

Example request: `os create a tool called morning_setup that opens Weather and Agenda, then run it.`

Equivalent generated YAML:

```yaml
name: morning_setup
type: workflow
description: Open Weather and Agenda.
parameters: {}
steps:
  - tool: browser_window
    arguments: {action: open, target: weather}
  - tool: browser_window
    arguments: {action: open, target: agenda}
```

Workflow arguments can be referenced with `{{args.name}}`; prior step results can be referenced with `{{steps.0.result}}`. Generated tools are reloaded automatically on the next Tiny Web Agent startup.


## Outlook Calendar (ICS feed)

BrowserOS now reads Outlook through the published calendar ICS feed instead of scraping Outlook Web with Playwright.

- Calendar refreshes fetch the same published `.ics` URL repeatedly; no repeated download or sign-in is required.
- The feed URL is kept in server-side local configuration and is not returned to Tiny Web Agent.
- On first launch the bundled calendar config is copied to `%LOCALAPPDATA%\BrowserOS\outlook.json`, so later BrowserOS replacements keep the calendar source.
- **Refresh** forces an immediate feed fetch. BrowserOS otherwise keeps a short two-minute in-memory cache.
- The last successful in-memory snapshot is retained if a temporary network refresh fails.
- Recurring daily/weekly/monthly/yearly events and common EXDATE/RECURRENCE-ID overrides are expanded locally.

Published ICS feeds are read-only. **+ New event** therefore opens a pre-filled Outlook Web event in the user's normal default browser, reusing that browser's existing Microsoft login. The user reviews the event and clicks **Save** in Outlook. Existing imported events open as read-only details in BrowserOS with an **Open Outlook Web** button for edits/deletes.

Normal calendar reading no longer launches Chromium or relies on Outlook DOM selectors. The legacy Playwright bridge remains in the project only for compatibility with older code paths; it is not used by Calendar refreshes.


## v9.3 Research citation behavior
Research answers no longer require inline [n] citations or a Sources section. Citations are optional and should only be used when they materially aid verification, clarify conflicting evidence, or the user explicitly asks for sources.


## v9.5 Windows application launcher

The Browser-OS Applications window now discovers installed Windows Start apps dynamically with `Get-StartApps`, while preserving explicit entries from `config/apps.json`. The launcher supports live text filtering, Enter-to-launch for the top match, click-to-launch, and a refresh button that rebuilds the Windows app cache. Discovered Start apps are launched through `explorer.exe shell:AppsFolder\<AppID>`. The backend exposes structured app metadata (`name`, `id`, `source`) so a future agent-side similarity/semantic matcher can reuse the same catalog without scraping the UI.


## Persistent terminal website aliases

Browser-OS terminal aliases are stored in `config/terminal-shortcuts.json`. Examples:

```text
alias yt,y https://youtube.com
alias fb,f https://facebook.com
alias gh https://github.com
aliases
unalias gh
unalias yt,y
```

Typing a saved alias by itself opens its website in a new browser tab. Built-in terminal command names are reserved and cannot be overwritten. The default config includes `yt`, `y`, `fb`, and `f`.

## v9.7 — Collapsible terminal traces

OS-agent tool calls, tool results, and Research source/evidence metadata are rendered as native collapsible terminal sections. They default to collapsed and can be individually expanded with the disclosure arrow. The Terminal also adds **Expand all** and **Collapse all** controls once trace output appears. Final OS/Research responses remain visible normally.


## v9.8 right dock

Browser-OS now includes a persistent, resizable right-side workspace dock. Terminal and System Monitor can live as interactive dock panels, be resized vertically, pinned in the saved layout, removed, or detached back into normal WinBox windows. Normal Terminal/System windows also include a dock control. Dock width, visibility, panel proportions, and pin state persist in localStorage.

## v9.9 responsive shell

Browser-OS now adapts across desktop, narrow laptop/tablet, and phone-sized viewports. Open WinBox windows are resized and clamped back inside the usable viewport when the browser is resized or rotated. Below 900 px the right workspace dock becomes an overlay drawer instead of consuming desktop width; below 700 px regular windows become full-width application panels beneath the top menu. Built-in tools use responsive internal layouts while Terminal keeps a readable 13 px font on small screens.


## Tiny Ecosystem (v9.10.14)
- Open from Menu → Ecosystem, terminal `ecosystem`, or the command palette.
- Add it to the right dock with the `E` dock button; detached Ecosystem windows can dock back with the title-bar dock control.
- Interactive canvas simulation: grass, herbivores, predators, energy, aging, reproduction, hunting, starvation, and population history.
- Hover controls paint grass, spawn creatures, erase, pause, reset, and change simulation speed. Click a creature to inspect it; double-click to mark/unmark follow mode; right-click erases.
- The animation pauses automatically when hidden/off-screen or when the document is backgrounded.

## Tiny Tamagotchi (v9.10.15)
- Open from Menu → Tamagotchi, terminal `tamagotchi` / `tama`, Command Palette, or dock with the ♥ button.
- Persistent pixel pet state is stored locally under `browser-os-tamagotchi-v1`.
- Hand-authored 16×16 canvas sprites: idle, happy, sad, sleeping, eating, playing, medicine.
- Needs: food, mood, energy, cleanliness and health.
- Actions: feed, play, clean, sleep/wake, medicine; click the pet to pet it; double-click its name to rename it.
- Real elapsed time is applied when the widget wakes/reopens, while rendering pauses when hidden.

## Tamagotchi collection (v9.10.16)
- Multiple persistent pets with independent age/needs/state.
- Pet selector plus sprite selector; `+` creates another creature and `-` removes the selected one.
- Six original 20x20 pixel creature families: Mossbit, Voltfin, Cinderhorn, Shellbyte, Noctwing, Ironpup.
- Existing v1 Tamagotchi state migrates automatically to the new collection format.
- Larger status labels, percentage readouts, and thicker bars.
- `?` shows the real-time need decay/recovery rates.


## Defined pixel sprites (v9.10.17)
- Redrew all six Tamagotchi species directly in Canvas code on a 28×28 logical pixel grid.
- Clearer silhouettes with distinct heads, limbs, tails/wings, horns/armor, eyes, and internal shading.
- No generated/external image assets; sprites remain crisp Canvas-rendered pixel art.


## Reference-sheet sprites (v9.10.18)

- Replaced the six hand-built Tamagotchi silhouettes with 18x18 canvas bitmaps traced from the user-provided reference sprite sheet.
- The silhouettes remain in JavaScript; no external sprite image assets are shipped.
- Palettes are lightly recolored for Browser-OS while retaining the sharper anatomy and proportions of the references.
- Existing pet collection, persistence, needs, actions, docking and status UI are unchanged.


## Unique pet play animations (v9.10.19)
Each Tamagotchi species now has a visible, species-specific canvas animation when Play is pressed: Mossbit pounces with pixel stars; Voltfin jitters with lightning; Cinderhorn performs short charges with dust; Shellbyte rolls/spins with glints; Noctwing swoops with flight streaks; Ironpup runs zoomies with bounding hops and dust. Play animation lasts about 2.8 seconds. The existing sprite bitmaps remain embedded in JavaScript; no external/generated image assets are used.


## Tamagotchi care animations
Feed now animates food approaching the creature and being eaten in several bites with crumbs/chewing motion. Medicine shows a capsule entering the scene, a brief pet reaction, and healing-cross sparkles. Clean now has a visible sponge sweep, soap bubbles, sparkle pixels, and a small pet shake. These are all rendered directly in the Tamagotchi canvas; no generated or external sprite image assets are used.


## v9.10.22 performance fixes
- Ecosystem render loop capped at ~20 FPS and sleeps when off-screen/hidden.
- Tamagotchi renders ~8 FPS idle / ~30 FPS during animations and sleeps when off-screen/hidden.
- System monitor background polling reduced to 5s (15s when tab hidden).
- Window-state persistence reduced from every 1s to every 5s plus beforeunload save.
- Default crystal blur reduced from 18px to 7px.
- Menu → Performance mode persistently disables backdrop blur while preserving transparency; it defaults ON in this performance build and can be turned OFF.


## v9.10.23 Window appearance editor
- Menu → Window appearance or terminal `appearance`.
- Live persistent controls for WinBox tint, body/header/control/terminal opacity, blur, saturation, border strength, corner radius, and shadow.
- Presets: Crystal, Smoke, Ice, Violet, Amber, Phosphor, Flat.
- Performance mode can be toggled from the same panel and overrides backdrop blur while preserving transparency.

## v9.10.24 — Categorized top menu
The main Browser-OS menu is now grouped into compact nested categories: Apps, System, Web & information, Productivity, AI & research, Personalize, and Windows. Desktop hover/focus opens fly-out submenus; narrow/mobile layouts use expandable inline groups. Existing actions and shortcuts are unchanged.


## v9.10.25 — Top-right Right Dock button
A compact button is now pinned to the far-right edge of the top bar. It toggles the Right Dock directly and reflects the dock's visible/hidden state.


## v9.10.26 — Timers & Reminders
Timers are now merged with persistent future reminders. Countdown timers accept s/m/h/d durations; reminders accept a local date/time. A Browser-OS-wide alarm service checks them even when the Timers & Reminders window is closed, marks triggered items, shows an in-app toast/desktop notification, and plays an audible multi-tone alert when browser audio is available.


## v9.10.27 — Agent mode + URL/project tools
- Terminal `os` now toggles an OS Agent mode. While enabled, normal terminal lines are sent to the Browser-OS agent; `/exit` or `os off` returns to the shell. A small recent-turn buffer enables follow-up conversation without restoring the old large persistent OS context.
- The OS agent can read explicit public URLs with `browser_read_url`; GitHub repository roots preferentially resolve to their raw README. Public web research remains available for source discovery.
- Explicit install/integration/project-edit requests expose project-scoped developer tools: list/read files, exact replace, create/overwrite with automatic backups, syntax check, and restricted npm install/uninstall. These tools cannot address files outside the Browser-OS project.
- Timer/reminder alarms now repeat every ~2.2 seconds until the visible Dismiss alarm button is pressed; desktop notifications request interaction when supported.


## Local voice commands (faster-whisper)

The terminal microphone button records a short clip in the browser and transcribes it locally with Faster-Whisper. The default model folder is `models\faster-whisper-small.en`. Override it with the `BROWSER_OS_WHISPER_MODEL` environment variable. The Python environment used by Browser-OS must have `faster-whisper` installed (`python -m pip install faster-whisper`). Click the microphone dot once to record and again to stop; the transcription is inserted into the command line for review before pressing Enter.
## Persistent Outlook session

BrowserOS stores the Playwright Outlook profile outside the application folder at `%LOCALAPPDATA%\BrowserOS\outlook_profile`. This lets Outlook authentication survive BrowserOS refreshes, restarts, patches, and replacement of the project folder. On first calendar use, an older project-local `private\tiny-web-agent\outlook_profile` is copied into the persistent location if the new profile is empty. The legacy profile is preserved.


## Calendar sync-state fix

- Outlook connection state is now separate from refresh/sync state.
- A successful sync shows Connected instead of reverting the button to Sign in.
- Cached events render immediately when available; automatic full refreshes are less aggressive.
- The interactive login helper returns to the Outlook calendar after Microsoft authentication if login lands on a generic Microsoft page.


## Scheduled Tasks
BrowserOS includes structured Scheduled Tasks for one-time or recurring reminders, application launches, calendar checks, and optional AI-assisted tasks. See `SCHEDULED_TASKS_GUIDE.md`.


## Tool Editor

BrowserOS includes a dedicated **Tool Editor** for user-created Python tools. The editor builds the YAML tool definition from structured fields, validates the Python function and JSON Schema together, writes the implementation under `private/tiny-web-agent/tools/external/`, writes the canonical definition under `private/tiny-web-agent/tools/external/definitions/<name>.yaml`, and hot-reloads the live tool registry only after validation succeeds. External tools become available to Skills, Scheduled Tasks, and Tiny Web Agent without restarting BrowserOS. Open it from the menu, command palette, desktop-icon manager, or the terminal command `tooleditor`.
