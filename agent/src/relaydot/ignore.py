"""Syncthing-compatible ignore patterns.

Rules are evaluated in order and the first match decides, so a negation such as
``!/projects`` placed above a catch-all ``*`` keeps that subtree while
everything else is ignored. A pattern that matches a directory also matches
everything beneath it, which is what lets ``!/projects`` retain nested session
files without listing them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .errors import PolicyError

_COMMENT = "//"


@dataclass(frozen=True, slots=True)
class IgnoreRule:
    pattern: str
    negated: bool
    matcher: re.Pattern[str]

    def matches(self, relative: str) -> bool:
        return self.matcher.match(relative) is not None


def _translate(pattern: str) -> re.Pattern[str]:
    """Compile one pattern, treating ``*`` as segment-local and ``**`` as deep."""

    anchored = pattern.startswith("/")
    body = pattern[1:] if anchored else pattern
    body = body.rstrip("/")
    if not body:
        raise PolicyError(f"empty ignore pattern: {pattern!r}")

    parts: list[str] = []
    index = 0
    while index < len(body):
        char = body[index]
        if char == "*":
            if body[index : index + 2] == "**":
                parts.append(".*")
                index += 2
                continue
            parts.append("[^/]*")
            index += 1
            continue
        if char == "?":
            parts.append("[^/]")
            index += 1
            continue
        parts.append(re.escape(char))
        index += 1

    # Unanchored patterns match a name at any depth, matching Syncthing.
    prefix = "^" if anchored else r"^(?:.*/)?"
    # The trailing group makes a directory match cover its whole subtree.
    return re.compile(prefix + "".join(parts) + r"(?:/.*)?$")


def parse_ignore(lines: object) -> IgnoreSet:
    if isinstance(lines, str):
        raw = lines.splitlines()
    elif isinstance(lines, (list, tuple)):
        raw = [str(item) for item in lines]
    else:
        raise PolicyError("ignore patterns must be a string or string list")

    rules: list[IgnoreRule] = []
    for line in raw:
        text = line.strip()
        if not text or text.startswith(_COMMENT):
            continue
        negated = text.startswith("!")
        if negated:
            text = text[1:].strip()
        if not text:
            raise PolicyError("ignore negation requires a pattern")
        rules.append(IgnoreRule(text, negated, _translate(text)))
    return IgnoreSet(tuple(rules))


@dataclass(frozen=True, slots=True)
class IgnoreSet:
    rules: tuple[IgnoreRule, ...]

    def __bool__(self) -> bool:
        return bool(self.rules)

    def ignored(self, relative: str) -> bool:
        """First matching rule decides; unmatched paths are kept."""

        subject = relative.strip("/")
        for rule in self.rules:
            if rule.matches(subject):
                return not rule.negated
        return False

    def keeps(self, relative: str) -> bool:
        return not self.ignored(relative)


#: Shared empty set, so roots without ignore rules fall back to include globs.
NO_IGNORES = IgnoreSet(())
