import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE,
  clearedSessionCookie,
  createToken,
  hashToken,
  isSameOrigin,
  readCookie,
  sessionCookie,
  tokensMatch
} from "./security";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

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

  it("reads a named cookie out of the request header", () => {
    expect(readCookie(req("http://c.test"), SESSION_COOKIE)).toBeNull();
    expect(
      readCookie(req("http://c.test", { cookie: "other=1" }), SESSION_COOKIE)
    ).toBeNull();
    expect(
      readCookie(
        req("http://c.test", {
          cookie: `flag; other=1; ${SESSION_COOKIE}=a%20b`
        }),
        SESSION_COOKIE
      )
    ).toBe("a b");
  });

  it("marks the session cookie Secure only on HTTPS requests", () => {
    expect(sessionCookie(req("http://c.test"), "t", 60)).not.toContain("Secure");
    expect(sessionCookie(req("https://c.test"), "t", 60)).toContain("Secure");
    expect(
      sessionCookie(req("http://c.test", { "x-forwarded-proto": "https,http" }), "t", 60)
    ).toContain("Secure");
    expect(clearedSessionCookie(req("http://c.test"))).toContain("Max-Age=0");
  });

  it("accepts same-origin requests and rejects foreign or malformed origins", () => {
    expect(isSameOrigin(req("http://c.test"))).toBe(true);
    expect(
      isSameOrigin(
        req("http://c.test", { origin: "http://c.test", host: "c.test" })
      )
    ).toBe(true);
    expect(
      isSameOrigin(
        req("http://c.test", {
          origin: "https://relay.test",
          "x-forwarded-host": "relay.test"
        })
      )
    ).toBe(true);
    expect(
      isSameOrigin(
        req("http://c.test", { origin: "https://evil.test", host: "c.test" })
      )
    ).toBe(false);
    expect(
      isSameOrigin(req("http://c.test", { origin: "not a url", host: "c.test" }))
    ).toBe(false);
  });
});
