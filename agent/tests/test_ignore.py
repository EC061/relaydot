from __future__ import annotations

import pytest

from relaydot.errors import PolicyError
from relaydot.ignore import IgnoreSet, parse_ignore

CURATED = """
// keep only the directories you listed
!/settings.json
!/commands
!/skills
!/plugins
!/projects

// ignore everything else (credentials, logs, caches, todos, etc.)
*
"""


@pytest.fixture
def curated() -> IgnoreSet:
    return parse_ignore(CURATED)


@pytest.mark.parametrize(
    "relative",
    [
        "settings.json",
        "commands",
        "commands/review.md",
        "skills/deep/nested/skill.md",
        "plugins/example/index.js",
        "projects/-Users-me-repo/session.jsonl",
        "projects/a/b/c/d.jsonl",
    ],
)
def test_curated_keeps_listed_subtrees(curated: IgnoreSet, relative: str) -> None:
    assert curated.keeps(relative)


@pytest.mark.parametrize(
    "relative",
    [
        ".credentials.json",
        "settings.local.json",
        "history.jsonl",
        "todos/task.json",
        "statsig/cache",
        "shell-snapshots/snapshot.sh",
        "logs/agent.log",
        "ide",
        # A sibling whose name merely starts with a kept name stays ignored.
        "projectsx/session.jsonl",
        "commandsx",
    ],
)
def test_curated_ignores_everything_else(curated: IgnoreSet, relative: str) -> None:
    assert curated.ignored(relative)


def test_first_matching_rule_wins() -> None:
    ignore = parse_ignore(["/keep/inner", "!/keep", "*"])
    # The narrower ignore precedes the negation, so it decides.
    assert ignore.ignored("keep/inner")
    assert ignore.keeps("keep/other")


def test_single_star_does_not_cross_separators() -> None:
    ignore = parse_ignore(["/*.log"])
    assert ignore.ignored("agent.log")
    assert ignore.keeps("nested/agent.log")


def test_double_star_crosses_separators() -> None:
    ignore = parse_ignore(["/**/*.log"])
    assert ignore.ignored("nested/deep/agent.log")


def test_unanchored_pattern_matches_any_depth() -> None:
    ignore = parse_ignore(["node_modules"])
    assert ignore.ignored("node_modules")
    assert ignore.ignored("a/b/node_modules")
    assert ignore.ignored("a/b/node_modules/pkg/index.js")
    assert ignore.keeps("a/b/keep.js")


def test_question_mark_matches_one_character() -> None:
    ignore = parse_ignore(["/a?.txt"])
    assert ignore.ignored("ab.txt")
    assert ignore.keeps("abc.txt")


def test_comments_and_blank_lines_are_skipped() -> None:
    ignore = parse_ignore("// comment\n\n   \n/real")
    assert len(ignore.rules) == 1
    assert ignore.ignored("real")


def test_empty_set_keeps_everything() -> None:
    ignore = parse_ignore([])
    assert not ignore
    assert ignore.keeps("anything/at/all")


def test_accepts_list_input() -> None:
    assert parse_ignore(["!/keep", "*"]).keeps("keep/file")


def test_rejects_invalid_input() -> None:
    with pytest.raises(PolicyError):
        parse_ignore(42)  # type: ignore[arg-type]
    with pytest.raises(PolicyError):
        parse_ignore(["!"])
    with pytest.raises(PolicyError):
        parse_ignore(["/"])
