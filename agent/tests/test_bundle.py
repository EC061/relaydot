from __future__ import annotations

import gzip
import io
import os
import tarfile
from pathlib import Path

import pytest

from relaydot.bundle import bundle_digest, create_bundle, extract_bundle
from relaydot.errors import BundleError, UnsafePathError


def test_bundle_round_trip_and_determinism(tmp_path: Path) -> None:
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    (source / "nested").mkdir()
    (source / "a").write_bytes(b"alpha")
    (source / "nested" / "b").write_bytes(b"beta")
    (source / "nested" / "b").chmod(0o700)
    first = create_bundle(source, ["nested/b", "a", "a"])
    second = create_bundle(source, ["a", "nested/b"])
    assert first == second
    assert len(bundle_digest(first)) == 64
    assert extract_bundle(first, target) == ("a", "nested/b")
    assert (target / "a").read_bytes() == b"alpha"
    assert (target / "nested" / "b").read_bytes() == b"beta"


@pytest.mark.skipif(os.name == "nt", reason="symlink behavior differs")
def test_bundle_round_trip_internal_symlink(tmp_path: Path) -> None:
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    (source / "real").write_text("content")
    (source / "link").symlink_to("real")
    data = create_bundle(source, ["real", "link"])
    extract_bundle(data, target)
    assert (target / "link").is_symlink()
    assert (target / "link").read_text() == "content"


@pytest.mark.parametrize("path", ["missing", "folder"])
def test_bundle_rejects_missing_or_directory_source(tmp_path: Path, path: str) -> None:
    (tmp_path / "folder").mkdir()
    with pytest.raises(BundleError):
        create_bundle(tmp_path, [path])


def _malicious_bundle(name: str, *, kind: str = "file", linkname: str = "") -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as archive:
        info = tarfile.TarInfo(name)
        info.size = 1
        if kind == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = linkname
            info.size = 0
            archive.addfile(info)
        elif kind == "hardlink":
            info.type = tarfile.LNKTYPE
            info.linkname = linkname
            info.size = 0
            archive.addfile(info)
        else:
            archive.addfile(info, io.BytesIO(b"x"))
    return gzip.compress(raw.getvalue())


@pytest.mark.parametrize("name", ["../escape", "/absolute", "C:/escape", "a/../../escape", "."])
def test_extract_rejects_traversal_before_writing(tmp_path: Path, name: str) -> None:
    target = tmp_path / "target"
    with pytest.raises(BundleError):
        extract_bundle(_malicious_bundle(name), target)
    assert not (tmp_path / "escape").exists()


@pytest.mark.parametrize(
    ("kind", "target"), [("hardlink", "safe"), ("symlink", "../../escape"), ("symlink", "/escape")]
)
def test_extract_rejects_unsafe_links(tmp_path: Path, kind: str, target: str) -> None:
    with pytest.raises(BundleError):
        extract_bundle(_malicious_bundle("link", kind=kind, linkname=target), tmp_path / "out")


def test_extract_rejects_invalid_compression(tmp_path: Path) -> None:
    with pytest.raises(BundleError, match="invalid"):
        extract_bundle(b"not a tarball", tmp_path)


def test_create_bundle_rejects_traversal(tmp_path: Path) -> None:
    with pytest.raises(UnsafePathError):
        create_bundle(tmp_path, ["../outside"])
