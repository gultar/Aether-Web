# BrowserOS — Editable Skill Categories v2

This fixes the category editor in two places:

1. `skill_manager.py` initialized category storage before `SKILL_CATEGORIES_PATH` existed.
2. The Skills Editor used browser `prompt()` dialogs for editing categories. Those have been replaced by an inline editor.

## Replace

- `private/tiny-web-agent/skill_manager.py`
- `private/tiny-web-agent/web_main.py`
- `js/dashboard/skill-editor.js`
- `css/dashboard.css`

Then fully stop BrowserOS/Tiny Web Agent, start it again, and press Ctrl+F5 once.

## Usage

In Skills Editor:

1. Choose a category in the category dropdown.
2. Click **Edit**.
3. Edit the visible **Name** and **Routing description** fields.
4. Click **Save Category**.

Renaming a category updates the `category:` field of every skill assigned to it.
`General` remains protected from renaming/deletion, but its routing description can be edited.

This package is based on the consolidated CSS, so the multi-select desktop and auto-hide dock styles are preserved.
