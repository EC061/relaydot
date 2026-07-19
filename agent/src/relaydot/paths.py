"""Portable path normalization and containment checks."""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path, PurePosixPath

from .errors import UnsafePathError

_DRIVE = re.compile(r"^[A-Za-z]:")
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def normalize_relative_path(value: str) -> str:
    """Return a canonical POSIX relative path or reject it.

    Backslashes are treated as separators so a Windows traversal is not harmless
    merely because validation happens on a Unix controller.
    """

    if not isinstance(value, str) or not value or "\x00" in value:
        raise UnsafePathError("path must be a non-empty string without NUL bytes")
    portable = value.replace("\\", "/")
    if portable.startswith("/") or portable.startswith("//") or _DRIVE.match(portable):
        raise UnsafePathError(f"absolute path is not allowed: {value!r}")
    parts: list[str] = []
    for part in PurePosixPath(portable).parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise UnsafePathError(f"parent traversal is not allowed: {value!r}")
        portable_stem = part.rstrip(". ").split(".", 1)[0].upper()
        if portable_stem in _WINDOWS_RESERVED:
            raise UnsafePathError(f"reserved Windows path component: {part!r}")
        if part.endswith((" ", ".")):
            raise UnsafePathError(f"non-portable trailing character: {part!r}")
        parts.append(part)
    if not parts:
        raise UnsafePathError("path resolves to the root")
    return "/".join(parts)


def is_within(path: Path, root: Path) -> bool:
    """Return whether *path* is contained by *root* after resolving symlinks."""

    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError:
        return False
    return True


def safe_join(root: Path, relative: str, *, allow_leaf_symlink: bool = False) -> Path:
    """Join and validate a path, including existing intermediate symlinks."""

    normalized = normalize_relative_path(relative)
    root_resolved = root.resolve(strict=False)
    candidate = root.joinpath(*normalized.split("/"))
    try:
        candidate.absolute().relative_to(root.absolute())
    except ValueError:
        raise UnsafePathError(f"path escapes root: {relative!r}") from None

    current = root
    parts = normalized.split("/")
    for index, part in enumerate(parts):
        current = current / part
        if not current.is_symlink():
            continue
        is_leaf = index == len(parts) - 1
        target = current.resolve(strict=False)
        if not is_within(target, root_resolved):
            raise UnsafePathError(f"symlink escapes root: {relative!r}")
        if is_leaf and not allow_leaf_symlink:
            raise UnsafePathError(f"leaf symlink is not allowed here: {relative!r}")
    return candidate


def mode_class(mode: int) -> str:
    """Map platform-specific modes to the portable manifest classes."""

    if stat.S_ISLNK(mode):
        return "symlink"
    if not stat.S_ISREG(mode):
        return "other"
    return "executable" if mode & 0o111 else "regular"


def assert_private_directory(path: Path) -> None:
    """Create an owner-only directory and reject unsafe existing permissions."""

    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise UnsafePathError(f"directory must be owner-only: {path}")
