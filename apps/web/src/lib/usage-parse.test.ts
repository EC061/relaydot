import { describe, expect, it } from "vitest";

import {
  SEED_PRICES,
  estimateCostMicroUsd,
  ratesFor,
  uncachedEquivalentMicroUsd
} from "./prices";
import { parseByPath, parseClaude, parseCodex, readJsonl } from "./usage-parse";

/** Mirrors the record shape observed in real ~/.claude/projects transcripts. */
function claudeRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-a",
    timestamp: "2026-08-13T07:27:26.512Z",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-5",
      usage: {
        input_tokens: 100,
        cache_creation: {
          ephemeral_5m_input_tokens: 20,
          ephemeral_1h_input_tokens: 30
        },
        cache_read_input_tokens: 400,
        output_tokens: 50,
        output_tokens_details: { thinking_tokens: 10 }
      }
    },
    ...overrides
  };
}

function codexRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-08-13T07:00:00Z",
    turn_id: "turn-1",
    model: "gpt-5.6-sol",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 500,
          cached_input_tokens: 300,
          cache_write_input_tokens: 100,
          output_tokens: 80,
          reasoning_output_tokens: 20
        }
      }
    },
    ...overrides
  };
}

describe("JSONL reading", () => {
  it("skips blank lines, non-objects, and a truncated tail", () => {
    const { rows, skipped } = readJsonl(
      '{"a":1}\n\n[1,2]\nnot json\n{"b":2}\n{"partial":'
    );
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(skipped).toBe(3);
  });
});

describe("Claude transcript parsing", () => {
  it("extracts counters, thinking tokens, and the ISO timestamp", () => {
    const report = parseClaude([claudeRow()]);
    expect(report.facts).toHaveLength(1);
    const fact = report.facts[0];
    expect(fact.provider).toBe("claude");
    expect(fact.model_id).toBe("claude-opus-5");
    expect(fact.session_id).toBe("session-a");
    expect(fact.input_uncached_tokens).toBe(100);
    expect(fact.cache_write_5m_tokens).toBe(20);
    expect(fact.cache_write_1h_tokens).toBe(30);
    expect(fact.cache_write_other_tokens).toBe(0);
    expect(fact.cache_read_tokens).toBe(400);
    expect(fact.output_tokens).toBe(50);
    expect(fact.reasoning_output_tokens).toBe(10);
    expect(fact.occurred_at).toBe(
      Math.floor(Date.parse("2026-08-13T07:27:26.512Z") / 1000)
    );
  });

  it("keeps the last record for a message ID as the response is rewritten", () => {
    const partial = claudeRow();
    const complete = claudeRow();
    (complete.message.usage as Record<string, unknown>).output_tokens = 999;
    const report = parseClaude([partial, complete]);
    expect(report.duplicates).toBe(1);
    expect(report.facts).toHaveLength(1);
    expect(report.facts[0].output_tokens).toBe(999);
  });

  it("is stable across re-parsing so re-ingesting a grown file cannot double count", () => {
    const first = parseClaude([claudeRow()]).facts[0];
    const second = parseClaude([claudeRow(), claudeRow()]).facts[0];
    expect(first.usage_fact_id).toBe(second.usage_fact_id);
    // A different session yields a different identity.
    expect(parseClaude([claudeRow({ sessionId: "other" })]).facts[0].usage_fact_id).not.toBe(
      first.usage_fact_id
    );
  });

  it("falls back to the undifferentiated cache-creation total", () => {
    const row = claudeRow();
    delete (row.message.usage as Record<string, unknown>).cache_creation;
    (row.message.usage as Record<string, unknown>).cache_creation_input_tokens = 77;
    const fact = parseClaude([row]).facts[0];
    expect(fact.cache_write_other_tokens).toBe(77);
    expect(fact.cache_write_5m_tokens).toBe(0);
  });

  it("classifies records it cannot use", () => {
    const noUsage = { message: { id: "m", role: "assistant" } };
    const userTurn = { message: { role: "user", id: "m", usage: {} } };
    const report = parseClaude([noUsage, userTurn, { other: true }]);
    expect(report.facts).toHaveLength(0);
    expect(report.unknown).toBe(3);
  });

  it("rejects malformed counters and impossible thinking totals", () => {
    const negative = claudeRow();
    (negative.message.usage as Record<string, unknown>).input_tokens = -1;
    expect(parseClaude([negative]).malformed).toBe(1);

    const overThinking = claudeRow();
    (overThinking.message.usage as Record<string, unknown>).output_tokens_details = {
      thinking_tokens: 9999
    };
    expect(parseClaude([overThinking]).malformed).toBe(1);

    const badCreation = claudeRow();
    (badCreation.message.usage as Record<string, unknown>).cache_creation = 5;
    expect(parseClaude([badCreation]).malformed).toBe(1);

    const badModel = claudeRow();
    (badModel.message as Record<string, unknown>).model = 7;
    expect(parseClaude([badModel]).malformed).toBe(1);
  });
});

describe("Codex session parsing", () => {
  it("splits the per-turn input total into uncached, cache write, and read", () => {
    const fact = parseCodex([codexRow()], { sessionId: "sess" }).facts[0];
    expect(fact.provider).toBe("openai");
    expect(fact.model_id).toBe("gpt-5.6-sol");
    expect(fact.input_uncached_tokens).toBe(100);
    expect(fact.cache_write_other_tokens).toBe(100);
    expect(fact.cache_read_tokens).toBe(300);
    expect(fact.output_tokens).toBe(80);
    expect(fact.reasoning_output_tokens).toBe(20);
  });

  it("ignores non-token_count events", () => {
    const report = parseCodex([{ payload: { type: "message" } }, { nope: 1 }]);
    expect(report.facts).toHaveLength(0);
    expect(report.unknown).toBe(2);
  });

  it("deduplicates repeated turn IDs", () => {
    const report = parseCodex([codexRow(), codexRow()]);
    expect(report.facts).toHaveLength(1);
    expect(report.duplicates).toBe(1);
  });

  it("derives an identity when no turn ID is present", () => {
    const row = codexRow();
    delete (row as Record<string, unknown>).turn_id;
    const report = parseCodex([row]);
    expect(report.facts).toHaveLength(1);
    expect(report.facts[0].event_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects input subsets that exceed the input total", () => {
    const row = codexRow();
    (
      (row.payload as Record<string, unknown>).info as Record<string, unknown>
    ).last_token_usage = { input_tokens: 10, cached_input_tokens: 50 };
    expect(parseCodex([row]).malformed).toBe(1);
  });

  it("rejects reasoning tokens exceeding output tokens", () => {
    const row = codexRow();
    (
      (row.payload as Record<string, unknown>).info as Record<string, unknown>
    ).last_token_usage = {
      input_tokens: 10,
      output_tokens: 5,
      reasoning_output_tokens: 9
    };
    expect(parseCodex([row]).malformed).toBe(1);
  });
});

describe("parser selection by manifest path", () => {
  it("routes Claude and Codex history and ignores everything else", () => {
    const claude = parseByPath(
      "claude/projects/-Users-me-repo/abc.jsonl",
      JSON.stringify(claudeRow()),
      0
    );
    expect(claude?.facts[0].provider).toBe("claude");
    // The record carries its own sessionId, which wins over the file name.
    expect(claude?.facts[0].session_id).toBe("session-a");

    const noSessionField = claudeRow();
    delete (noSessionField as Record<string, unknown>).sessionId;
    const derived = parseByPath(
      "claude/projects/-Users-me-repo/abc.jsonl",
      JSON.stringify(noSessionField),
      0
    );
    expect(derived?.facts[0].session_id).toBe("abc");

    const codex = parseByPath(
      "codex/sessions/rollout-1.jsonl",
      JSON.stringify(codexRow()),
      0
    );
    expect(codex?.facts[0].provider).toBe("openai");
    expect(codex?.facts[0].session_id).toBe("rollout-1");

    expect(parseByPath("claude/settings.json", "{}", 0)).toBeNull();
    expect(parseByPath("claude/commands/a.jsonl", "{}", 0)).toBeNull();
  });

  it("falls back to the supplied time when a record has no timestamp", () => {
    const row = claudeRow();
    delete (row as Record<string, unknown>).timestamp;
    const report = parseByPath("claude/projects/p/s.jsonl", JSON.stringify(row), 1234);
    expect(report?.facts[0].occurred_at).toBe(1234);
  });

  it("accepts numeric epoch timestamps in seconds and milliseconds", () => {
    const seconds = parseClaude([claudeRow({ timestamp: 1_700_000_000 })]).facts[0];
    expect(seconds.occurred_at).toBe(1_700_000_000);
    const millis = parseClaude([claudeRow({ timestamp: 1_700_000_000_000 })]).facts[0];
    expect(millis.occurred_at).toBe(1_700_000_000);
    const garbage = parseClaude([claudeRow({ timestamp: "not a date" })]).facts[0];
    expect(garbage.occurred_at).toBe(0);
  });
});

describe("price arithmetic", () => {
  const opus = SEED_PRICES.find((row) => row.model_id === "claude-opus-5");

  it("seeds Claude list prices with the documented cache multipliers", () => {
    expect(opus).toBeDefined();
    const rates = ratesFor(opus!);
    // $5 per MTok input, 1.25x for a 5m write, 2x for 1h, 0.1x for a read.
    expect(rates.inputUncached).toBe(5_000_000);
    expect(rates.cacheWrite5m).toBe(6_250_000);
    expect(rates.cacheWrite1h).toBe(10_000_000);
    expect(rates.cacheRead).toBe(500_000);
    expect(rates.output).toBe(25_000_000);
  });

  it("computes exact integer microUSD costs", () => {
    const rates = ratesFor(opus!);
    const tokens = {
      input_uncached_tokens: 1_000_000,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_write_other_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 1_000_000
    };
    // One MTok in and one MTok out on Opus 5 is $5 + $25.
    expect(estimateCostMicroUsd(tokens, rates)).toBe(30_000_000);
  });

  it("reports cache savings as the uncached-equivalent difference", () => {
    const rates = ratesFor(opus!);
    const tokens = {
      input_uncached_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_write_other_tokens: 0,
      cache_read_tokens: 1_000_000,
      output_tokens: 0
    };
    expect(estimateCostMicroUsd(tokens, rates)).toBe(500_000);
    // The same tokens at the uncached input rate would have been $5.
    expect(uncachedEquivalentMicroUsd(tokens, rates)).toBe(5_000_000);
  });

  it("prices every seeded model consistently", () => {
    for (const row of SEED_PRICES) {
      const rates = ratesFor(row);
      expect(rates.cacheRead).toBeLessThan(rates.inputUncached);
      expect(rates.cacheWrite1h).toBeGreaterThan(rates.cacheWrite5m);
      expect(rates.output).toBeGreaterThan(rates.inputUncached);
      expect(row.provider).toBe("claude");
    }
  });
});
