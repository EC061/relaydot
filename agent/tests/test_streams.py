from __future__ import annotations

import json

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relaydot.streams import (
    StreamChange,
    StreamCursor,
    complete_jsonl_prefix,
    reconcile_streams,
    segment_appended_bytes,
    validate_jsonl,
)


@pytest.mark.parametrize(
    ("previous", "current", "expected", "epoch"),
    [
        (b"abc", b"abc", StreamChange.UNCHANGED, 4),
        (b"abc", b"abcdef", StreamChange.APPENDED, 4),
        (b"abcdef", b"abc", StreamChange.TRUNCATED, 5),
        (b"abc", b"axc", StreamChange.REWRITTEN, 5),
    ],
)
def test_cursor_change_and_epoch(
    previous: bytes, current: bytes, expected: StreamChange, epoch: int
) -> None:
    cursor = StreamCursor.from_bytes(previous, epoch=4)
    change, advanced = cursor.advance(previous, current)
    assert change == expected
    assert advanced.epoch == epoch
    assert advanced.length == len(current)


def test_cursor_rejects_wrong_previous_bytes() -> None:
    cursor = StreamCursor.from_bytes(b"expected")
    with pytest.raises(ValueError, match="do not match"):
        cursor.classify(b"wrong", b"new")


@pytest.mark.parametrize(
    ("data", "complete", "tail"),
    [
        (b"", b"", b""),
        (b"partial", b"", b"partial"),
        (b"{}\n", b"{}\n", b""),
        (b"{}\npar", b"{}\n", b"par"),
    ],
)
def test_complete_jsonl_prefix(data: bytes, complete: bytes, tail: bytes) -> None:
    assert complete_jsonl_prefix(data) == (complete, tail)


def test_validate_jsonl_objects_and_blanks() -> None:
    assert validate_jsonl(b'{"a":1}\n\n{"b":2}\n') == ({"a": 1}, {"b": 2})


@pytest.mark.parametrize("data", [b'{"a":', b"[]\n", b"not-json\n", b'"text"\n'])
def test_validate_jsonl_rejects_incomplete_malformed_or_nonobject(data: bytes) -> None:
    with pytest.raises(ValueError):
        validate_jsonl(data)


def test_segmentation_respects_lines_offsets_and_ids() -> None:
    data = b'{"one":1}\n{"two":2}\n{"three":3}\npartial'
    segments, tail = segment_appended_bytes(data, start=100, max_bytes=15)
    assert b"".join(item.data for item in segments) == data[: -len(b"partial")]
    assert tail == b"partial"
    assert segments[0].start == 100
    assert segments[-1].end == 100 + len(data) - len(tail)
    assert all(item.data.endswith(b"\n") for item in segments)
    assert all(len(item.segment_id) == 64 for item in segments)


def test_single_oversize_record_stays_whole() -> None:
    data = json.dumps({"large": "x" * 100}).encode() + b"\n"
    segments, tail = segment_appended_bytes(data, max_bytes=10)
    assert len(segments) == 1
    assert segments[0].data == data
    assert not tail


@pytest.mark.parametrize(("start", "size"), [(-1, 1), (0, 0), (0, -1)])
def test_segmentation_validates_arguments(start: int, size: int) -> None:
    with pytest.raises(ValueError):
        segment_appended_bytes(b"{}\n", start=start, max_bytes=size)


@pytest.mark.parametrize(
    ("ours", "theirs", "value", "status"),
    [
        (b"a", b"a", b"a", "identical"),
        (b"abc", b"a", b"abc", "ours-extends"),
        (b"a", b"abc", b"abc", "theirs-extends"),
        (b"ab", b"ac", None, "divergent"),
    ],
)
def test_stream_reconciliation(
    ours: bytes, theirs: bytes, value: bytes | None, status: str
) -> None:
    assert reconcile_streams(ours, theirs) == (value, status)


@given(st.binary(max_size=200), st.binary(max_size=100))
def test_any_true_append_is_never_classified_as_rewrite(prefix: bytes, suffix: bytes) -> None:
    cursor = StreamCursor.from_bytes(prefix)
    expected = StreamChange.UNCHANGED if not suffix else StreamChange.APPENDED
    assert cursor.classify(prefix, prefix + suffix) == expected
