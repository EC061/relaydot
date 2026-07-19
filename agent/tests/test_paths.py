from __future__ import annotations

import os
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relaydot.errors import UnsafePathError
from relaydot.paths import (
    assert_private_directory,
    is_within,
    mode_class,
    normalize_relative_path,
    safe_join,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("file.txt", "file.txt"),
        ("folder/file.txt", "folder/file.txt"),
        ("folder\\file.txt", "folder/file.txt"),
        ("./folder/./file", "folder/file"),
        ("unicodé/文件", "unicodé/文件"),
    ],
)
def test_normalize_valid(raw: str, expected: str) -> None:
    assert normalize_relative_path(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "/etc/passwd",
        "../secret",
        "a/../../b",
        "C:\\Windows",
        "C:/Windows",
        "\\\\server\\share",
        "a\x00b",
        ".",
        "CON",
        "aux.txt",
        "dir/NUL ",
        "trail.",
        "trail ",
    ],
)
def test_normalize_rejects_unsafe_and_nonportable(raw: str) -> None:
    with pytest.raises(UnsafePathError):
        normalize_relative_path(raw)


@given(st.lists(st.text(alphabet="abcXYZ012_-", min_size=1, max_size=8), min_size=1, max_size=5))
def test_normalize_is_idempotent(parts: list[str]) -> None:
    raw = "/".join(parts)
    assert normalize_relative_path(normalize_relative_path(raw)) == raw


def test_safe_join_accepts_normal_child(tmp_path: Path) -> None:
    assert safe_join(tmp_path, "a/b") == tmp_path / "a" / "b"


def test_safe_join_rejects_escaping_intermediate_symlink(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    (tmp_path / "escape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(UnsafePathError, match="symlink escapes"):
        safe_join(tmp_path, "escape/file")


def test_safe_join_accepts_contained_intermediate_symlink(tmp_path: Path) -> None:
    (tmp_path / "actual").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "actual", target_is_directory=True)
    assert safe_join(tmp_path, "link/file") == tmp_path / "link" / "file"


def test_safe_join_leaf_symlink_requires_opt_in(tmp_path: Path) -> None:
    (tmp_path / "real").write_text("ok")
    (tmp_path / "link").symlink_to("real")
    with pytest.raises(UnsafePathError, match="leaf symlink"):
        safe_join(tmp_path, "link")
    assert safe_join(tmp_path, "link", allow_leaf_symlink=True) == tmp_path / "link"


def test_is_within_resolves_paths(tmp_path: Path) -> None:
    assert is_within(tmp_path / "child", tmp_path)
    assert not is_within(tmp_path.parent / "sibling", tmp_path)


def test_mode_classes() -> None:
    assert mode_class(0o100644) == "regular"
    assert mode_class(0o100755) == "executable"
    assert mode_class(0o120777) == "symlink"
    assert mode_class(0o040755) == "other"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission semantics")
def test_private_directory_create_and_reject(tmp_path: Path) -> None:
    private = tmp_path / "private"
    assert_private_directory(private)
    assert private.stat().st_mode & 0o777 == 0o700
    private.chmod(0o755)
    with pytest.raises(UnsafePathError, match="owner-only"):
        assert_private_directory(private)
