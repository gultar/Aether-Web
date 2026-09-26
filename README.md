# Aether-Web

**Aether-Web** is an experimental Windows-first local desktop environment that runs in the browser and combines a customizable desktop shell, local AI agents, automation, system tools, lightweight applications, and personal productivity features in one interface.

It is designed primarily as a **local-first personal workspace** rather than a traditional operating system. The browser provides the desktop and application interface, while a local Node.js server and optional Python services handle system integration, AI inference, tools, scheduling, calendar access, voice transcription, and other native functionality.

> **Project status:** Experimental / alpha  
> **Primary platform:** Windows 11  
> **Networking:** Localhost by default  
> **AI:** Local GGUF models through `llama-cpp-python`

Aether-Web was built and tested as a personal project. It may require manual configuration on machines other than the development environment.

---

## What is Aether-Web?

Aether-Web gives you a desktop-like environment inside your browser with:

- movable application windows
- a desktop and application launcher
- a configurable dock
- system monitoring
- terminal commands
- local AI chat
- a separate AI-controlled system context
- tools and skills
- scheduled tasks
- reminders and timers
- local voice transcription
- Outlook calendar integration
- news and research tools
- notes and todos
- custom desktop applications
- persistent appearance and layout settings

The goal is to make a local LLM useful as part of the desktop itself rather than limiting it to a standalone chat window.

---

# Screens and applications

Aether-Web currently includes or integrates:

### Core desktop

- WinBox-based desktop windows
- draggable desktop icons
- multi-select desktop icons
- grid alignment
- configurable quick-launch dock
- auto-hiding bottom dock
- optional right-side workspace dock
- responsive layouts for smaller displays
- customizable window transparency, blur, tint, border, radius, and shadow
- persistent desktop/window layout
- configurable backgrounds
- command palette
- categorized application menu

### System tools

- CPU usage
- per-core CPU information
- RAM usage
- GPU / VRAM information when available
- disk information
- network information
- running processes
- uptime
- battery information where supported
- configurable local service monitoring
- installed Windows application discovery

### Productivity

- Notes
- Todos
- Timers
- Future reminders
- Bookmarks
- Clipboard tools
- Calendar
- Terminal aliases
- Scheduled Tasks

### Included applications

- **Tiny Web Agent**
- **Geomancy**
- **Riftbreakers VTT**
- **Tiny Ecosystem**
- **Tamagotchi**
- **System Monitor**
- **Terminal**
- **News**
- **Calendar / Agenda**
- **Tool Editor**
- **Skills Editor**
- **Collaboration Harness**

Some applications are self-contained HTML/JavaScript tools, while others communicate with the local backend or AI service.

---

# Local AI

Aether-Web integrates a local Python/Flask AI service called **Tiny Web Agent**.

The AI backend uses `llama-cpp-python` and is intended to run GGUF models locally.

No model is included in this repository.

You must provide your own compatible GGUF model.

## Two AI contexts

Aether-Web separates AI interaction into two contexts.

### Chat context

The normal Tiny Web Agent interface.

It can maintain conversations and use whichever tools are enabled by the selected Skill.

This is intended for:

- conversation
- coding
- web research
- translation
- structured tools
- custom workflows
- document-related tasks
- general assistant use

### OS context

A separate short-lived context used to operate Aether-Web itself.

It does not reuse the main chat history.

This helps keep system commands focused and reduces context pollution.

For example:

```text
os open weather and start a 20m timer
os add buy batteries to my todo list
os show me system usage
```

The two contexts can share the same loaded model. A second copy of the GGUF does not need to be loaded simply because both contexts exist.

---

# Skills

Tiny Web Agent supports **Skills**: Markdown files that describe how the model should perform particular types of tasks.

Skills live under:

```text
private/tiny-web-agent/skills/
```

Examples currently include:

```text
general
browse
research
code-builder
browser-os-dev
geomancy-reader
english-translator
french-translator
news
system
app-launcher
```

Aether-Web supports categorized skill routing.

Instead of exposing every Skill at once, the router can first select a category and then select a Skill within that category.

This is particularly useful with small local models because it reduces the number of instructions and tools presented during a task.

The **Skills Editor** can be used to create, modify, organize, and delete Skills and Skill categories.

---

# Tools

AI tools are defined separately from Skills.

Tool definitions are primarily YAML files, while executable handlers are implemented in Python.

Built-in OS tool definitions live under:

```text
private/tiny-web-agent/os_tools/definitions/
```

External tools live under:

```text
private/tiny-web-agent/tools/external/
```

and their definitions under:

```text
private/tiny-web-agent/tools/external/definitions/
```

---

## Tool Editor

Aether-Web includes a graphical **Tool Editor**.

It can:

- create a Python tool
- define its parameters
- generate its YAML definition
- validate the Python implementation
- validate the JSON Schema
- save both files
- reload the tool registry without restarting Aether-Web

Once loaded, external tools can be exposed to:

- Tiny Web Agent
- Skills
- Scheduled Tasks

Open the editor from the menu, command palette, desktop tools, or Terminal:

```text
tooleditor
```

---

# Dynamic OS workflows

The OS agent also supports YAML-defined workflows.

A workflow can combine existing trusted tools without introducing arbitrary shell or Python execution.

For example:

```yaml
name: morning_setup
type: workflow
description: Open Weather and Agenda.
parameters: {}
steps:
  - tool: browser_window
    arguments:
      action: open
      target: weather

  - tool: browser_window
    arguments:
      action: open
      target: agenda
```

Generated workflows are stored under:

```text
private/tiny-web-agent/os_tools/generated/
```

They can be loaded into the live tool registry without restarting the local model.

---

# Scheduled Tasks

Aether-Web contains a persistent task scheduler.

Tasks can be used for things such as:

- reminders
- recurring reminders
- application launches
- calendar checks
- scheduled prompts
- AI-assisted scheduled actions

Task history and task configuration are handled locally.

---

# Timers and reminders

Timers and future reminders share a common alarm system.

Supported examples include:

```text
20s
5m
2h
3d
```

Future reminders can also use a specific local date and time.

When an alarm fires, Aether-Web can:

- show an in-app alert
- display a desktop notification when allowed
- play an audible alert
- repeat the alarm until dismissed

---

# Local voice input

Aether-Web supports local speech-to-text using **Faster-Whisper**.

The Terminal microphone button records audio in the browser and sends it to a local Python worker.

The resulting transcription is inserted into the Terminal input so you can review it before submitting it.

The default model location is:

```text
models\faster-whisper-small.en
```

You can override it with:

```powershell
$env:BROWSER_OS_WHISPER_MODEL = "C:\path\to\your\faster-whisper-model"
```

Install Faster-Whisper in the Python environment used by Aether-Web:

```powershell
python -m pip install faster-whisper
```

Whisper models are **not included** in this repository.

---

# Outlook calendar

Aether-Web can display an Outlook calendar using a published `.ics` feed.

Calendar reads are performed locally by the backend.

The calendar supports:

- Agenda view
- Week view
- Month view
- Year view
- recurring events
- common recurrence exceptions
- manual refresh
- short in-memory caching

The ICS URL remains in local server-side configuration and is not intended to be exposed to the AI model.

Because published ICS feeds are read-only, event creation opens a pre-filled Outlook Web event in your normal browser.

Existing events can also be opened in Outlook Web for editing or deletion.

Legacy Outlook / Playwright integration remains in parts of the project for compatibility, but normal calendar refreshes use the ICS feed.

Do not commit your private ICS URL.

---

# Windows application launcher

Aether-Web can discover installed applications using Windows `Get-StartApps`.

Applications are launched through:

```text
explorer.exe shell:AppsFolder\<AppID>
```

Explicit applications can also be configured manually in:

```text
config/apps.json
```

Example:

```json
{
  "id": "powershell",
  "name": "PowerShell",
  "command": "powershell.exe",
  "args": []
}
```

The launcher provides:

- live filtering
- click-to-launch
- Enter-to-launch
- Windows Start app discovery
- manually configured applications
- refreshable application cache

---

# Terminal

The built-in Terminal provides both regular commands and access to the OS agent.

Common commands include:

```text
ai
os
system
news
agenda
processes
network
disks
services
launch
notes
todo
timer
background
appearance
ecosystem
tamagotchi
geomancy
riftbreakers
tooleditor
```

Run:

```text
help
```

for the commands available in your current build.

---

## OS Agent mode

Typing:

```text
os
```

toggles persistent OS Agent mode.

While enabled, normal Terminal text is treated as an AI instruction.

Exit with:

```text
/exit
```

or:

```text
os off
```

You can also issue a one-shot command:

```text
os open the system monitor
```

---

# Website aliases

Persistent website shortcuts are stored in:

```text
config/terminal-shortcuts.json
```

Examples:

```text
alias yt,y https://youtube.com
alias gh https://github.com
aliases
unalias gh
```

Typing the alias alone opens the associated website.

---

# Research

Tiny Web Agent includes browser and research tooling for tasks that need external information.

Research output can include source metadata and execution traces.

Tool calls and research traces displayed in the Terminal are collapsible.

The interface provides:

- per-section expand/collapse
- Expand all
- Collapse all

---

# Geomancy

Aether-Web includes a dedicated geomancy application.

It can generate and display a complete geomantic chart and integrate with Tiny Web Agent for interpretation.

The application is under:

```text
apps/geomancy/
```

Its AI Skill is:

```text
private/tiny-web-agent/skills/geomancy-reader.md
```

and its callable tool is:

```text
private/tiny-web-agent/tools/external/geomancy_cast.py
```

Geomancy can be opened from the desktop, menu, command palette, or Terminal.

---

# Riftbreakers VTT

Aether-Web includes a browser-based Riftbreakers virtual tabletop.

It runs as a same-origin HTML application and maintains its own browser-based session/campaign state.

Launch it using:

```text
riftbreakers
```

or:

```text
vtt
```

---

# Tiny Ecosystem

Tiny Ecosystem is a lightweight simulation featuring:

- grass
- herbivores
- predators
- energy
- aging
- reproduction
- hunting
- starvation
- population history

The simulation automatically reduces activity when hidden to reduce resource usage.

---

# Tamagotchi

Aether-Web includes a persistent pixel-pet system.

Current features include:

- multiple pets
- multiple species
- food
- mood
- energy
- cleanliness
- health
- sleeping
- feeding
- medicine
- cleaning
- playing
- persistent aging
- offline elapsed-time simulation
- species-specific play animations

Pet state is stored locally in the browser.

---

# Appearance

Aether-Web provides configurable window appearance.

Settings include:

- window tint
- body opacity
- header opacity
- control opacity
- terminal opacity
- backdrop blur
- saturation
- border strength
- corner radius
- shadow

Included presets currently include:

```text
Crystal
Smoke
Ice
Violet
Amber
Phosphor
Flat
```

A performance mode can disable expensive blur effects while retaining transparency.

Open the editor using:

```text
appearance
```

---

# Backgrounds

Background options include:

- flat colors
- gradients
- custom gradients
- local images
- image URLs

Local image wallpapers are stored in IndexedDB rather than localStorage.

Open background settings using:

```text
background
```

---

# Right Dock

Aether-Web includes an optional right-side workspace dock.

Compatible applications can run inside the dock instead of normal floating windows.

The dock supports:

- adjustable width
- vertically resizable panels
- persistent layout
- panel pinning
- detaching panels into windows
- restoring windows into the dock

On smaller displays, the dock changes into an overlay drawer.

---

# Requirements

Aether-Web is currently developed primarily for **Windows**.

You will generally need:

### Required

- Windows 10 or Windows 11
- Node.js
- npm
- Python
- a modern Chromium-based browser

### For local AI

- `llama-cpp-python`
- a compatible GGUF model
- Python packages listed in:

```text
private/tiny-web-agent/requirements_web.txt
```

### Optional

- NVIDIA GPU for CUDA-accelerated inference
- Faster-Whisper for voice input
- Outlook published ICS URL for calendar integration

Aether-Web does not include GGUF or Whisper model files.

---

# Installation

Clone the repository:

```powershell
git clone <YOUR-REPOSITORY-URL>
cd aether-web
```

Install Node dependencies:

```powershell
npm install
```

Install the Python agent dependencies:

```powershell
setup-agent.bat
```

Alternatively, install the Python requirements manually:

```powershell
python -m pip install -r private\tiny-web-agent\requirements_web.txt
```

Start Aether-Web:

```powershell
npm start
```

or:

```powershell
start-browser-os.bat
```

Then open:

```text
http://127.0.0.1:8001
```

---

# Selecting the Python executable

Aether-Web attempts to locate Python automatically.

The agent checks, in order:

1. `TINY_AGENT_PYTHON`
2. `PYTHON`
3. `python`
4. `py` on Windows

If your AI dependencies are installed in a specific Python environment, specify it before starting Aether-Web:

```powershell
$env:TINY_AGENT_PYTHON = "C:\Path\To\python.exe"
npm start
```

This is particularly useful when your CUDA-enabled `llama-cpp-python` installation belongs to a specific Python environment.

---

# Local networking

Aether-Web is intentionally local-first.

By default:

```text
Aether-Web:
127.0.0.1:8001

Tiny Web Agent:
127.0.0.1:7860
```

The project is not intended to expose the local agent directly to the network by default.

If you modify the binding configuration, understand the security implications before exposing AI tools or system controls to other devices.

---

# Privacy and local data

Most Aether-Web state is stored locally.

Depending on the feature, this may include:

- browser localStorage
- IndexedDB
- SQLite databases
- `%LOCALAPPDATA%`
- project-local configuration files

The Node.js server blocks the `/private` directory from normal static HTTP serving.

The following types of files should never be committed:

- conversation databases
- SQLite WAL / SHM files
- authentication tokens
- Outlook ICS URLs
- browser profiles
- API keys
- secrets
- local model files
- `.env` files
- Python caches
- logs
- generated runtime state

Review `.gitignore` before publishing changes.

---

# Project structure

A simplified overview:

```text
aether-web/
│
├── apps/
│   ├── collab-harness/
│   ├── geomancy/
│   └── riftbreakers-vtt.html
│
├── browser-extension/
│   └── outlook-companion/
│
├── config/
│   ├── apps.json
│   ├── outlook.json
│   ├── services.json
│   └── terminal-shortcuts.json
│
├── css/
│
├── images/
│
├── js/
│   ├── dashboard/
│   ├── storage/
│   ├── terminal/
│   └── window-manager/
│
├── private/
│   ├── calendar/
│   ├── cron/
│   ├── tiny-web-agent/
│   │   ├── os_tools/
│   │   ├── skills/
│   │   ├── static/
│   │   ├── templates/
│   │   └── tools/
│   └── voice/
│
├── scripts/
│
├── vendor/
│
├── index.html
├── server.js
├── package.json
├── start-browser-os.bat
└── setup-agent.bat
```

---

# Adding an application

Application-specific code should preferably remain isolated.

For example:

```text
apps/myapp/
    index.html
    myapp.css
    myapp.js
```

The Aether-Web window wrapper can then live under:

```text
js/dashboard/myapp.js
```

If the application uses AI, prefer giving it a dedicated Skill:

```text
private/tiny-web-agent/skills/myapp.md
```

If it needs programmatic data access, create a narrow external tool:

```text
private/tiny-web-agent/tools/external/my_tool.py
```

with its definition:

```text
private/tiny-web-agent/tools/external/definitions/my_tool.yaml
```

Keeping application logic isolated minimizes changes to the desktop core.

---

# Security model

Aether-Web has access to local system functionality, so the backend deliberately restricts several operations.

Examples include:

- native apps are launched through approved/discovered Windows application mechanisms
- project-editing tools are restricted to the Aether-Web project
- generated OS workflows can compose existing tools but cannot inject arbitrary Python or shell handlers
- the private backend directory is not exposed through normal static serving
- localhost is used by default
- model files and credentials are not bundled

This is still experimental software.

Review the source and configuration before giving the AI access to tools that can modify files or operate applications.

---

# Performance

Aether-Web contains several measures intended to reduce background load:

- slower system-monitor polling while hidden
- throttled Tamagotchi rendering
- throttled Ecosystem rendering
- reduced window-state persistence frequency
- optional blur disabling
- performance mode
- lazy AI service startup

Local model inference will still depend heavily on:

- model size
- GGUF quantization
- context size
- available RAM
- VRAM
- number of GPU-offloaded layers

---

# Compatibility

Aether-Web is currently **Windows-first**.

It contains Windows-specific functionality such as:

- PowerShell integration
- `Get-StartApps`
- `explorer.exe`
- `.bat` launchers
- Windows application discovery
- `%LOCALAPPDATA%`

Parts of the frontend may work on other operating systems, but full compatibility is not currently guaranteed.

---

# Known limitations

- This is experimental software.
- It has primarily been tested on a limited number of Windows machines.
- No automated cross-platform compatibility guarantee exists.
- Local LLM setup may require manual configuration.
- CUDA support depends on the user's Python and `llama-cpp-python` installation.
- Outlook ICS feeds are read-only.
- Some older internal code still uses the historical `BrowserOS` / `Browser-OS` name.
- Legacy integrations remain in the project for compatibility and may eventually be removed or refactored.
- Some applications rely on browser storage and are therefore tied to the browser profile used to run Aether-Web.

---

# Internal naming

The project was originally developed under the name **BrowserOS / Browser-OS**.

The public project name is now:

# **Aether-Web**

Some internal filenames, environment variables, storage keys, Python modules, CSS classes, and configuration paths still use the previous name.

These names are being left in place where changing them would provide little benefit or risk breaking compatibility.

They may be gradually refactored in future releases.

---

# Development status

Aether-Web is a personal experimental project that grew organically through frequent iteration.

It is being published because the architecture and feature set may be useful or interesting to others, not because it is considered production-ready software.

Bug reports, testing on different hardware, compatibility findings, and focused improvements are welcome.

---

# Contributing

If you want to contribute:

1. Fork the repository.
2. Create a branch for your change.
3. Keep changes focused.
4. Avoid committing generated runtime state or credentials.
5. Test the affected feature locally.
6. Submit a pull request describing what changed and how it was tested.

For major architectural changes, opening an issue first is recommended.

---

# Disclaimer

Aether-Web can interact with local files, applications, browser data, AI models, and operating-system features.

Use it at your own risk.

Review any tool definitions and configuration before enabling them, particularly tools that can modify files, execute processes, send messages, or interact with external services.

Aether-Web is not a security boundary or sandbox for untrusted models or untrusted tool definitions.

---

## Aether-Web

**A local browser desktop for AI, tools, automation, and experimentation.**