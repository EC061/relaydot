"""Two devices exchanging content through one shared WebDAV store."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fakedav import BASE_URL, FakeDav

from relaydot.errors import StorageError
from relaydot.manifest import build_manifest
from relaydot.policy import load_policy
from relaydot.sync import (
    SyncState,
    default_state_path,
    diff_against_state,
    is_append_log,
    publish,
    read_snapshot,
    run_sync,
    verify_object,
)
from relaydot.webdav import WebdavClient, object_path

POLICY = """\
apiVersion: relaydot.dev/v1alpha1
kind: SyncPolicy
metadata:
  name: shared
spec:
  behavior:
    deletionPolicy: archive-and-restore
    conflictStrategy: preserve_both_and_pause_path
    secretScan: report
    encryptionRequired: end-to-end
  roots:
    - name: claude
      path: ~/.claude
      include: ["/**"]
      ignore:
        - "!/settings.json"
        - "!/commands"
        - "!/projects"
        - "*"
"""


class Device:
    """One machine: its own home directory, sync state, and WebDAV client."""

    def __init__(self, root: Path, dav: FakeDav, policy_file: Path, device_id: str) -> None:
        self.home = root
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / ".claude").mkdir(exist_ok=True)
        self.policy = load_policy(policy_file, home=self.home)
        self.state = SyncState.load(root / "sync-state.json")
        self.device_id = device_id
        self._dav = dav

    def write(self, relative: str, text: str) -> Path:
        path = self.home / ".claude" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def read(self, relative: str) -> str:
        return (self.home / ".claude" / relative).read_text()

    def sync(self, now: int | None = None) -> object:
        client = WebdavClient(BASE_URL, self._dav.username, self._dav.password, self._dav.client())
        try:
            return run_sync(
                client,
                self.policy,
                build_manifest(self.policy),
                self.state,
                device_id=self.device_id,
                device_name=self.device_id,
                now=now,
            )
        finally:
            client.close()

    def names(self) -> set[str]:
        base = self.home / ".claude"
        return {
            str(path.relative_to(base))
            for path in base.rglob("*")
            if path.is_file() and not path.name.startswith(".relaydot")
        }


@pytest.fixture
def policy_path(tmp_path: Path) -> Path:
    path = tmp_path / "shared.yaml"
    path.write_text(POLICY)
    return path


@pytest.fixture
def dav() -> FakeDav:
    return FakeDav()


def test_content_moves_from_one_agent_to_the_other(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    alpha.write("settings.json", '{"theme":"dark"}')
    alpha.write("commands/deploy.md", "# deploy")
    first = alpha.sync(now=1000)
    assert first.uploaded == 2
    assert first.peers == 0
    # Content is addressed by digest, so the manifest never carries bytes.
    assert sorted(name for name in dav.files if name.startswith("objects/"))

    second = beta.sync(now=1010)
    assert second.peers == 1
    assert second.downloaded == 2
    assert beta.read("settings.json") == '{"theme":"dark"}'
    assert beta.read("commands/deploy.md") == "# deploy"
    assert set(second.applied) == {"claude/settings.json", "claude/commands/deploy.md"}


def test_unchanged_content_is_never_uploaded_twice(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    alpha.write("settings.json", "{}")
    assert alpha.sync(now=1000).uploaded == 1

    again = alpha.sync(now=1100)
    assert again.uploaded == 0
    assert again.skipped_present == 1

    # A second device holding identical bytes recognizes them in the store and
    # uploads nothing, which is what the content address buys.
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")
    beta.write("settings.json", "{}")
    report = beta.sync(now=1200)
    assert report.uploaded == 0
    assert report.skipped_present == 1


def test_the_newer_modification_time_wins_between_peers(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    settings = alpha.write("settings.json", "old")
    import os

    os.utime(settings, (1000, 1000))
    alpha.sync(now=1000)

    newer = beta.write("settings.json", "new")
    os.utime(newer, (2000, 2000))
    beta.sync(now=2000)

    # Alpha's copy is untouched since its own last apply, so it takes the newer
    # peer content instead of raising a conflict.
    report = alpha.sync(now=3000)
    assert alpha.read("settings.json") == "new"
    assert report.conflicts == ()


def test_a_local_edit_preserves_both_copies_and_pauses_the_path(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    alpha.write("settings.json", "original")
    alpha.sync(now=1000)
    beta.sync(now=1010)
    assert beta.read("settings.json") == "original"

    import os

    # Both sides diverge from the applied revision.
    edited = beta.write("settings.json", "beta local edit")
    os.utime(edited, (1500, 1500))
    changed = alpha.write("settings.json", "alpha newer")
    os.utime(changed, (2000, 2000))
    alpha.sync(now=2000)

    report = beta.sync(now=2100)
    assert beta.read("settings.json") == "beta local edit"
    assert len(report.conflicts) == 1
    conflict = report.conflicts[0]
    assert conflict.startswith("claude/settings.json.relaydot-conflict-")
    preserved = beta.home / ".claude" / conflict.split("/", 1)[1]
    assert preserved.read_text() == "alpha newer"


def test_a_path_missing_from_a_peer_manifest_is_never_deleted(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    alpha.write("settings.json", "{}")
    alpha.sync(now=1000)
    beta.sync(now=1010)

    (alpha.home / ".claude" / "settings.json").unlink()
    alpha.sync(now=2000)

    beta.sync(now=2100)
    # deletionPolicy is archive-and-restore: absence is not a delete instruction.
    assert beta.read("settings.json") == "{}"


def test_ignored_paths_are_neither_published_nor_accepted(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    alpha.write("settings.json", "{}")
    alpha.write(".credentials.json", "secret")
    alpha.write("history.jsonl", "{}")
    report = alpha.sync(now=1000)
    assert report.files == 1

    published = json.loads(dav.files["manifests/device-alpha.json"])
    assert [entry["path"] for entry in published["entries"]] == ["claude/settings.json"]

    beta.sync(now=1010)
    assert beta.names() == {"settings.json"}


def test_a_peer_manifest_naming_an_absent_object_is_skipped(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")
    dav.collections.update({"manifests", "objects"})
    dav.files["manifests/device-ghost.json"] = json.dumps(
        {
            "format_version": 1,
            "device_id": "device-ghost",
            "generated_at": 10,
            "entries": [
                {
                    "path": "claude/settings.json",
                    "digest": "a" * 64,
                    "size": 2,
                    "logical_type": "file",
                    "modified_at": 10,
                }
            ],
        }
    ).encode()

    report = beta.sync(now=100)
    assert report.peers == 1
    assert report.downloaded == 0
    assert beta.names() == set()


def test_an_unreadable_peer_manifest_is_reported_rather_than_ignored(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")
    dav.collections.update({"manifests", "objects"})
    dav.files["manifests/device-broken.json"] = b"{not json"
    with pytest.raises(StorageError, match="not readable JSON"):
        beta.sync(now=100)


def test_state_survives_a_restart_and_rejects_a_foreign_format(tmp_path: Path) -> None:
    path = tmp_path / "sync-state.json"
    state = SyncState.load(path)
    state.uploaded["a" * 64] = 5
    state.applied["claude/settings.json"] = {"digest": "b" * 64}
    state.managed["claude"] = ["settings.json"]
    state.peers["device-x"] = 7
    state.save()

    reloaded = SyncState.load(path)
    assert reloaded.uploaded == {"a" * 64: 5}
    assert reloaded.applied["claude/settings.json"]["digest"] == "b" * 64
    assert reloaded.managed == {"claude": ["settings.json"]}
    assert reloaded.peers == {"device-x": 7}
    assert path.stat().st_mode & 0o077 == 0

    path.write_text(json.dumps({"format_version": 99, "uploaded": {"a": 1}}))
    assert SyncState.load(path).uploaded == {}
    path.write_text("not json")
    assert SyncState.load(path).uploaded == {}
    assert SyncState.load(tmp_path / "absent.json").uploaded == {}


def test_diff_reports_added_changed_and_removed_paths(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    alpha.write("settings.json", "{}")

    manifest = build_manifest(alpha.policy)
    assert diff_against_state(manifest, alpha.state).added == ("claude/settings.json",)

    alpha.state.applied["claude/settings.json"] = {"digest": "0" * 64}
    alpha.state.applied["claude/gone.md"] = {"digest": "1" * 64}
    diff = diff_against_state(manifest, alpha.state)
    assert diff.added == ()
    assert diff.changed == ("claude/settings.json",)
    assert diff.removed == ("claude/gone.md",)
    assert diff.as_dict()["changed"] == ["claude/settings.json"]


def test_verify_object_checks_the_recorded_digest(tmp_path: Path) -> None:
    import hashlib

    path = tmp_path / "file.txt"
    path.write_text("payload")
    digest = hashlib.sha256(b"payload").hexdigest()
    assert verify_object(path, digest) is True
    assert verify_object(path, "0" * 64) is False
    assert verify_object(tmp_path / "absent.txt", digest) is False
    link = tmp_path / "link.txt"
    link.symlink_to(path)
    assert verify_object(link, digest) is False


def test_default_state_path_sits_beside_the_credential(tmp_path: Path) -> None:
    assert default_state_path(tmp_path / "agent.json") == tmp_path / "sync-state.json"


def test_symlinks_are_published_but_not_applied(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")
    alpha.write("settings.json", "{}")
    (alpha.home / ".claude" / "commands").mkdir(exist_ok=True)
    (alpha.home / ".claude" / "commands" / "link.md").symlink_to(
        alpha.home / ".claude" / "settings.json"
    )

    report = alpha.sync(now=1000)
    assert "claude/commands/link.md" in report.unsupported
    published = json.loads(dav.files["manifests/device-alpha.json"])
    link = next(
        entry for entry in published["entries"] if entry["path"] == "claude/commands/link.md"
    )
    assert link["logical_type"] == "symlink"
    assert link["link_target"].endswith("settings.json")

    # The peer takes the regular file and leaves the link alone rather than
    # recreating a target that means something different on its machine.
    beta.sync(now=1010)
    assert beta.names() == {"settings.json"}


def test_objects_are_stored_under_their_digest(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    import hashlib

    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    alpha.write("settings.json", "content")
    alpha.sync(now=1000)
    digest = hashlib.sha256(b"content").hexdigest()
    assert dav.files[object_path(digest)] == b"content"


# ------------------------------------------------------------- partial writes


def test_a_transcript_appended_between_hashing_and_upload_is_still_addressable(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    """The stored object must hash to the name it is stored under.

    An inventory pass hashes the file, then the upload reads it. A live session
    appends in between. Publishing the earlier digest with the later bytes would
    put content at an address it does not hash to, and every peer and the
    controller would trust that address.
    """

    import hashlib

    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    transcript = alpha.write("projects/demo/s.jsonl", '{"a":1}\n')
    manifest = build_manifest(alpha.policy)
    stale_digest = manifest.by_path()["claude/projects/demo/s.jsonl"].digest

    # The session writes another record after the inventory pass.
    transcript.write_text('{"a":1}\n{"b":2}\n')

    client = WebdavClient(BASE_URL, dav.username, dav.password, dav.client())
    publish(
        client,
        alpha.policy,
        manifest,
        alpha.state,
        device_id="device-alpha",
        device_name="alpha",
        now=1000,
    )
    client.close()

    published = json.loads(dav.files["manifests/device-alpha.json"])
    entry = next(
        item for item in published["entries"] if item["path"] == "claude/projects/demo/s.jsonl"
    )
    assert entry["digest"] != stale_digest
    stored = dav.files[object_path(entry["digest"])]
    assert hashlib.sha256(stored).hexdigest() == entry["digest"]
    assert stored == b'{"a":1}\n{"b":2}\n'


def test_a_half_written_record_is_withheld_until_it_is_complete(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")
    # A record is mid-flight: no trailing newline yet.
    alpha.write("projects/demo/s.jsonl", '{"done":1}\n{"partial":')
    alpha.sync(now=1000)

    beta.sync(now=1010)
    # The peer receives only whole records, never a truncated JSON line.
    assert beta.read("projects/demo/s.jsonl") == '{"done":1}\n'

    # Once the writer finishes the record, it propagates.
    alpha.write("projects/demo/s.jsonl", '{"done":1}\n{"partial":2}\n')
    alpha.sync(now=2000)
    beta.sync(now=2010)
    assert beta.read("projects/demo/s.jsonl") == '{"done":1}\n{"partial":2}\n'


def test_a_transcript_with_no_complete_record_yet_is_not_published(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    alpha.write("settings.json", "{}")
    alpha.write("projects/demo/s.jsonl", '{"incomplete":')
    report = alpha.sync(now=1000)

    published = json.loads(dav.files["manifests/device-alpha.json"])
    paths = [entry["path"] for entry in published["entries"]]
    # Publishing an empty object for the path would tell peers the log is empty.
    assert paths == ["claude/settings.json"]
    assert report.uploaded == 1


def test_a_longer_local_log_is_never_replaced_by_a_shorter_newer_one(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    """Records only get appended, so the longer log is the complete one.

    Deciding this by modification time would let a peer that has fewer records
    but touched the file more recently truncate a longer transcript.
    """

    import os

    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    long_log = alpha.write("projects/demo/s.jsonl", '{"n":1}\n{"n":2}\n{"n":3}\n')
    os.utime(long_log, (1000, 1000))
    alpha.sync(now=1000)

    short_log = beta.write("projects/demo/s.jsonl", '{"n":1}\n')
    os.utime(short_log, (9000, 9000))
    beta.sync(now=9000)

    report = alpha.sync(now=9500)
    assert alpha.read("projects/demo/s.jsonl") == '{"n":1}\n{"n":2}\n{"n":3}\n'
    assert report.conflicts == ()
    # And the shorter side takes the longer log rather than conflicting.
    beta.sync(now=9600)
    assert beta.read("projects/demo/s.jsonl") == '{"n":1}\n{"n":2}\n{"n":3}\n'


def test_two_logs_that_diverged_independently_preserve_both(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")

    alpha.write("projects/demo/s.jsonl", '{"shared":1}\n')
    alpha.sync(now=1000)
    beta.sync(now=1010)

    # Each machine appends a different record to the same session.
    alpha.write("projects/demo/s.jsonl", '{"shared":1}\n{"from":"alpha"}\n')
    beta.write("projects/demo/s.jsonl", '{"shared":1}\n{"from":"beta"}\n')
    alpha.sync(now=2000)

    report = beta.sync(now=2100)
    # Neither branch is a prefix of the other, so both survive.
    assert beta.read("projects/demo/s.jsonl") == '{"shared":1}\n{"from":"beta"}\n'
    assert len(report.conflicts) == 1
    preserved = beta.home / ".claude" / report.conflicts[0].split("/", 1)[1]
    assert preserved.read_text() == '{"shared":1}\n{"from":"alpha"}\n'


def test_an_object_whose_content_does_not_match_its_digest_is_refused(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    beta = Device(tmp_path / "beta", dav, policy_path, "device-beta")
    alpha.write("settings.json", "correct")
    alpha.sync(now=1000)

    # Corrupt the stored object without changing the address that names it.
    published = json.loads(dav.files["manifests/device-alpha.json"])
    digest = published["entries"][0]["digest"]
    dav.files[object_path(digest)] = b"tampered"

    report = beta.sync(now=1010)
    assert beta.names() == set()
    assert any("refusing to apply" in problem for problem in report.problems)


def test_one_unreadable_file_does_not_abort_the_whole_sync(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    alpha.write("settings.json", "{}")
    doomed = alpha.write("commands/vanishing.md", "here for now")
    manifest = build_manifest(alpha.policy)
    # The file disappears between the inventory pass and the upload, which is
    # ordinary for transient session files.
    doomed.unlink()

    client = WebdavClient(BASE_URL, dav.username, dav.password, dav.client())
    uploaded, _, entries, problems = publish(
        client,
        alpha.policy,
        manifest,
        alpha.state,
        device_id="device-alpha",
        device_name="alpha",
        now=1000,
    )
    client.close()
    assert uploaded == 1
    assert [entry["path"] for entry in entries] == ["claude/settings.json"]
    assert problems == []


def test_an_upload_failure_is_reported_without_losing_the_other_files(
    tmp_path: Path, dav: FakeDav, policy_path: Path
) -> None:
    alpha = Device(tmp_path / "alpha", dav, policy_path, "device-alpha")
    alpha.write("settings.json", "{}")
    alpha.write("commands/a.md", "a")

    calls = {"n": 0}
    real_put = FakeDav._put

    def flaky(self: FakeDav, relative: str, request: httpx.Request) -> httpx.Response:
        if relative.startswith("objects/"):
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(507)
        return real_put(self, relative, request)

    FakeDav._put = flaky  # type: ignore[method-assign]
    try:
        report = alpha.sync(now=1000)
    finally:
        FakeDav._put = real_put  # type: ignore[method-assign]

    assert report.uploaded == 1
    assert len(report.problems) == 1
    # The manifest advertises only what actually landed in the store.
    published = json.loads(dav.files["manifests/device-alpha.json"])
    assert len(published["entries"]) == 1


def test_read_snapshot_hashes_the_bytes_it_returns(tmp_path: Path) -> None:
    import hashlib

    path = tmp_path / "plain.txt"
    path.write_bytes(b"payload")
    snapshot = read_snapshot(path)
    assert snapshot is not None
    assert snapshot.data == b"payload"
    assert snapshot.digest == hashlib.sha256(b"payload").hexdigest()
    assert snapshot.size == 7
    assert snapshot.withheld_tail is False

    log = tmp_path / "log.jsonl"
    log.write_bytes(b'{"a":1}\n{"b":')
    partial = read_snapshot(log)
    assert partial is not None
    assert partial.data == b'{"a":1}\n'
    assert partial.withheld_tail is True
    assert partial.digest == hashlib.sha256(b'{"a":1}\n').hexdigest()

    assert read_snapshot(tmp_path / "absent.txt") is None
    log.write_bytes(b'{"never finished"')
    assert read_snapshot(log) is None


def test_read_snapshot_stays_consistent_while_a_file_is_being_appended(
    tmp_path: Path,
) -> None:
    """A file that changes under the reader still yields a matching pair."""

    import hashlib

    path = tmp_path / "busy.txt"
    path.write_bytes(b"one")
    original = Path.read_bytes

    def growing(self: Path) -> bytes:
        # Every read observes a longer file, so the stat guard never settles.
        data = original(self)
        original_path.write_bytes(data + b"!")
        return data

    original_path = path
    Path.read_bytes = growing  # type: ignore[method-assign]
    try:
        snapshot = read_snapshot(path, attempts=3)
    finally:
        Path.read_bytes = original  # type: ignore[method-assign]

    assert snapshot is not None
    # Whatever it read, the digest describes exactly those bytes.
    assert snapshot.digest == hashlib.sha256(snapshot.data).hexdigest()
    assert snapshot.size == len(snapshot.data)


def test_is_append_log_recognizes_transcripts() -> None:
    assert is_append_log("claude/projects/demo/s.jsonl") is True
    assert is_append_log("codex/sessions/a.jsonl") is True
    assert is_append_log("claude/settings.json") is False
