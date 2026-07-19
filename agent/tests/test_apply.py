from __future__ import annotations

import os
from pathlib import Path

import pytest

from relaydot.apply import ApplyFile, atomic_apply
from relaydot.errors import ApplyError, UnsafePathError


def test_apply_creates_replaces_deletes_managed_and_preserves_unknown(tmp_path: Path) -> None:
    (tmp_path / "replace").write_text("old")
    (tmp_path / "delete").write_text("gone")
    (tmp_path / "unknown").write_text("keep")
    result = atomic_apply(
        tmp_path,
        [ApplyFile("replace", b"new"), ApplyFile("nested/create", b"created", executable=True)],
        delete=["delete"],
        previously_managed=frozenset({"replace", "delete"}),
    )
    assert result.written == ("nested/create", "replace")
    assert result.deleted == ("delete",)
    assert (tmp_path / "replace").read_text() == "new"
    assert (tmp_path / "nested/create").read_text() == "created"
    assert not (tmp_path / "delete").exists()
    assert (tmp_path / "unknown").read_text() == "keep"
    assert result.backup_directory is not None
    assert (result.backup_directory / "replace").read_text() == "old"
    assert (result.backup_directory / "delete").read_text() == "gone"


def test_apply_without_existing_files_has_no_backup(tmp_path: Path) -> None:
    result = atomic_apply(tmp_path, [ApplyFile("new", b"value")])
    assert result.backup_directory is None


def test_apply_can_discard_backup(tmp_path: Path) -> None:
    (tmp_path / "file").write_text("old")
    result = atomic_apply(tmp_path, [ApplyFile("file", b"new")], keep_backup=False)
    assert result.backup_directory is None
    assert not list(tmp_path.glob(".relaydot-recovery-*"))


def test_apply_rolls_back_all_prior_changes_on_interruption(tmp_path: Path) -> None:
    (tmp_path / "a").write_text("old-a")
    (tmp_path / "b").write_text("old-b")

    def fail_on_b(path: str) -> None:
        if path == "b":
            raise RuntimeError("power loss")

    with pytest.raises(ApplyError, match="rolled back"):
        atomic_apply(
            tmp_path, [ApplyFile("a", b"new-a"), ApplyFile("b", b"new-b")], before_replace=fail_on_b
        )
    assert (tmp_path / "a").read_text() == "old-a"
    assert (tmp_path / "b").read_text() == "old-b"
    assert not list(tmp_path.glob(".relaydot-apply-*"))


def test_apply_rolls_back_new_file_by_removing_it(tmp_path: Path) -> None:
    def fail(path: str) -> None:
        if path == "z":
            raise OSError("disk full")

    with pytest.raises(ApplyError):
        atomic_apply(
            tmp_path, [ApplyFile("a", b"new"), ApplyFile("z", b"never")], before_replace=fail
        )
    assert not (tmp_path / "a").exists()


def test_delete_unmanaged_path_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "local").write_text("important")
    with pytest.raises(ApplyError, match="unmanaged"):
        atomic_apply(tmp_path, [], delete=["local"])
    assert (tmp_path / "local").read_text() == "important"


def test_write_delete_overlap_and_duplicate_rejected(tmp_path: Path) -> None:
    with pytest.raises(ApplyError, match="written and deleted"):
        atomic_apply(
            tmp_path,
            [ApplyFile("same", b"x")],
            delete=["same"],
            previously_managed=frozenset({"same"}),
        )
    with pytest.raises(ApplyError, match="duplicate"):
        atomic_apply(tmp_path, [ApplyFile("same", b"x"), ApplyFile("same", b"y")])


@pytest.mark.parametrize("path", ["../escape", "/absolute", "C:\\escape"])
def test_apply_rejects_unsafe_paths_before_staging(tmp_path: Path, path: str) -> None:
    with pytest.raises(UnsafePathError):
        atomic_apply(tmp_path, [ApplyFile(path, b"bad")])
    assert not list(tmp_path.glob(".relaydot-apply-*"))


def test_apply_rejects_directory_at_managed_path(tmp_path: Path) -> None:
    (tmp_path / "directory").mkdir()
    with pytest.raises(ApplyError, match="not a file"):
        atomic_apply(tmp_path, [ApplyFile("directory", b"bad")])


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable bit")
def test_apply_sets_portable_modes(tmp_path: Path) -> None:
    atomic_apply(tmp_path, [ApplyFile("plain", b"x"), ApplyFile("exec", b"x", executable=True)])
    assert (tmp_path / "plain").stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "exec").stat().st_mode & 0o777 == 0o700


@pytest.mark.skipif(os.name == "nt", reason="symlink behavior differs")
def test_apply_backs_up_and_restores_a_symlink_on_failure(tmp_path: Path) -> None:
    (tmp_path / "target").write_text("target")
    (tmp_path / "a-link").symlink_to("target")
    (tmp_path / "z-file").write_text("old")

    def interrupt(path: str) -> None:
        if path == "z-file":
            raise OSError("interrupted")

    with pytest.raises(ApplyError):
        atomic_apply(
            tmp_path,
            [ApplyFile("a-link", b"replacement"), ApplyFile("z-file", b"new")],
            before_replace=interrupt,
        )
    assert (tmp_path / "a-link").is_symlink()
    assert os.readlink(tmp_path / "a-link") == "target"


def test_delete_missing_managed_file_is_idempotent(tmp_path: Path) -> None:
    observed: list[str] = []
    result = atomic_apply(
        tmp_path,
        [],
        delete=["already-missing"],
        previously_managed=frozenset({"already-missing"}),
        before_replace=observed.append,
    )
    assert result.deleted == ("already-missing",)
    assert observed == ["already-missing"]
