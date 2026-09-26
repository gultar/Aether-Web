# Tiny Local Web Agent

A lightweight local web chat frontend for the existing Tiny Local Agent tool system.

## What it adds

- Browser-based streaming chat UI
- Multiple saved conversations in `data/chat.db` (SQLite)
- GGUF model library and per-conversation model selection
- One llama.cpp model loaded at a time
- Existing Tiny Local Agent tools and tool loop
- Visible tool activity in the chat
- Per-conversation sampling settings
- Per-conversation model-load settings
- Conversation compaction without deleting the full visible chat history
- Prompt / generation timing displayed in the UI
- Stop-generation button

## Run

Your existing Tiny Local Agent dependencies are still used. The web UI adds Flask:

```powershell
pip install flask
python .\main.py
```

The app opens at:

```text
http://127.0.0.1:7860
```

If you do not want it to open a browser automatically:

```powershell
python .\main.py --no-browser
```

Verbose llama.cpp logging:

```powershell
python .\main.py --verbose
```

## Models

Open **Settings** and enter either:

- a full `.gguf` path, or
- a folder containing `.gguf` files.

A folder scan checks the files directly inside that folder; it does not recursively crawl a drive.

The app also automatically registers the old default Ministral path if it exists:

```text
C:\Models\Ministral-3-3B-Instruct-2512-Q5_K_M.gguf
```

Removing a model from the web UI only removes the database entry. It never deletes the GGUF file.

## Settings

Sampling settings apply on the next inference without reloading the model:

- temperature
- max output tokens
- top-p
- top-k
- repeat penalty

Load-time settings cause a reload when they differ from the currently loaded model configuration:

- context length
- GPU layers
- batch size
- micro-batch size
- CPU threads
- Flash Attention
- K/Q/V offload
- KV-cache precision

The default web-agent profile is:

- context length: 65,536
- GPU layers: -1 (all)
- CPU threads: 8
- Flash Attention: enabled
- temperature: 0.05
- max output tokens: 3,000
- maximum tool calls: 10
- compaction threshold / target: 3,500 / 2,500 tokens
- keep recent turns: 2
- compaction summary max: 180 tokens

Optional settings such as batch size, micro-batch size, K/Q/V offload override, top-p, top-k and repeat penalty default to **Auto**, meaning the web app does not pass them to `llama-cpp-python` unless you explicitly override them. KV-cache precision can also be selected in Settings.

Use the **Recommended defaults** button in Settings to reset an existing conversation to this profile.

## Conversations

The full user-visible conversation is stored in SQLite. The inference state is stored separately, so conversation compaction can shorten the context sent to the model without rewriting or deleting the messages you see in the UI.

## Tools

The web app reads `tools/tool_registry.py`, so the tools you already enable there are the tools exposed to the model. Tool execution is unchanged. The browser simply receives status events while the existing Python functions run.

## Portable build and Markdown

This version does not seed or auto-select any GGUF model. Fresh installs require the user to choose one in Settings (Browse… opens a native file picker on the host machine and registers the selected GGUF by absolute path without copying it).

Assistant messages are stored as raw Markdown and rendered safely in the UI after generation; saved messages render when reopened.

For a self-contained Windows executable, see `README_PORTABLE.md` and run `build_exe.bat`. The resulting EXE bundles Python/runtime dependencies and Playwright Chromium, but **does not bundle a GGUF model**.

## Adding tools to the interface

The web UI discovers tools from `tools/tool_registry.py`. You do not need to edit
`web_main.py`, `app.js`, or `index.html` for each new tool.

1. Create/import the Python callable.
2. Add one entry to `TOOL_REGISTRY` containing:
   - `function`: the callable
   - `label`: display name in Settings
   - `description`: short UI description
   - `enabled_by_default`: `True` or `False`
   - `schema`: the llama.cpp/OpenAI function-tool schema
3. Restart the app.

The tool will automatically appear under **Settings → Agent**. Each conversation
stores its own per-tool choices. The **Enable tools** switch remains the master
toggle. Disabled tools are omitted from the model's tool schemas and cannot be
executed by the web agent.

Example skeleton:

```python
from tools.calculator import calculator

TOOL_REGISTRY["calculator"] = {
    "function": calculator,
    "label": "Calculator",
    "description": "Perform mathematical calculations.",
    "enabled_by_default": True,
    "schema": {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Perform a mathematical calculation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string"},
                },
                "required": ["expression"],
            },
        },
    },
}
```

## Loadable external tools

The web UI can load additional Python tools without editing `tool_registry.py`.

1. Put a Python file in `tools/external/` beside the application. The file only needs a normal top-level function, for example:

```python
def calculator(expression: str) -> str:
    return str(eval(expression, {"__builtins__": {}}, {}))
```

2. Open **Settings → Agent → Add external tool** and click **Load template**.
3. Edit the JSON definition so `file` and `function` match the Python file, then click **Register definition**.
4. The tool appears immediately in the normal tool-toggle list. Enable it for the conversation and save settings.

Definitions are stored under `tools/external/definitions/`. **Reload tools** rescans JSON, YAML, and YML definition files, so you can also edit definitions manually.

External tools execute in a separate Python process. When running from source, the app uses the same Python interpreter. A packaged EXE looks for `python.exe` beside the application, `tool_runtime/python.exe`, or a Python installation on PATH. You can override the interpreter with `TINY_AGENT_TOOL_PYTHON`.

A simple definition looks like:

```json
{
  "name": "calculator",
  "file": "calculator.py",
  "function": "calculator",
  "label": "Calculator",
  "description": "Perform a mathematical calculation.",
  "enabled_by_default": false,
  "timeout_seconds": 30,
  "parameters": {
    "type": "object",
    "properties": {
      "expression": {
        "type": "string",
        "description": "Expression to calculate."
      }
    },
    "required": ["expression"]
  }
}
```

Registration validates the JSON, checks that the `.py` file exists, parses it for Python syntax, and verifies that the named top-level function exists. The file is not executed during registration.

## Presets

Use **Settings → Presets** to save the current model, system prompt, enabled tools, sampling/loading options, and compaction settings as a reusable preset. Choose a preset in the sidebar under **Start with preset**, then click **+ New chat**. Presets are snapshots: updating one later does not alter existing conversations.

## Editing a previous user message

Hover a persisted user message and click **Edit**. **Save & regenerate** creates a new conversation branch containing everything before that message, then sends the edited text as the new next turn. The original conversation remains unchanged. Copied assistant tool traces remain inspectable in the branch, while the model context is rebuilt from the canonical visible messages so an old compacted state is not reused.

## Semantic web-result filtering

DuckDuckGo page content is reduced locally before it is sent to the chat model. Tiny Local Web Agent uses FastEmbed with `sentence-transformers/all-MiniLM-L6-v2` on CPU to split fetched pages into overlapping chunks and keep the chunks most semantically similar to the original search query. The embedding model is downloaded on first use and then cached by FastEmbed.

Optional environment overrides:

- `TINY_AGENT_EMBEDDING_MODEL` — FastEmbed model name.
- `TINY_AGENT_CHUNK_WORDS` — words per page chunk (default: 180).
- `TINY_AGENT_CHUNK_OVERLAP` — overlap in words (default: 30).
- `TINY_AGENT_CHUNKS_PER_PAGE` — relevant chunks kept per fetched page (default: 2).
- `TINY_AGENT_MAX_PAGE_CHARS` — maximum fetched page text considered for embeddings (default: 30000).
- `TINY_AGENT_EMBED_BATCH` — embedding batch size (default: 32).

If semantic embedding initialization fails, web search falls back to the previous bounded raw-page-text behavior rather than failing the search.


## Attachments

Use **Attach** beside Send to add local files to the current conversation.

- Documents: PDF, DOCX, TXT, Markdown, HTML, CSV, JSON, YAML. Text is extracted, chunked, embedded locally with the same FastEmbed semantic model used by web retrieval, and saved under `data/attachments` for reuse.
- The current question automatically receives only a few semantically relevant excerpts. Later questions can use the built-in `search_attachment` tool to retrieve more relevant passages without loading the whole document into the model context.
- Attachments are scoped to the conversation and are removed when that conversation is deleted.

PDF and DOCX support require `pypdf` and `python-docx`; both are included in `requirements_web.txt`.
