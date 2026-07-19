from __future__ import annotations

import json

import pytest

from relaydot.merge import merge_json, merge_text, merge_values


@pytest.mark.parametrize(
    ("base", "ours", "theirs", "expected"),
    [
        (1, 1, 2, 2),
        (1, 2, 1, 2),
        (1, 2, 2, 2),
        ({"a": 1}, {"a": 1, "b": 2}, {"a": 1, "c": 3}, {"a": 1, "b": 2, "c": 3}),
        (
            {"x": {"a": 1, "b": 1}},
            {"x": {"a": 2, "b": 1}},
            {"x": {"a": 1, "b": 3}},
            {"x": {"a": 2, "b": 3}},
        ),
    ],
)
def test_clean_semantic_merges(
    base: object, ours: object, theirs: object, expected: object
) -> None:
    result = merge_values(base, ours, theirs)
    assert result.clean
    assert result.value == expected


def test_same_key_edit_conflicts_with_precise_path() -> None:
    result = merge_values(
        {"outer": {"key": "base"}}, {"outer": {"key": "ours"}}, {"outer": {"key": "theirs"}}
    )
    assert not result.clean
    assert result.conflicts[0].path == ("outer", "key")
    assert result.conflicts[0].kind == "divergent-edit"
    assert result.value == {"outer": {}}


@pytest.mark.parametrize(
    ("base", "ours", "theirs", "kind"),
    [
        ({"a": 1}, {}, {"a": 2}, "delete-modify"),
        ({"a": 1}, {"a": 2}, {}, "delete-modify"),
        ({}, {"a": 1}, {"a": 2}, "concurrent-add"),
        ([1], [1, 2], [1, 3], "divergent-edit"),
    ],
)
def test_conflicting_semantic_merges(base: object, ours: object, theirs: object, kind: str) -> None:
    result = merge_values(base, ours, theirs)
    assert not result.clean
    assert result.conflicts[0].kind == kind


def test_merge_does_not_alias_inputs() -> None:
    ours = {"a": [1]}
    result = merge_values({}, ours, {})
    assert result.value == ours
    result.value["a"].append(2)
    assert ours == {"a": [1]}


def test_json_merge_is_deterministic_and_formatted() -> None:
    result = merge_json('{"a":1}', '{"a":1,"b":2}', '{"a":1,"c":3}')
    assert result.clean
    assert json.loads(result.value) == {"a": 1, "b": 2, "c": 3}
    assert result.value.endswith("\n")
    assert result.value.index('"b"') < result.value.index('"c"')


def test_json_parse_error_propagates() -> None:
    with pytest.raises(json.JSONDecodeError):
        merge_json("{}", "{", "{}")


def test_json_conflict_remains_structured() -> None:
    result = merge_json('{"a": 1}', '{"a": 2}', '{"a": 3}')
    assert not result.clean
    assert result.conflicts[0].path == ("a",)
    assert result.value == {}


@pytest.mark.parametrize(
    ("base", "ours", "theirs", "expected"),
    [
        ("base\n", "ours\n", "base\n", "ours\n"),
        ("base\n", "base\n", "theirs\n", "theirs\n"),
        ("base\n", "same\n", "same\n", "same\n"),
        ("a\nb\n", "A\nb\n", "a\nB\n", "A\nB\n"),
        ("a\n", "a\nours\n", "a\ntheirs\n", "a\nours\ntheirs\n"),
    ],
)
def test_clean_text_merges(base: str, ours: str, theirs: str, expected: str) -> None:
    result = merge_text(base, ours, theirs)
    assert result.clean
    assert result.value == expected
    assert "<<<<<<<" not in result.value


@pytest.mark.parametrize(
    ("base", "ours", "theirs"),
    [("base\n", "ours\n", "theirs\n"), ("a\nb\n", "a\n", "a\nB\n")],
)
def test_text_overlap_is_a_conflict_without_markers(base: str, ours: str, theirs: str) -> None:
    result = merge_text(base, ours, theirs)
    assert not result.clean
    assert result.value is None
    assert result.conflicts[0].kind == "overlapping-text-edit"
