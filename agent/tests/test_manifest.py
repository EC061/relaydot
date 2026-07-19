from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from relaydot.errors import UnsafePathError
from relaydot.manifest import Manifest, ManifestEntry, build_manifest, diff_manifests, sha256_file
from relaydot.policy import load_policy
from relaydot.secrets import scan_bytes


def test_sha256_file_streams_content(tmp_path: Path) -> None:
    path = tmp_path / "large"
    data = b"abc" * 400_000
    path.write_bytes(data)
    assert sha256_file(path, chunk_size=17) == hashlib.sha256(data).hexdigest()


def test_manifest_inventory_is_sorted_deterministic_and_secret_aware(
    policy_file: Path, tmp_path: Path
) -> None:
    root = tmp_path / ".config-tool"
    root.mkdir()
    (root / "z.txt").write_text("last")
    (root / "a.txt").write_text("sk-proj-abcdefghijklmnopqrstuvwxyz012345")
    (root / "excluded").mkdir()
    (root / "excluded" / "no.txt").write_text("no")
    manifest = build_manifest(load_policy(policy_file, home=tmp_path))
    assert [item.path for item in manifest.entries] == ["config/a.txt", "config/z.txt"]
    assert manifest.entries[0].secret_findings == ("openai-key",)
    assert len(manifest.digest) == 64
    assert manifest.canonical_bytes() == manifest.canonical_bytes()


@pytest.mark.skipif(os.name == "nt", reason="symlink behavior differs")
def test_manifest_records_symlinks_without_following(policy_file: Path, tmp_path: Path) -> None:
    root = tmp_path / ".config-tool"
    root.mkdir()
    (root / "real").mkdir()
    (root / "real" / "inside").write_text("yes")
    (root / "linked").symlink_to(root / "real", target_is_directory=True)
    manifest = build_manifest(load_policy(policy_file, home=tmp_path))
    by_path = manifest.by_path()
    assert by_path["config/linked"].logical_type == "symlink"
    assert "config/linked/inside" not in by_path
    assert "config/real/inside" in by_path


@pytest.mark.skipif(os.name == "nt", reason="symlink behavior differs")
def test_manifest_records_file_symlink(policy_file: Path, tmp_path: Path) -> None:
    root = tmp_path / ".config-tool"
    root.mkdir()
    (root / "real").write_text("content")
    (root / "alias").symlink_to("real")
    by_path = build_manifest(load_policy(policy_file, home=tmp_path)).by_path()
    assert by_path["config/alias"].logical_type == "symlink"
    assert by_path["config/alias"].link_target == "real"


def test_missing_required_root_fails_but_optional_does_not(
    policy_file: Path, tmp_path: Path
) -> None:
    policy = load_policy(policy_file, home=tmp_path)
    with pytest.raises(FileNotFoundError):
        build_manifest(policy)
    (tmp_path / ".config-tool").mkdir()
    assert build_manifest(policy).entries == ()


def test_root_must_not_be_symlink(policy_file: Path, tmp_path: Path) -> None:
    actual = tmp_path / "actual"
    actual.mkdir()
    (tmp_path / ".config-tool").symlink_to(actual, target_is_directory=True)
    with pytest.raises(UnsafePathError, match="real directory"):
        build_manifest(load_policy(policy_file, home=tmp_path))


def entry(path: str, digest: str = "a" * 64) -> ManifestEntry:
    return ManifestEntry(path, digest, 1, "regular")


def test_manifest_validates_sort_uniqueness_digest_and_size() -> None:
    with pytest.raises(ValueError, match="sorted"):
        Manifest((entry("b"), entry("a")))
    with pytest.raises(ValueError, match="sorted"):
        Manifest((entry("a"), entry("a")))
    with pytest.raises(ValueError, match="digest"):
        entry("a", "short")
    with pytest.raises(ValueError, match="negative"):
        ManifestEntry("a", "a" * 64, -1, "regular")


def test_manifest_diff_all_categories() -> None:
    before = Manifest((entry("changed", "a" * 64), entry("deleted"), entry("same")))
    after = Manifest((entry("added"), entry("changed", "b" * 64), entry("same")))
    diff = diff_manifests(before, after)
    assert diff.added == ("added",)
    assert diff.changed == ("changed",)
    assert diff.deleted == ("deleted",)
    assert diff.unchanged == ("same",)


@pytest.mark.parametrize(
    ("value", "kinds"),
    [
        (b"prefix -----BEGIN PRIVATE KEY----- suffix", ("private-key",)),
        (b"sk-ant-abcdefghijklmnopqrstuvwxyz", ("anthropic-key",)),
        (b"ghp_abcdefghijklmnopqrstuvwxyz", ("github-token",)),
        (b"AKIAABCDEFGHIJKLMNOP", ("aws-access-key",)),
        (b"ordinary text", ()),
    ],
)
def test_secret_scanner_reports_categories_not_values(value: bytes, kinds: tuple[str, ...]) -> None:
    findings = scan_bytes(value)
    assert tuple(item.kind for item in findings) == kinds
    assert all(not hasattr(item, "value") for item in findings)


def test_secret_scanner_honors_limit() -> None:
    assert not scan_bytes(b"padding sk-ant-abcdefghijklmnopqrstuvwxyz", max_bytes=7)
