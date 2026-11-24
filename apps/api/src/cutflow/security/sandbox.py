"""Strict path-traversal sandboxing and filesystem-safe slug sanitization."""

from __future__ import annotations

import re
from pathlib import Path


class PathSandboxError(ValueError):
    """Raised when a path escapes its permitted root directory."""


_SLUG_NON_WORD = re.compile(r"[^\w\s-]", re.UNICODE)
_SLUG_SEP = re.compile(r"[\s_-]+")


def safe_slug(text: str, *, max_length: int = 48, default: str = "item") -> str:
    """Turn arbitrary user input into a lowercase ASCII/Unicode slug safe for filenames."""
    cleaned = _SLUG_NON_WORD.sub("", text).strip().lower()
    cleaned = _SLUG_SEP.sub("-", cleaned).strip("-")
    return cleaned[:max_length] or default


def safe_resolve(candidate: Path | str, allowed_root: Path | str) -> Path:
    """Resolve ``candidate`` and enforce that it stays strictly inside ``allowed_root``."""
    root = Path(allowed_root).expanduser().resolve()
    raw_path = Path(candidate)
    target = (raw_path if raw_path.is_absolute() else (root / raw_path)).resolve()

    if not target.is_relative_to(root):
        raise PathSandboxError(
            f"Path traversal blocked: {candidate!r} escapes sandbox root {str(root)!r}."
        )
    return target
