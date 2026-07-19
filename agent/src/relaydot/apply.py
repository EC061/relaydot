"""Staged filesystem apply with recovery backups and managed deletion semantics."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from .errors import ApplyError
from .paths import normalize_relative_path, safe_join


@dataclass(frozen=True, slots=True)
class ApplyFile:
    path: str
    content: bytes
    executable: bool = False


@dataclass(frozen=True, slots=True)
class ApplyResult:
    written: tuple[str, ...]
    deleted: tuple[str, ...]
    backup_directory: Path | None


def atomic_apply(
    root: Path,
    files: Iterable[ApplyFile],
    *,
    delete: Iterable[str] = (),
    previously_managed: frozenset[str] = frozenset(),
    keep_backup: bool = True,
    before_replace: Callable[[str], None] | None = None,
) -> ApplyResult:
    """Apply a validated set and roll all touched paths back on failure.

    Deletions are only accepted for paths in ``previously_managed``. The optional
    hook exists for observability and fault-injection tests, not synchronization
    policy decisions.
    """

    root.mkdir(parents=True, exist_ok=True)
    normalized_files: dict[str, ApplyFile] = {}
    for item in files:
        path = normalize_relative_path(item.path)
        if path in normalized_files:
            raise ApplyError(f"duplicate apply path: {path}")
        safe_join(root, path, allow_leaf_symlink=True)
        normalized_files[path] = ApplyFile(path, item.content, item.executable)
    normalized_deletes = {normalize_relative_path(path) for path in delete}
    if normalized_deletes & normalized_files.keys():
        raise ApplyError("a path cannot be written and deleted in one apply")
    unmanaged = normalized_deletes - previously_managed
    if unmanaged:
        raise ApplyError(f"refusing to delete unmanaged paths: {sorted(unmanaged)!r}")
    for path in normalized_deletes:
        safe_join(root, path, allow_leaf_symlink=True)

    work = Path(tempfile.mkdtemp(prefix=".relaydot-apply-", dir=root))
    stage, backup = work / "stage", work / "backup"
    stage.mkdir(mode=0o700)
    backup.mkdir(mode=0o700)
    touched = sorted(normalized_files.keys() | normalized_deletes)
    existed: set[str] = set()
    try:
        for path, item in normalized_files.items():
            target = safe_join(stage, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(item.content)
            target.chmod(0o700 if item.executable else 0o600)

        for path in touched:
            live = safe_join(root, path, allow_leaf_symlink=True)
            if live.exists() or live.is_symlink():
                existed.add(path)
                saved = safe_join(backup, path, allow_leaf_symlink=True)
                saved.parent.mkdir(parents=True, exist_ok=True)
                if live.is_symlink():
                    saved.symlink_to(os.readlink(live))
                elif live.is_file():
                    shutil.copy2(live, saved, follow_symlinks=False)
                else:
                    raise ApplyError(f"managed path is not a file: {path}")

        applied: list[str] = []
        try:
            for path in sorted(normalized_files):
                if before_replace:
                    before_replace(path)
                live = safe_join(root, path, allow_leaf_symlink=True)
                live.parent.mkdir(parents=True, exist_ok=True)
                os.replace(safe_join(stage, path), live)
                applied.append(path)
            for path in sorted(normalized_deletes):
                if before_replace:
                    before_replace(path)
                live = safe_join(root, path, allow_leaf_symlink=True)
                if live.exists() or live.is_symlink():
                    live.unlink()
                applied.append(path)
        except Exception as exc:
            for path in reversed(applied):
                live = safe_join(root, path, allow_leaf_symlink=True)
                if live.exists() or live.is_symlink():
                    live.unlink()
                if path in existed:
                    saved = safe_join(backup, path, allow_leaf_symlink=True)
                    live.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(saved, live)
            raise ApplyError(f"apply rolled back: {exc}") from exc

        backup_result: Path | None = None
        if keep_backup and existed:
            backup_result = root / f".relaydot-recovery-{work.name.rsplit('-', 1)[-1]}"
            os.replace(backup, backup_result)
        return ApplyResult(
            tuple(sorted(normalized_files)), tuple(sorted(normalized_deletes)), backup_result
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
