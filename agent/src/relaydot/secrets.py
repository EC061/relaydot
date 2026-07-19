"""Report-only secret heuristics used during inventory."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SecretFinding:
    kind: str
    start: int
    end: int


_PATTERNS = {
    "private-key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "openai-key": re.compile(rb"\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
    "anthropic-key": re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
    "github-token": re.compile(rb"\bgh[ps]_[A-Za-z0-9]{20,}\b"),
    "aws-access-key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
}


def scan_bytes(data: bytes, *, max_bytes: int = 2_000_000) -> tuple[SecretFinding, ...]:
    """Return locations and categories without retaining the matching secret."""

    sample = data[:max_bytes]
    findings = [
        SecretFinding(kind, match.start(), match.end())
        for kind, pattern in _PATTERNS.items()
        for match in pattern.finditer(sample)
    ]
    return tuple(sorted(findings, key=lambda item: (item.start, item.kind)))
