"""Agent-to-agent synchronization through the shared WebDAV object store.

Files move agent -> WebDAV -> agent; the controller never carries bytes. Each
device uploads the content of every policy-selected file to
``objects/<aa>/<sha256>`` and then publishes ``manifests/<device>.json``
describing what it holds. Peers read those manifests and pull only the digests
they are missing.

Identity is the pair the user asked for: the **hash** says whether the bytes are
already in the store, so an unchanged file costs one existence check and no
upload, and the **modification time** breaks ties when two devices publish
different content for the same path.

Conversation transcripts break both of those assumptions, because a live session
appends to them the entire time a sync is running. They are handled separately:

* **Hash what you read.** An inventory pass and an upload are two different
  moments. Publishing the earlier digest beside the later bytes would store
  content at an address it does not hash to, and every peer and the controller
  would trust that address. :func:`read_snapshot` therefore hashes exactly the
  bytes it returns.
* **Publish whole records only.** An append log is cut at its last complete
  JSONL record, so a peer never receives a half-written line and the published
  digest stays stable while a writer is midway through the next record. A file
  with nothing complete yet is skipped until the next cycle.
* **Merge by prefix, not by clock.** Records are only ever appended, so whichever
  side strictly extends the other is the complete log. Using modification time
  here would let a peer with fewer records but a newer timestamp truncate a
  longer transcript.
* **Verify what you fetch.** Downloaded objects are re-hashed before they are
  applied, so a truncated upload is refused rather than written to a real home
  directory.

A file that fails on its own is reported in ``problems`` and the rest of the
sync continues; transient session files come and go constantly, and one of them
disappearing must not stop a fleet from converging.

Two safety properties come from the policy and are enforced here:

* ``deletionPolicy: archive-and-restore`` — a path missing from a peer manifest
  is never deleted locally. Absence is not a delete instruction.
* ``conflictStrategy: preserve_both_and_pause_path`` — when two versions have
  genuinely diverged, the peer copy lands beside the local one under a conflict
  name and the path is reported as paused rather than silently overwritten.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .apply import ApplyFile, atomic_apply
from .errors import StorageError
from .manifest import Manifest, ManifestEntry, sha256_file
from .policy import RootPolicy, SyncPolicy
from .streams import complete_jsonl_prefix, reconcile_streams
from .webdav import WebdavClient, manifest_path, object_path

MANIFEST_FORMAT_VERSION = 1
STATE_FORMAT_VERSION = 1


@dataclass(slots=True)
class SyncState:
    """Durable local memory of what this device has pushed and applied.

    ``uploaded`` avoids a HEAD per file per run; ``applied`` records the digest
    this device last wrote for a path, which is how a later local edit is
    distinguished from an untouched file during conflict detection.
    """

    path: Path
    uploaded: dict[str, int] = field(default_factory=dict)
    applied: dict[str, dict[str, Any]] = field(default_factory=dict)
    managed: dict[str, list[str]] = field(default_factory=dict)
    peers: dict[str, int] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> SyncState:
        expanded = path.expanduser()
        try:
            payload = json.loads(expanded.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls(expanded)
        if not isinstance(payload, dict) or payload.get("format_version") != STATE_FORMAT_VERSION:
            return cls(expanded)
        return cls(
            expanded,
            uploaded=_int_dict(payload.get("uploaded")),
            applied={
                key: value
                for key, value in _mapping(payload.get("applied")).items()
                if isinstance(value, dict)
            },
            managed={
                key: [item for item in value if isinstance(item, str)]
                for key, value in _mapping(payload.get("managed")).items()
                if isinstance(value, list)
            },
            peers=_int_dict(payload.get("peers")),
        )

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "format_version": STATE_FORMAT_VERSION,
            "uploaded": self.uploaded,
            "applied": self.applied,
            "managed": {key: sorted(set(value)) for key, value in self.managed.items()},
            "peers": self.peers,
        }
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        temporary.chmod(0o600)
        temporary.replace(self.path)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int_dict(value: Any) -> dict[str, int]:
    return {
        key: int(item) for key, item in _mapping(value).items() if isinstance(item, (int, float))
    }


@dataclass(frozen=True, slots=True)
class SyncReport:
    digest: str
    files: int
    total_bytes: int
    uploaded: int
    skipped_present: int
    peers: int
    downloaded: int
    applied: tuple[str, ...]
    conflicts: tuple[str, ...]
    unsupported: tuple[str, ...]
    #: Files that failed on their own without stopping the rest of the sync.
    problems: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "digest": self.digest,
            "files": self.files,
            "bytes": self.total_bytes,
            "uploaded": self.uploaded,
            "skipped_present": self.skipped_present,
            "peers": self.peers,
            "downloaded": self.downloaded,
            "applied": list(self.applied),
            "conflicts": list(self.conflicts),
            "unsupported": list(self.unsupported),
            "problems": list(self.problems),
        }


def _root_for(policy: SyncPolicy, manifest_path_value: str) -> tuple[RootPolicy, str] | None:
    """Split ``<root name>/<relative>`` into the declared root and remainder."""

    name, _, relative = manifest_path_value.partition("/")
    if not relative:
        return None
    for root in policy.roots:
        if root.name == name:
            return root, relative
    return None


def _local_path(policy: SyncPolicy, manifest_path_value: str) -> Path | None:
    resolved = _root_for(policy, manifest_path_value)
    if resolved is None:
        return None
    root, relative = resolved
    return root.path.joinpath(*relative.split("/"))


def _modified_at(path: Path) -> int:
    try:
        return int(path.lstat().st_mtime)
    except OSError:
        return 0


def is_append_log(path: str) -> bool:
    """Whether a synced path is an append-structured record log.

    Conversation transcripts are JSONL and are appended to continuously while a
    session runs, so they need snapshot reads and prefix-aware merging rather
    than whole-file replacement.
    """

    return path.endswith(".jsonl")


@dataclass(frozen=True, slots=True)
class Snapshot:
    """Bytes actually read, with the digest of exactly those bytes."""

    data: bytes
    digest: str
    size: int
    modified_at: int
    #: True when a partial trailing record was withheld from `data`.
    withheld_tail: bool


def read_snapshot(path: Path, *, attempts: int = 3) -> Snapshot | None:
    """Read a file and hash precisely the bytes that were read.

    Hashing during an inventory pass and reading during upload are two different
    moments, and an agent transcript is appended to between them constantly.
    Publishing the earlier digest alongside the later bytes would store content
    at an address it does not hash to, which every peer and the controller would
    then trust. So the digest here always describes this read.

    For an append log the content is cut at the last complete record: a peer
    never sees a half-written line, and the published digest stays stable while
    a writer is midway through the next record. A file with no complete record
    yet is skipped entirely rather than published empty.

    Returns None when the file cannot be read or has nothing complete to offer.
    """

    data = b""
    modified_at = 0
    for attempt in range(max(1, attempts)):
        try:
            before = path.lstat()
            data = path.read_bytes()
            after = path.lstat()
        except OSError:
            return None
        modified_at = int(after.st_mtime)
        if (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size):
            break
        # The file changed while being read. Retry for a quiet moment, but the
        # digest below still describes whatever was read, so a busy file yields
        # a consistent snapshot rather than a mismatched one.
        if attempt == attempts - 1:
            break

    withheld = False
    if is_append_log(path.as_posix()):
        complete, tail = complete_jsonl_prefix(data)
        withheld = bool(tail)
        data = complete
        if not data:
            # Nothing complete to publish yet; try again next cycle.
            return None

    return Snapshot(
        data=data,
        digest=hashlib.sha256(data).hexdigest(),
        size=len(data),
        modified_at=modified_at,
        withheld_tail=withheld,
    )


def publish(
    client: WebdavClient,
    policy: SyncPolicy,
    manifest: Manifest,
    state: SyncState,
    *,
    device_id: str,
    device_name: str,
    now: int | None = None,
) -> tuple[int, int, list[dict[str, Any]], list[str]]:
    """Upload missing blobs and publish this device's manifest.

    Returns the upload count, the count skipped because the digest was already
    in the store, the entry list that was published, and any per-file problems.
    A file that cannot be read is reported and left out of this manifest rather
    than failing the whole sync; the next cycle picks it up.
    """

    stamp = int(time.time()) if now is None else now
    uploaded = 0
    skipped = 0
    entries: list[dict[str, Any]] = []
    problems: list[str] = []

    for entry in manifest.entries:
        local = _local_path(policy, entry.path)
        if local is None:
            continue

        if entry.logical_type == "symlink":
            entries.append(
                {
                    "path": entry.path,
                    "digest": entry.digest,
                    "size": entry.size,
                    "logical_type": entry.logical_type,
                    "modified_at": _modified_at(local),
                    "link_target": entry.link_target,
                }
            )
            continue

        try:
            snapshot = read_snapshot(local)
        except OSError as exc:
            problems.append(f"{entry.path}: {exc}")
            continue
        if snapshot is None:
            # Unreadable, or an append log with no complete record yet.
            continue

        published: dict[str, Any] = {
            "path": entry.path,
            # The digest of the bytes uploaded just below, not the one the
            # inventory pass computed before this file was appended to again.
            "digest": snapshot.digest,
            "size": snapshot.size,
            "logical_type": entry.logical_type,
            "modified_at": snapshot.modified_at,
        }

        remote = object_path(snapshot.digest)
        try:
            if snapshot.digest in state.uploaded:
                skipped += 1
            elif client.exists(remote):
                # Another device already uploaded these exact bytes.
                state.uploaded[snapshot.digest] = stamp
                skipped += 1
            else:
                client.put_bytes(remote, snapshot.data)
                state.uploaded[snapshot.digest] = stamp
                uploaded += 1
        except StorageError as exc:
            problems.append(f"{entry.path}: {exc}")
            continue

        entries.append(published)
        # Publishing establishes this digest as the revision the fleet has seen
        # for the path, so a later peer revision is a clean supersede rather
        # than a conflict against content the peer already had a chance to read.
        state.applied[entry.path] = {
            "digest": snapshot.digest,
            "modified_at": snapshot.modified_at,
            "device": device_id,
        }

    document = {
        "format_version": MANIFEST_FORMAT_VERSION,
        "device_id": device_id,
        "device_name": device_name,
        "generated_at": stamp,
        "policy": policy.name,
        "manifest_digest": manifest.digest,
        "entries": entries,
    }
    client.put_bytes(
        manifest_path(device_id),
        json.dumps(document, sort_keys=True, separators=(",", ":")).encode(),
    )
    return uploaded, skipped, entries, problems


def _read_peer_manifests(client: WebdavClient, device_id: str) -> list[dict[str, Any]]:
    manifests: list[dict[str, Any]] = []
    for item in client.list("manifests", "1"):
        if item.is_directory or not item.name.endswith(".json"):
            continue
        if item.name == f"{device_id}.json":
            continue
        raw = client.get_bytes(item.href)
        if raw is None:
            continue
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise StorageError(f"peer manifest {item.name} is not readable JSON") from exc
        if isinstance(payload, dict) and isinstance(payload.get("entries"), list):
            manifests.append(payload)
    return manifests


@dataclass(frozen=True, slots=True)
class _Candidate:
    path: str
    digest: str
    modified_at: int
    device: str


def _winners(manifests: list[dict[str, Any]], policy: SyncPolicy) -> dict[str, _Candidate]:
    """Pick one peer version per path: newest modification time, digest breaks ties."""

    best: dict[str, _Candidate] = {}
    for payload in manifests:
        device = str(payload.get("device_id", "unknown"))
        for raw in payload["entries"]:
            if not isinstance(raw, dict):
                continue
            path = raw.get("path")
            digest = raw.get("digest")
            if not isinstance(path, str) or not isinstance(digest, str):
                continue
            if raw.get("logical_type", "file") != "file":
                continue
            resolved = _root_for(policy, path)
            # Never accept a path this device's own policy would not sync.
            if resolved is None or not resolved[0].includes(resolved[1]):
                continue
            candidate = _Candidate(path, digest, int(raw.get("modified_at", 0) or 0), device)
            current = best.get(path)
            if current is None or (candidate.modified_at, candidate.digest) > (
                current.modified_at,
                current.digest,
            ):
                best[path] = candidate
    return best


def _fetch_verified(client: WebdavClient, digest: str) -> bytes | None:
    """Fetch an object and confirm it hashes to the digest that named it.

    Content addressing is only a guarantee if it is checked. A truncated upload,
    a proxy that rewrote a body, or a peer that published one digest and stored
    different bytes would otherwise be applied to a real home directory.
    """

    content = client.get_bytes(object_path(digest))
    if content is None:
        return None
    actual = hashlib.sha256(content).hexdigest()
    if actual != digest:
        raise StorageError(f"object {digest[:12]} hashes to {actual[:12]}; refusing to apply it")
    return content


def _conflict_name(relative: str, device: str, stamp: int) -> str:
    parent, _, name = relative.rpartition("/")
    marker = f"{name}.relaydot-conflict-{device[:8]}-{stamp}"
    return f"{parent}/{marker}" if parent else marker


def pull(
    client: WebdavClient,
    policy: SyncPolicy,
    manifest: Manifest,
    state: SyncState,
    *,
    device_id: str,
    now: int | None = None,
    baseline: dict[str, dict[str, Any]] | None = None,
) -> tuple[int, int, list[str], list[str], list[str]]:
    """Fetch and apply peer content.

    Returns peers, downloads, applied paths, conflicts, and per-file problems.

    ``baseline`` is the known-revision map as it stood *before* this run's
    publish. It has to be a snapshot: publishing records the local digest as the
    fleet-visible revision, and reading that back here would make every local
    edit look reconciled and quietly defeat conflict detection.
    """

    stamp = int(time.time()) if now is None else now
    known = state.applied if baseline is None else baseline
    manifests = _read_peer_manifests(client, device_id)
    local = manifest.by_path()

    planned: dict[str, list[ApplyFile]] = {}
    applied: list[str] = []
    conflicts: list[str] = []
    problems: list[str] = []
    downloaded = 0

    for path, candidate in sorted(_winners(manifests, policy).items()):
        resolved = _root_for(policy, path)
        if resolved is None:
            continue
        root, relative = resolved
        live = root.path.joinpath(*relative.split("/"))
        current: ManifestEntry | None = local.get(path)

        # An append log is compared on its complete-record prefix, which is what
        # peers publish, not on the whole-file digest the inventory pass took.
        ours: bytes | None = None
        local_digest: str | None = None if current is None else current.digest
        local_mtime = 0 if current is None else _modified_at(live)
        if current is not None and is_append_log(path):
            snapshot = read_snapshot(live)
            if snapshot is not None:
                ours, local_digest, local_mtime = (
                    snapshot.data,
                    snapshot.digest,
                    snapshot.modified_at,
                )

        if local_digest == candidate.digest:
            continue

        decision: str
        if current is None:
            decision = "take"
        elif is_append_log(path) and ours is not None:
            # Records only ever get appended, so a prefix relationship settles
            # it without consulting the clock: whichever side strictly extends
            # the other is the complete log. Comparing modification times here
            # would let a peer with fewer records but a newer mtime overwrite a
            # longer transcript.
            try:
                theirs = _fetch_verified(client, candidate.digest)
            except StorageError as exc:
                problems.append(f"{path}: {exc}")
                continue
            if theirs is None:
                continue
            downloaded += 1
            merged, relation = reconcile_streams(ours, theirs)
            if relation in ("identical", "ours-extends"):
                # Nothing to write; our longer log wins on the next publish.
                continue
            decision = "take" if merged is not None else "conflict"
            if decision == "take":
                planned.setdefault(root.name, []).append(ApplyFile(relative, theirs))
                applied.append(path)
                state.applied[path] = {
                    "digest": candidate.digest,
                    "modified_at": candidate.modified_at,
                    "device": candidate.device,
                }
            else:
                target = _conflict_name(relative, candidate.device, stamp)
                planned.setdefault(root.name, []).append(ApplyFile(target, theirs))
                conflicts.append(f"{root.name}/{target}")
            continue
        else:
            # Whole-file content: the date decides. A local file at least as new
            # as the peer's stays put and wins on the next publish instead.
            if candidate.modified_at <= local_mtime:
                continue
            # The baseline holds the revision this device last published or
            # applied for the path. Local content that still matches it was
            # never edited here, so a newer peer revision supersedes it cleanly;
            # content that no longer matches diverged independently.
            last = known.get(path)
            decision = "conflict" if last is None or last.get("digest") != local_digest else "take"

        try:
            content = _fetch_verified(client, candidate.digest)
        except StorageError as exc:
            problems.append(f"{path}: {exc}")
            continue
        if content is None:
            # The peer published a digest it never uploaded; skip rather than
            # write a truncated file.
            continue
        downloaded += 1

        target = (
            _conflict_name(relative, candidate.device, stamp)
            if decision == "conflict"
            else relative
        )
        planned.setdefault(root.name, []).append(ApplyFile(target, content))
        if decision == "conflict":
            conflicts.append(f"{root.name}/{target}")
        else:
            applied.append(path)
            state.applied[path] = {
                "digest": candidate.digest,
                "modified_at": candidate.modified_at,
                "device": candidate.device,
            }

    for root_name, files in planned.items():
        root = policy.root(root_name)
        root.path.mkdir(parents=True, exist_ok=True)
        # `previously_managed` gates deletion only; this apply never deletes,
        # but the set is kept accurate so a future managed delete stays safe.
        atomic_apply(
            root.path,
            files,
            previously_managed=frozenset(state.managed.get(root_name, ())),
            keep_backup=True,
        )
        state.managed[root_name] = sorted(
            set(state.managed.get(root_name, ())) | {item.path for item in files}
        )

    for payload in manifests:
        state.peers[str(payload.get("device_id", "unknown"))] = int(
            payload.get("generated_at", 0) or 0
        )
    return len(manifests), downloaded, applied, conflicts, problems


def run_sync(
    client: WebdavClient,
    policy: SyncPolicy,
    manifest: Manifest,
    state: SyncState,
    *,
    device_id: str,
    device_name: str,
    now: int | None = None,
) -> SyncReport:
    """Push this device's content, then pull whatever peers have that it lacks."""

    client.ensure_collection("objects")
    client.ensure_collection("manifests")
    baseline = {path: dict(value) for path, value in state.applied.items()}
    uploaded, skipped, _, push_problems = publish(
        client,
        policy,
        manifest,
        state,
        device_id=device_id,
        device_name=device_name,
        now=now,
    )
    peers, downloaded, applied, conflicts, pull_problems = pull(
        client, policy, manifest, state, device_id=device_id, now=now, baseline=baseline
    )
    # Saved even when individual files failed, so work that did succeed is not
    # repeated on the next cycle.
    state.save()
    unsupported = tuple(entry.path for entry in manifest.entries if entry.logical_type != "file")
    return SyncReport(
        digest=manifest.digest,
        files=len(manifest.entries),
        total_bytes=sum(entry.size for entry in manifest.entries),
        uploaded=uploaded,
        skipped_present=skipped,
        peers=peers,
        downloaded=downloaded,
        applied=tuple(applied),
        conflicts=tuple(conflicts),
        unsupported=unsupported,
        problems=tuple(push_problems + pull_problems),
    )


@dataclass(frozen=True, slots=True)
class LocalDiff:
    added: tuple[str, ...]
    changed: tuple[str, ...]
    removed: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "added": list(self.added),
            "changed": list(self.changed),
            "removed": list(self.removed),
        }


def diff_against_state(manifest: Manifest, state: SyncState) -> LocalDiff:
    """Compare the current inventory to what this device last applied.

    `added` never synced, `changed` edited locally since the last apply, and
    `removed` applied earlier but gone now. Removals are reported, not
    propagated, because the policy archives deletions instead.
    """

    current = {entry.path: entry.digest for entry in manifest.entries}
    known = state.applied
    return LocalDiff(
        added=tuple(sorted(path for path in current if path not in known)),
        changed=tuple(
            sorted(
                path
                for path, digest in current.items()
                if path in known and known[path].get("digest") != digest
            )
        ),
        removed=tuple(sorted(path for path in known if path not in current)),
    )


def verify_object(path: Path, digest: str) -> bool:
    """Confirm a local file still hashes to the digest recorded for it."""

    if not path.is_file() or path.is_symlink():
        return False
    return sha256_file(path) == digest


def default_state_path(credential_path: Path) -> Path:
    """Sync state lives beside the credential file it belongs to."""

    return credential_path.expanduser().with_name("sync-state.json")


__all__ = [
    "LocalDiff",
    "SyncReport",
    "SyncState",
    "default_state_path",
    "diff_against_state",
    "publish",
    "pull",
    "run_sync",
    "verify_object",
]
