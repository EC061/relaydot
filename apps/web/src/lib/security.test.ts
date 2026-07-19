import { describe, expect, it } from "vitest";

import { createToken, hashToken, tokensMatch } from "./security";

describe("token security", () => {
  it("creates random URL-safe tokens and stable hashes", () => {
    const first = createToken();
    const second = createToken();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashToken(first)).toHaveLength(64);
    expect(hashToken(first)).toBe(hashToken(first));
  });

  it("compares tokens without comparing plaintext", () => {
    expect(tokensMatch("correct", "correct")).toBe(true);
    expect(tokensMatch("correct", "wrong")).toBe(false);
  });
});
