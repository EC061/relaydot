from __future__ import annotations

from pathlib import Path

import pytest

from relaydot.errors import PolicyError
from relaydot.policy import RootPolicy, load_policy


def test_load_policy_resolves_home_and_fields(policy_file: Path, tmp_path: Path) -> None:
    policy = load_policy(policy_file, home=tmp_path)
    assert policy.name == "test"
    assert policy.deletion_policy == "archive-and-restore"
    assert policy.encryption_required == "end-to-end"
    assert policy.root("config").path == tmp_path / ".config-tool"
    assert policy.root("optional").optional
    with pytest.raises(KeyError):
        policy.root("missing")


@pytest.mark.parametrize(
    ("relative", "included"),
    [("a", True), ("deep/a.json", True), ("excluded/no", False), ("excluded/deep/no", False)],
)
def test_include_exclude(relative: str, included: bool, tmp_path: Path) -> None:
    root = RootPolicy("x", tmp_path, ("/**",), ("/excluded/**",))
    assert root.includes(relative) is included


def test_invalid_glob_raises_when_evaluated(tmp_path: Path) -> None:
    root = RootPolicy("x", tmp_path, ("**",))
    with pytest.raises(PolicyError, match="start"):
        root.includes("file")


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("relaydot.dev/v1alpha1", "other/v1", "apiVersion"),
        ("kind: SyncPolicy", "kind: Other", "kind"),
        ("metadata:\n  name: test", "metadata: []", "metadata"),
        ("  roots:", "  no_roots:", "roots"),
        ("    - name: config", "    - name: ''", "root names"),
        ("      path: ~/.config-tool", "      no_path: true", "requires a path"),
        ("      path: ~/.config-tool", "      path: relative", "absolute"),
        ('      include: ["/**"]', "      include: []", "include"),
        ('      exclude: ["/excluded/**"]', "      exclude: nope", "exclude"),
        (
            "    encryptionRequired: end-to-end",
            "    encryptionRequired: server-side",
            "encryptionRequired",
        ),
    ],
)
def test_invalid_policy_variants(
    policy_text: str, tmp_path: Path, old: str, new: str, message: str
) -> None:
    path = tmp_path / "bad.yaml"
    path.write_text(policy_text.replace(old, new, 1))
    with pytest.raises(PolicyError, match=message):
        load_policy(path, home=tmp_path)


def test_duplicate_root_names_rejected(policy_text: str, tmp_path: Path) -> None:
    path = tmp_path / "bad.yaml"
    path.write_text(policy_text.replace("name: optional", "name: config"))
    with pytest.raises(PolicyError, match="unique"):
        load_policy(path, home=tmp_path)


def test_unsafe_glob_rejected(policy_text: str, tmp_path: Path) -> None:
    path = tmp_path / "bad.yaml"
    path.write_text(policy_text.replace('["/**"]', '["/../**"]', 1))
    with pytest.raises(PolicyError, match="unsafe glob"):
        load_policy(path, home=tmp_path)


def test_unreadable_or_malformed_policy(tmp_path: Path) -> None:
    with pytest.raises(PolicyError, match="cannot read"):
        load_policy(tmp_path / "missing")
    bad = tmp_path / "bad"
    bad.write_text("[unterminated")
    with pytest.raises(PolicyError, match="cannot read"):
        load_policy(bad)


def test_repository_recommended_policy_is_loadable(tmp_path: Path) -> None:
    policy_path = Path(__file__).resolve().parents[2] / "policies" / "recommended.yaml"
    policy = load_policy(policy_path, home=tmp_path)
    assert policy.name == "full-mirror-retain-forever"
    assert {root.name for root in policy.roots} == {
        "claude-full",
        "claude-global-state",
        "codex-full",
        "agents-full",
    }
