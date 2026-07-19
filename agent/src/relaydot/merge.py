"""Deterministic three-way semantic and text merging."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any

_MISSING = object()


@dataclass(frozen=True, slots=True)
class MergeConflict:
    path: tuple[str, ...]
    base: Any
    ours: Any
    theirs: Any
    kind: str = "divergent-edit"


@dataclass(frozen=True, slots=True)
class MergeResult:
    value: Any | None
    conflicts: tuple[MergeConflict, ...]

    @property
    def clean(self) -> bool:
        return not self.conflicts


def _public(value: Any) -> Any:
    return None if value is _MISSING else copy.deepcopy(value)


def _merge(
    base: Any, ours: Any, theirs: Any, path: tuple[str, ...]
) -> tuple[Any, list[MergeConflict]]:
    if ours == theirs:
        return copy.deepcopy(ours), []
    if ours == base:
        return copy.deepcopy(theirs), []
    if theirs == base:
        return copy.deepcopy(ours), []
    present = (base is not _MISSING, ours is not _MISSING, theirs is not _MISSING)
    if not all(present):
        kind = "delete-modify" if base is not _MISSING else "concurrent-add"
        return _MISSING, [MergeConflict(path, _public(base), _public(ours), _public(theirs), kind)]
    if isinstance(base, dict) and isinstance(ours, dict) and isinstance(theirs, dict):
        merged: dict[str, Any] = {}
        conflicts: list[MergeConflict] = []
        for key in sorted(base.keys() | ours.keys() | theirs.keys()):
            value, nested = _merge(
                base.get(key, _MISSING),
                ours.get(key, _MISSING),
                theirs.get(key, _MISSING),
                (*path, key),
            )
            if value is not _MISSING:
                merged[key] = value
            conflicts.extend(nested)
        return merged, conflicts
    return _MISSING, [MergeConflict(path, _public(base), _public(ours), _public(theirs))]


def merge_values(base: Any, ours: Any, theirs: Any) -> MergeResult:
    value, conflicts = _merge(base, ours, theirs, ())
    return MergeResult(None if value is _MISSING else value, tuple(conflicts))


def merge_json(base: str, ours: str, theirs: str) -> MergeResult:
    """Parse JSON and merge objects without ever producing conflict markers."""

    parsed = [json.loads(value) for value in (base, ours, theirs)]
    result = merge_values(*parsed)
    if not result.clean:
        return result
    return MergeResult(json.dumps(result.value, sort_keys=True, indent=2) + "\n", ())


def merge_text(base: str, ours: str, theirs: str) -> MergeResult:
    """Merge equal-position line edits and independent trailing appends.

    More complex insert/delete overlaps intentionally become conflicts rather than
    relying on conflict markers or a lossy heuristic.
    """

    if ours == theirs:
        return MergeResult(ours, ())
    if ours == base:
        return MergeResult(theirs, ())
    if theirs == base:
        return MergeResult(ours, ())
    base_lines, our_lines, their_lines = (
        base.splitlines(keepends=True),
        ours.splitlines(keepends=True),
        theirs.splitlines(keepends=True),
    )
    common = len(base_lines)
    if len(our_lines) < common or len(their_lines) < common:
        return MergeResult(None, (MergeConflict((), base, ours, theirs, "overlapping-text-edit"),))
    merged: list[str] = []
    for index in range(common):
        line_result = merge_values(base_lines[index], our_lines[index], their_lines[index])
        if not line_result.clean:
            return MergeResult(
                None,
                (
                    MergeConflict(
                        (str(index + 1),),
                        base_lines[index],
                        our_lines[index],
                        their_lines[index],
                        "overlapping-text-edit",
                    ),
                ),
            )
        merged.append(str(line_result.value))
    our_append, their_append = our_lines[common:], their_lines[common:]
    if our_append == their_append:
        merged.extend(our_append)
    else:
        merged.extend(our_append)
        merged.extend(their_append)
    return MergeResult("".join(merged), ())
