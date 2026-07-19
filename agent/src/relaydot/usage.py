"""Metadata-only provider usage normalization and exact price arithmetic."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass, replace
from decimal import ROUND_HALF_UP, Decimal
from typing import Any


def _integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


@dataclass(frozen=True, slots=True)
class UsageFact:
    usage_fact_id: str
    provider: str
    session_id: str
    event_id: str
    model_id: str
    input_uncached_tokens: int
    cache_write_5m_tokens: int = 0
    cache_write_1h_tokens: int = 0
    cache_write_other_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    reasoning_output_tokens: int = 0
    source_record_fingerprint: str = ""
    price_match_status: str = "assumed"
    estimated_cost_microusd: int | None = None

    def __post_init__(self) -> None:
        fields = (
            "input_uncached_tokens",
            "cache_write_5m_tokens",
            "cache_write_1h_tokens",
            "cache_write_other_tokens",
            "cache_read_tokens",
            "output_tokens",
            "reasoning_output_tokens",
        )
        for name in fields:
            _integer(getattr(self, name), name)
        if self.reasoning_output_tokens > self.output_tokens:
            raise ValueError("reasoning output must be a subset of output")

    @property
    def total_input_tokens(self) -> int:
        return (
            self.input_uncached_tokens
            + self.cache_write_5m_tokens
            + self.cache_write_1h_tokens
            + self.cache_write_other_tokens
            + self.cache_read_tokens
        )

    @property
    def total_tokens(self) -> int:
        return self.total_input_tokens + self.output_tokens


@dataclass(frozen=True, slots=True)
class ParserReport:
    facts: tuple[UsageFact, ...]
    scanned: int
    duplicates: int = 0
    malformed: int = 0
    unknown: int = 0
    cumulative_resets: int = 0


def _fact_id(provider: str, session: str, event: str) -> str:
    return hashlib.sha256(f"{provider}\x00{session}\x00{event}".encode()).hexdigest()


def parse_claude(
    records: Iterable[dict[str, Any]], *, default_session: str = "unknown"
) -> ParserReport:
    """Select the last authoritative assistant record for each response ID."""

    rows = list(records)
    selected: dict[tuple[str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
    malformed = unknown = duplicates = 0
    for row in rows:
        if not isinstance(row, dict):
            malformed += 1
            continue
        message = row.get("message")
        if not isinstance(message, dict) or message.get("role") not in (None, "assistant"):
            unknown += 1
            continue
        usage, event_id = message.get("usage"), message.get("id")
        if not isinstance(usage, dict) or not isinstance(event_id, str) or not event_id:
            unknown += 1
            continue
        session = row.get("sessionId", default_session)
        if not isinstance(session, str) or not session:
            malformed += 1
            continue
        key = (session, event_id)
        if key in selected:
            duplicates += 1
        selected[key] = (row, usage)

    facts: list[UsageFact] = []
    for (session, event_id), (row, usage) in selected.items():
        try:
            creation = usage.get("cache_creation", {})
            if creation is None:
                creation = {}
            if not isinstance(creation, dict):
                raise ValueError("cache_creation must be an object")
            write_5m = _integer(creation.get("ephemeral_5m_input_tokens", 0), "cache write 5m")
            write_1h = _integer(creation.get("ephemeral_1h_input_tokens", 0), "cache write 1h")
            fallback = _integer(usage.get("cache_creation_input_tokens", 0), "cache creation")
            write_other = 0 if creation else fallback
            message = row["message"]
            model = message.get("model", row.get("model", "unknown"))
            if not isinstance(model, str):
                raise ValueError("model must be a string")
            fingerprint = hashlib.sha256(
                _canonical({"session": session, "event": event_id, "usage": usage, "model": model})
            ).hexdigest()
            facts.append(
                UsageFact(
                    usage_fact_id=_fact_id("claude", session, event_id),
                    provider="claude",
                    session_id=session,
                    event_id=event_id,
                    model_id=model,
                    input_uncached_tokens=_integer(usage.get("input_tokens", 0), "input"),
                    cache_write_5m_tokens=write_5m,
                    cache_write_1h_tokens=write_1h,
                    cache_write_other_tokens=write_other,
                    cache_read_tokens=_integer(
                        usage.get("cache_read_input_tokens", 0), "cache read"
                    ),
                    output_tokens=_integer(usage.get("output_tokens", 0), "output"),
                    source_record_fingerprint=fingerprint,
                    price_match_status="exact" if creation or fallback == 0 else "assumed",
                )
            )
        except (KeyError, TypeError, ValueError):
            malformed += 1
    return ParserReport(
        tuple(sorted(facts, key=lambda fact: fact.usage_fact_id)),
        len(rows),
        duplicates,
        malformed,
        unknown,
    )


def _codex_payload(row: dict[str, Any]) -> dict[str, Any] | None:
    payload = row.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    info = payload.get("info", payload)
    return info if isinstance(info, dict) else None


def parse_codex(records: Iterable[dict[str, Any]], *, session_id: str = "unknown") -> ParserReport:
    rows = list(records)
    facts: list[UsageFact] = []
    seen: set[str] = set()
    malformed = unknown = duplicates = resets = 0
    previous_total: int | None = None
    for row in rows:
        if not isinstance(row, dict):
            malformed += 1
            continue
        info = _codex_payload(row)
        if info is None:
            unknown += 1
            continue
        last, cumulative = info.get("last_token_usage"), info.get("total_token_usage")
        if not isinstance(last, dict):
            unknown += 1
            continue
        try:
            input_total = _integer(last.get("input_tokens", 0), "input")
            cached = _integer(last.get("cached_input_tokens", 0), "cached input")
            cache_write = _integer(last.get("cache_write_input_tokens", 0), "cache write")
            if cached + cache_write > input_total:
                raise ValueError("input subsets exceed input total")
            output = _integer(last.get("output_tokens", 0), "output")
            reasoning = _integer(last.get("reasoning_output_tokens", 0), "reasoning")
            event = row.get("turn_id") or row.get("id") or info.get("turn_id")
            if not isinstance(event, str) or not event:
                event = hashlib.sha256(
                    _canonical({"last": last, "timestamp": row.get("timestamp")})
                ).hexdigest()
            unique = _fact_id("openai", session_id, event)
            if unique in seen:
                duplicates += 1
                continue
            seen.add(unique)
            model = row.get("model", info.get("model", "unknown"))
            if not isinstance(model, str):
                raise ValueError("model must be a string")
            facts.append(
                UsageFact(
                    usage_fact_id=unique,
                    provider="openai",
                    session_id=session_id,
                    event_id=event,
                    model_id=model,
                    input_uncached_tokens=input_total - cached - cache_write,
                    cache_write_other_tokens=cache_write,
                    cache_read_tokens=cached,
                    output_tokens=output,
                    reasoning_output_tokens=reasoning,
                    source_record_fingerprint=hashlib.sha256(
                        _canonical(
                            {"session": session_id, "event": event, "usage": last, "model": model}
                        )
                    ).hexdigest(),
                )
            )
            if isinstance(cumulative, dict):
                current = _integer(
                    cumulative.get(
                        "total_tokens",
                        cumulative.get("input_tokens", 0) + cumulative.get("output_tokens", 0),
                    ),
                    "cumulative total",
                )
                if previous_total is not None and current < previous_total:
                    resets += 1
                previous_total = current
        except (TypeError, ValueError):
            malformed += 1
    return ParserReport(tuple(facts), len(rows), duplicates, malformed, unknown, resets)


@dataclass(frozen=True, slots=True)
class PriceRates:
    input_uncached: Decimal
    cache_write_5m: Decimal = Decimal(0)
    cache_write_1h: Decimal = Decimal(0)
    cache_write_other: Decimal = Decimal(0)
    cache_read: Decimal = Decimal(0)
    output: Decimal = Decimal(0)
    multiplier: Decimal = Decimal(1)

    def __post_init__(self) -> None:
        if any(
            value < 0
            for value in (
                self.input_uncached,
                self.cache_write_5m,
                self.cache_write_1h,
                self.cache_write_other,
                self.cache_read,
                self.output,
                self.multiplier,
            )
        ):
            raise ValueError("price rates cannot be negative")


def estimate_cost_microusd(fact: UsageFact, rates: PriceRates) -> int:
    """Rates are USD/million tokens; the disjoint sum is directly micro-USD."""

    value = (
        Decimal(fact.input_uncached_tokens) * rates.input_uncached
        + Decimal(fact.cache_write_5m_tokens) * rates.cache_write_5m
        + Decimal(fact.cache_write_1h_tokens) * rates.cache_write_1h
        + Decimal(fact.cache_write_other_tokens) * rates.cache_write_other
        + Decimal(fact.cache_read_tokens) * rates.cache_read
        + Decimal(fact.output_tokens) * rates.output
    ) * rates.multiplier
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def price_fact(fact: UsageFact, rates: PriceRates, *, status: str = "exact") -> UsageFact:
    if status not in {"exact", "assumed", "override"}:
        raise ValueError("invalid priced status")
    return replace(
        fact, price_match_status=status, estimated_cost_microusd=estimate_cost_microusd(fact, rates)
    )
