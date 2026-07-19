"""Append-aware conversation stream primitives."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class StreamChange(StrEnum):
    UNCHANGED = "unchanged"
    APPENDED = "appended"
    TRUNCATED = "truncated"
    REWRITTEN = "rewritten"


@dataclass(frozen=True, slots=True)
class StreamCursor:
    length: int
    digest: str
    epoch: int = 0

    @classmethod
    def from_bytes(cls, data: bytes, *, epoch: int = 0) -> StreamCursor:
        return cls(len(data), hashlib.sha256(data).hexdigest(), epoch)

    def classify(self, previous_bytes: bytes, current: bytes) -> StreamChange:
        if (
            len(previous_bytes) != self.length
            or hashlib.sha256(previous_bytes).hexdigest() != self.digest
        ):
            raise ValueError("previous bytes do not match cursor")
        if current == previous_bytes:
            return StreamChange.UNCHANGED
        if current.startswith(previous_bytes):
            return StreamChange.APPENDED
        if previous_bytes.startswith(current):
            return StreamChange.TRUNCATED
        return StreamChange.REWRITTEN

    def advance(self, previous_bytes: bytes, current: bytes) -> tuple[StreamChange, StreamCursor]:
        change = self.classify(previous_bytes, current)
        epoch = self.epoch + (change in (StreamChange.TRUNCATED, StreamChange.REWRITTEN))
        return change, StreamCursor.from_bytes(current, epoch=epoch)


@dataclass(frozen=True, slots=True)
class Segment:
    segment_id: str
    data: bytes
    start: int
    end: int


def complete_jsonl_prefix(data: bytes) -> tuple[bytes, bytes]:
    """Split complete newline-terminated records from an incomplete tail."""

    boundary = data.rfind(b"\n")
    if boundary < 0:
        return b"", data
    return data[: boundary + 1], data[boundary + 1 :]


def validate_jsonl(data: bytes) -> tuple[dict[str, Any], ...]:
    complete, tail = complete_jsonl_prefix(data)
    if tail:
        raise ValueError("JSONL ends with an incomplete record")
    records: list[dict[str, Any]] = []
    for number, raw in enumerate(complete.splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"malformed JSONL record {number}") from exc
        if not isinstance(value, dict):
            raise ValueError(f"JSONL record {number} is not an object")
        records.append(value)
    return tuple(records)


def segment_appended_bytes(
    data: bytes, *, start: int = 0, max_bytes: int = 1024 * 1024
) -> tuple[tuple[Segment, ...], bytes]:
    """Create content-addressed segments ending only at record boundaries."""

    if start < 0 or max_bytes <= 0:
        raise ValueError("start and max_bytes must be positive")
    complete, tail = complete_jsonl_prefix(data)
    segments: list[Segment] = []
    offset = 0
    while offset < len(complete):
        tentative = min(offset + max_bytes, len(complete))
        if tentative < len(complete):
            boundary = complete.rfind(b"\n", offset, tentative + 1)
            if boundary < offset:
                boundary = complete.find(b"\n", tentative)
                if boundary < 0:
                    break
            end = boundary + 1
        else:
            end = len(complete)
        chunk = complete[offset:end]
        segments.append(
            Segment(hashlib.sha256(chunk).hexdigest(), chunk, start + offset, start + end)
        )
        offset = end
    return tuple(segments), tail


def reconcile_streams(ours: bytes, theirs: bytes) -> tuple[bytes | None, str]:
    """Use a strict-prefix fast path and preserve divergent branches."""

    if ours == theirs:
        return ours, "identical"
    if ours.startswith(theirs):
        return ours, "ours-extends"
    if theirs.startswith(ours):
        return theirs, "theirs-extends"
    return None, "divergent"
