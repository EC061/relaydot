"""Inventory scanning and deterministic manifest serialization."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path

from .errors import UnsafePathError
from .paths import mode_class, safe_join
from .policy import RootPolicy, SyncPolicy
from .secrets import scan_bytes


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True, slots=True, order=True)
class ManifestEntry:
    path: str
    digest: str
    size: int
    mode_class: str
    logical_type: str = "file"
    secret_findings: tuple[str, ...] = ()
    link_target: str | None = None

    def __post_init__(self) -> None:
        if self.size < 0:
            raise ValueError("size cannot be negative")
        if self.logical_type == "file" and len(self.digest) != 64:
            raise ValueError("file digest must be SHA-256")


@dataclass(frozen=True, slots=True)
class Manifest:
    entries: tuple[ManifestEntry, ...]
    format_version: int = 1

    def __post_init__(self) -> None:
        paths = [entry.path for entry in self.entries]
        if paths != sorted(paths) or len(paths) != len(set(paths)):
            raise ValueError("manifest entries must have unique sorted paths")

    def canonical_bytes(self) -> bytes:
        payload = {
            "entries": [asdict(entry) for entry in self.entries],
            "format_version": self.format_version,
        }
        return json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.canonical_bytes()).hexdigest()

    def by_path(self) -> dict[str, ManifestEntry]:
        return {entry.path: entry for entry in self.entries}


def _scan_root(root: RootPolicy, *, report_secrets: bool) -> Iterable[ManifestEntry]:
    if not root.path.exists():
        if root.optional:
            return
        raise FileNotFoundError(root.path)
    if root.path.is_symlink() or not root.path.is_dir():
        raise UnsafePathError(f"sync root must be a real directory: {root.path}")

    for current, directories, files in os.walk(root.path, followlinks=False):
        current_path = Path(current)
        # Symlinked directories are represented as links and must not be traversed.
        for name in list(directories):
            candidate = current_path / name
            if candidate.is_symlink():
                directories.remove(name)
                relative = candidate.relative_to(root.path).as_posix()
                if root.includes(relative):
                    target = os.readlink(candidate)
                    yield ManifestEntry(
                        path=f"{root.name}/{relative}",
                        digest=hashlib.sha256(target.encode()).hexdigest(),
                        size=len(target.encode()),
                        mode_class="symlink",
                        logical_type="symlink",
                        link_target=target,
                    )
        for name in files:
            candidate = current_path / name
            relative = candidate.relative_to(root.path).as_posix()
            if not root.includes(relative):
                continue
            safe_join(root.path, relative, allow_leaf_symlink=True)
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(candidate)
                yield ManifestEntry(
                    path=f"{root.name}/{relative}",
                    digest=hashlib.sha256(target.encode()).hexdigest(),
                    size=len(target.encode()),
                    mode_class="symlink",
                    logical_type="symlink",
                    link_target=target,
                )
            elif stat.S_ISREG(info.st_mode):
                findings: tuple[str, ...] = ()
                if report_secrets:
                    with candidate.open("rb") as handle:
                        findings = tuple(
                            sorted({item.kind for item in scan_bytes(handle.read(2_000_001))})
                        )
                yield ManifestEntry(
                    path=f"{root.name}/{relative}",
                    digest=sha256_file(candidate),
                    size=info.st_size,
                    mode_class=mode_class(info.st_mode),
                    secret_findings=findings,
                )


def build_manifest(policy: SyncPolicy) -> Manifest:
    entries = [
        entry
        for root in policy.roots
        for entry in _scan_root(root, report_secrets=policy.secret_scan == "report")
    ]
    return Manifest(tuple(sorted(entries)))


@dataclass(frozen=True, slots=True)
class ManifestDiff:
    added: tuple[str, ...]
    changed: tuple[str, ...]
    deleted: tuple[str, ...]
    unchanged: tuple[str, ...]


def diff_manifests(base: Manifest, current: Manifest) -> ManifestDiff:
    before, after = base.by_path(), current.by_path()
    common = before.keys() & after.keys()
    return ManifestDiff(
        added=tuple(sorted(after.keys() - before.keys())),
        changed=tuple(sorted(path for path in common if before[path] != after[path])),
        deleted=tuple(sorted(before.keys() - after.keys())),
        unchanged=tuple(sorted(path for path in common if before[path] == after[path])),
    )
