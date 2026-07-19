from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relaydot.usage import (
    PriceRates,
    UsageFact,
    estimate_cost_microusd,
    parse_claude,
    parse_codex,
    price_fact,
)


def claude_row(event: str = "msg_1", **usage: int) -> dict:
    return {
        "sessionId": "session",
        "message": {"id": event, "role": "assistant", "model": "claude-test", "usage": usage},
    }


def test_claude_normalizes_disjoint_categories_and_totals() -> None:
    report = parse_claude(
        [
            claude_row(
                input_tokens=10,
                cache_read_input_tokens=20,
                output_tokens=5,
                cache_creation_input_tokens=7,
                cache_creation={"ephemeral_5m_input_tokens": 3, "ephemeral_1h_input_tokens": 4},
            )
        ]
    )
    fact = report.facts[0]
    assert (
        fact.input_uncached_tokens,
        fact.cache_write_5m_tokens,
        fact.cache_write_1h_tokens,
        fact.cache_write_other_tokens,
        fact.cache_read_tokens,
        fact.output_tokens,
    ) == (10, 3, 4, 0, 20, 5)
    assert fact.total_input_tokens == 37
    assert fact.total_tokens == 42
    assert fact.price_match_status == "exact"


def test_claude_fallback_cache_write_is_assumed() -> None:
    fact = parse_claude(
        [
            claude_row(
                input_tokens=1,
                cache_creation_input_tokens=9,
                cache_read_input_tokens=2,
                output_tokens=3,
            )
        ]
    ).facts[0]
    assert fact.cache_write_other_tokens == 9
    assert fact.price_match_status == "assumed"


def test_claude_last_duplicate_is_authoritative_not_summed() -> None:
    first = claude_row(input_tokens=1, output_tokens=1)
    final = claude_row(input_tokens=10, output_tokens=2)
    report = parse_claude([first, final])
    assert report.duplicates == 1
    assert len(report.facts) == 1
    assert report.facts[0].total_tokens == 12


def test_claude_fact_identity_stable_and_session_specific() -> None:
    row = claude_row(input_tokens=1, output_tokens=1)
    first = parse_claude([row]).facts[0]
    second = parse_claude([row]).facts[0]
    changed = parse_claude([{**row, "sessionId": "other"}]).facts[0]
    assert first.usage_fact_id == second.usage_fact_id
    assert first.source_record_fingerprint == second.source_record_fingerprint
    assert first.usage_fact_id != changed.usage_fact_id


def test_claude_health_counts_unknown_and_malformed() -> None:
    report = parse_claude(
        [
            {"message": {"role": "user"}},
            {"message": {"id": "x", "usage": {"input_tokens": -1}}},
            {"message": {"id": "x", "usage": {}, "role": "assistant"}, "sessionId": 4},
        ]
    )
    assert report.scanned == 3
    assert report.unknown == 1
    assert report.malformed == 2
    assert not report.facts


def test_claude_handles_runtime_schema_type_failures() -> None:
    report = parse_claude(  # type: ignore[arg-type]
        [
            "not-an-object",
            claude_row(input_tokens=1, output_tokens=1, cache_creation=None),
            claude_row(event="bad-cache", input_tokens=1, cache_creation="invalid"),
            {
                "sessionId": "s",
                "message": {"id": "bad-model", "usage": {}, "model": 42},
            },
        ]
    )
    assert report.scanned == 4
    assert len(report.facts) == 1
    assert report.malformed == 3


def codex_row(
    event: str = "turn-1",
    *,
    input_tokens: int = 100,
    cached: int = 40,
    write: int = 10,
    output: int = 20,
    reasoning: int = 5,
    cumulative: int = 120,
) -> dict:
    return {
        "id": event,
        "model": "gpt-test",
        "payload": {
            "type": "token_count",
            "info": {
                "last_token_usage": {
                    "input_tokens": input_tokens,
                    "cached_input_tokens": cached,
                    "cache_write_input_tokens": write,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                },
                "total_token_usage": {"total_tokens": cumulative},
            },
        },
    }


def test_codex_counts_last_usage_once_and_subtracts_input_subsets() -> None:
    fact = parse_codex([codex_row()], session_id="session").facts[0]
    assert fact.input_uncached_tokens == 50
    assert fact.cache_read_tokens == 40
    assert fact.cache_write_other_tokens == 10
    assert fact.output_tokens == 20
    assert fact.reasoning_output_tokens == 5
    assert fact.total_tokens == 120


def test_codex_deduplicates_event_ids_and_detects_cumulative_reset() -> None:
    report = parse_codex(
        [
            codex_row("a", cumulative=100),
            codex_row("a", cumulative=100),
            codex_row("b", cumulative=10),
        ],
        session_id="s",
    )
    assert len(report.facts) == 2
    assert report.duplicates == 1
    assert report.cumulative_resets == 1


def test_codex_health_unknown_and_malformed() -> None:
    report = parse_codex(
        [
            {"payload": {"type": "other"}},
            {"payload": {"type": "token_count", "info": {}}},
            codex_row(input_tokens=1, cached=2),
            codex_row(event="bad-reason", reasoning=30, output=20),
        ]
    )
    assert report.unknown == 2
    assert report.malformed == 2
    assert not report.facts


def test_codex_handles_missing_identity_and_runtime_schema_types() -> None:
    without_id = codex_row()
    without_id.pop("id")
    without_id["timestamp"] = "2026-01-01T00:00:00Z"
    invalid_model = codex_row("invalid-model")
    invalid_model["model"] = 42
    report = parse_codex(  # type: ignore[arg-type]
        ["not-an-object", without_id, invalid_model], session_id="s"
    )
    assert report.scanned == 3
    assert len(report.facts) == 1
    assert len(report.facts[0].event_id) == 64
    assert report.malformed == 2


def test_codex_does_not_add_reasoning_twice() -> None:
    fact = parse_codex(
        [codex_row(input_tokens=10, cached=0, write=0, output=8, reasoning=7)]
    ).facts[0]
    assert fact.total_tokens == 18


@pytest.mark.parametrize("field", ["input_uncached_tokens", "cache_read_tokens", "output_tokens"])
def test_usage_fact_rejects_negative_counts(field: str) -> None:
    values = {
        "usage_fact_id": "x",
        "provider": "x",
        "session_id": "s",
        "event_id": "e",
        "model_id": "m",
        "input_uncached_tokens": 0,
        field: -1,
    }
    with pytest.raises(ValueError, match="nonnegative"):
        UsageFact(**values)


def test_usage_fact_rejects_reasoning_larger_than_output() -> None:
    with pytest.raises(ValueError, match="subset"):
        UsageFact("x", "x", "s", "e", "m", 0, output_tokens=1, reasoning_output_tokens=2)


def test_exact_micro_usd_cost_uses_disjoint_categories_and_multiplier() -> None:
    fact = UsageFact("x", "x", "s", "e", "m", 10, 20, 30, 40, 50, 60)
    rates = PriceRates(
        Decimal("1"),
        Decimal("2"),
        Decimal("3"),
        Decimal("4"),
        Decimal("5"),
        Decimal("6"),
        Decimal("1.5"),
    )
    assert estimate_cost_microusd(fact, rates) == round((10 + 40 + 90 + 160 + 250 + 360) * 1.5)


def test_cost_rounds_half_up_not_binary_float() -> None:
    fact = UsageFact("x", "x", "s", "e", "m", 1)
    assert estimate_cost_microusd(fact, PriceRates(Decimal("0.5"))) == 1
    assert estimate_cost_microusd(fact, PriceRates(Decimal("0.499999"))) == 0


def test_price_fact_is_immutable_and_validates_status() -> None:
    fact = UsageFact("x", "x", "s", "e", "m", 10)
    priced = price_fact(fact, PriceRates(Decimal(2)), status="override")
    assert fact.estimated_cost_microusd is None
    assert priced.estimated_cost_microusd == 20
    assert priced.price_match_status == "override"
    with pytest.raises(ValueError, match="status"):
        price_fact(fact, PriceRates(Decimal(2)), status="unpriced")


def test_negative_price_rate_rejected() -> None:
    with pytest.raises(ValueError, match="negative"):
        PriceRates(Decimal(-1))


@given(
    input_tokens=st.integers(0, 10**9),
    cached=st.integers(0, 10**9),
    output=st.integers(0, 10**9),
)
def test_total_arithmetic_never_double_counts_subsets(
    input_tokens: int, cached: int, output: int
) -> None:
    total_input = input_tokens + cached
    fact = UsageFact(
        "x", "x", "s", "e", "m", input_tokens, cache_read_tokens=cached, output_tokens=output
    )
    assert fact.total_input_tokens == total_input
    assert fact.total_tokens == total_input + output
