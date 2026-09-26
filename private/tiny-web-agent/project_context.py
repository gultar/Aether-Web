from __future__ import annotations

from pathlib import Path

# Directories that provide no useful architectural context to the coding agent.
_EXCLUDED_DIRS = {
    'node_modules', '.git', '.browser-os-agent-backups', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv',
    'dist', 'build', 'outlook_profile',
}

# These are useful landmarks, but their contents are mostly generated/binary/noisy.
_COLLAPSE_DIRS = {'images', 'vendor'}

# Files that are almost never useful for source-code navigation.
_EXCLUDED_FILES = {
    'package-lock.json',
}
_EXCLUDED_SUFFIXES = {
    '.db', '.sqlite', '.sqlite3', '.log', '.pyc', '.pyo', '.gguf', '.bin',
    '.wav', '.mp3', '.mp4', '.zip', '.7z', '.exe', '.dll', '.png', '.jpg',
    '.jpeg', '.webp', '.ico', '.pdf',
}

# Keep the map comfortably small for a 3B model.
_MAX_DEPTH = 5
_MAX_FILES_PER_DIR = 14
_MAX_DIRS_PER_DIR = 18


def _visible_file(path: Path) -> bool:
    if path.name in _EXCLUDED_FILES:
        return False
    if path.suffix.lower() in _EXCLUDED_SUFFIXES:
        return False
    return True


def build_project_tree(root: Path) -> str:
    """Return a compact, indented source tree for Browser-OS.

    The tree is intentionally descriptive rather than exhaustive. It is rebuilt
    from the real filesystem so devmode gets current project landmarks without
    forcing a small model to crawl the repository with tools first.
    """
    root = Path(root).resolve()
    lines: list[str] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > _MAX_DEPTH:
            return
        try:
            entries = list(directory.iterdir())
        except OSError:
            return

        dirs = sorted(
            (p for p in entries if p.is_dir() and p.name not in _EXCLUDED_DIRS),
            key=lambda p: p.name.lower(),
        )
        files = sorted(
            (p for p in entries if p.is_file() and _visible_file(p)),
            key=lambda p: p.name.lower(),
        )

        indent = '  ' * depth

        shown_dirs = dirs[:_MAX_DIRS_PER_DIR]
        for child in shown_dirs:
            lines.append(f'{indent}{child.name}/')
            if child.name in _COLLAPSE_DIRS:
                try:
                    count = sum(1 for _ in child.iterdir())
                except OSError:
                    count = 0
                detail = f'... {count} entries omitted' if count else '... contents omitted'
                lines.append(f'{indent}  {detail}')
            elif depth < _MAX_DEPTH:
                walk(child, depth + 1)
            else:
                lines.append(f'{indent}  ...')

        hidden_dirs = len(dirs) - len(shown_dirs)
        if hidden_dirs > 0:
            lines.append(f'{indent}... {hidden_dirs} more directories')

        shown_files = files[:_MAX_FILES_PER_DIR]
        for child in shown_files:
            lines.append(f'{indent}{child.name}')

        hidden_files = len(files) - len(shown_files)
        if hidden_files > 0:
            lines.append(f'{indent}... {hidden_files} more files')

    walk(root, 0)
    return '\n'.join(lines)
