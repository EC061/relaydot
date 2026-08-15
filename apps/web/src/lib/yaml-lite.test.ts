import { describe, expect, it } from "vitest";

import { YamlError, parseYaml } from "./yaml-lite";

describe("yaml-lite", () => {
  it("reads nested mappings, sequences, and scalar types", () => {
    expect(
      parseYaml(
        [
          "name: relaydot",
          "enabled: true",
          "disabled: false",
          "count: 42",
          "negative: -7",
          "ratio: 0.25",
          "exponent: 1.5e3",
          "empty:",
          "tilde: ~",
          "explicit: null",
          "nested:",
          "  inner:",
          "    leaf: value",
          "list:",
          "  - one",
          "  - two"
        ].join("\n")
      )
    ).toEqual({
      name: "relaydot",
      enabled: true,
      disabled: false,
      count: 42,
      negative: -7,
      ratio: 0.25,
      exponent: 1500,
      empty: null,
      tilde: null,
      explicit: null,
      nested: { inner: { leaf: "value" } },
      list: ["one", "two"]
    });
  });

  it("keeps a URL intact rather than splitting on its scheme colon", () => {
    expect(parseYaml("url: https://api.openai.com/v1/models")).toEqual({
      url: "https://api.openai.com/v1/models"
    });
    expect(parseYaml("docs:\n  - https://example.com/a:b\n")).toEqual({
      docs: ["https://example.com/a:b"]
    });
  });

  it("reads a sequence of mappings, including nested keys", () => {
    expect(
      parseYaml(
        ["providers:", "  - key: openai", "    enabled: true", "  - key: anthropic"].join(
          "\n"
        )
      )
    ).toEqual({
      providers: [
        { key: "openai", enabled: true },
        { key: "anthropic" }
      ]
    });
  });

  it("strips comments outside strings and keeps a hash inside one", () => {
    expect(
      parseYaml(
        ["# leading comment", "cron: '0 4 * * *' # when", 'tag: "a # b"'].join("\n")
      )
    ).toEqual({ cron: "0 4 * * *", tag: "a # b" });
  });

  it("decodes escapes in double quotes and doubled quotes in single", () => {
    expect(parseYaml('a: "line\\nbreak"\nb: \'it\'\'s\'')).toEqual({
      a: "line\nbreak",
      b: "it's"
    });
  });

  it("returns null for a document with no content", () => {
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("# only a comment\n")).toBeNull();
    expect(parseYaml("---\nkey: value")).toEqual({ key: "value" });
  });

  it("rejects constructs it cannot represent instead of guessing", () => {
    // Anchors, aliases, flow collections, and block scalars all change meaning
    // in ways this reader does not model, so each must fail loudly.
    for (const source of [
      "anchor: &base value",
      "alias: *base",
      "flow: {a: 1}",
      "seq: [1, 2]",
      "block: |",
      "folded: >"
    ]) {
      expect(() => parseYaml(source), source).toThrow(YamlError);
    }
    expect(() => parseYaml("a: 1\n---\nb: 2")).toThrow(/multiple YAML documents/);
    expect(() => parseYaml("just a scalar")).toThrow(/key: value/);
    expect(() => parseYaml("a: 1\na: 2")).toThrow(/duplicate mapping key/);
    expect(() => parseYaml('a: "unterminated')).toThrow(/unterminated/);
    expect(() => parseYaml("- item\n  key: value")).toThrow(YamlError);
    expect(() => parseYaml('"": value')).toThrow(/must not be empty/);
  });

  it("reports the offending line number", () => {
    try {
      parseYaml("good: 1\nalso: 2\nbad: {inline: true}");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(YamlError);
      expect((error as YamlError).line).toBe(3);
      expect((error as YamlError).message).toContain("line 3");
    }
  });

  it("treats a tab as indentation rather than failing", () => {
    expect(parseYaml("root:\n\tchild: 1")).toEqual({ root: { child: 1 } });
  });

  it("rejects indentation that matches no open block", () => {
    expect(() => parseYaml("a:\n    b: 1\n  c: 2")).toThrow(/inconsistent indentation/);
  });
});
