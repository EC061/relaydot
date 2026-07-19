"""Deterministic compressed bundles with traversal-safe extraction."""

from __future__ import annotations

import gzip
import hashlib
import io
import os
import tarfile
from collections.abc import Iterable
from pathlib import Path

from .errors import BundleError
from .paths import normalize_relative_path, safe_join


def create_bundle(root: Path, paths: Iterable[str]) -> bytes:
    """Create a deterministic gzip-compressed tar containing regular files/links."""

    normalized = sorted({normalize_relative_path(path) for path in paths})
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for relative in normalized:
            source = safe_join(root, relative, allow_leaf_symlink=True)
            if not source.exists() and not source.is_symlink():
                raise BundleError(f"source does not exist: {relative}")
            if not source.is_file() and not source.is_symlink():
                raise BundleError(f"unsupported source type: {relative}")
            info = archive.gettarinfo(str(source), arcname=relative)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            if info.isfile():
                with source.open("rb") as handle:
                    archive.addfile(info, handle)
            else:
                archive.addfile(info)
    return gzip.compress(raw.getvalue(), mtime=0)


def bundle_digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_bundle(data: bytes, destination: Path) -> tuple[str, ...]:
    """Validate every member before extracting any member."""

    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            members = archive.getmembers()
            normalized: list[str] = []
            for member in members:
                try:
                    name = normalize_relative_path(member.name)
                except Exception as exc:
                    raise BundleError(f"unsafe archive path: {member.name!r}") from exc
                if name != member.name or member.islnk() or not (member.isfile() or member.issym()):
                    raise BundleError(f"unsupported archive member: {member.name!r}")
                if member.issym():
                    parent = Path(name).parent
                    link_target = (parent / member.linkname).as_posix()
                    try:
                        normalize_relative_path(link_target)
                    except Exception as exc:
                        raise BundleError(f"unsafe symlink target: {member.linkname!r}") from exc
                normalized.append(name)

            destination.mkdir(parents=True, exist_ok=True)
            for member, name in zip(members, normalized, strict=True):
                output_path = safe_join(destination, name, allow_leaf_symlink=True)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                if member.isfile():
                    source = archive.extractfile(member)
                    if source is None:
                        raise BundleError(f"missing member data: {name}")
                    temporary = output_path.with_name(f".{output_path.name}.relaydot-tmp")
                    with temporary.open("wb") as handle:
                        while chunk := source.read(1024 * 1024):
                            handle.write(chunk)
                    os.chmod(temporary, member.mode & 0o777)
                    os.replace(temporary, output_path)
                else:
                    output_path.symlink_to(member.linkname)
            return tuple(normalized)
    except (tarfile.TarError, OSError) as exc:
        raise BundleError("invalid compressed bundle") from exc
