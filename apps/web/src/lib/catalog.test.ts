import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CatalogConfigError,
  credentialEnvName,
  loadCatalogSources,
  parseCatalogSources,
  refreshCatalog
} from "./catalog";
import { temporaryStore } from "./test-helpers";
import type { Store } from "./store";

const SOURCES = `
apiVersion: relaydot.dev/v1alpha1
kind: CatalogSources
metadata:
  name: test
spec:
  schedule:
    enabled: true
    cron: "0 4 * * *"
    timezone: UTC
  autoApply: false
  providers:
    openai:
      modelApi:
        enabled: true
        optional: true
        url: https://api.openai.com/v1/models
        credentialRef: secrets/openai-api-key
      pricingDocuments:
        - https://developers.openai.com/api/docs/pricing
    anthropic:
      modelApi:
        enabled: true
        optional: false
        url: https://api.anthropic.com/v1/models
        credentialRef: secrets/anthropic-api-key
      modelDocuments:
        - https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
  fetch:
    totalTimeoutSeconds: 5
    maxResponseBytes: 4096
    followRedirectsOnlyWithinAllowedHosts: true
    allowedHosts:
      - api.openai.com
      - api.anthropic.com
  validation:
    requireHttps: true
    blockOnRateChangePercent: 50
`;

const KEYS = {
  RELAYDOT_SECRETS_OPENAI_API_KEY: "openai-key",
  RELAYDOT_SECRETS_ANTHROPIC_API_KEY: "anthropic-key"
};

function modelList(ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id, display_name: id })) });
}

describe("catalog sources", () => {
  it("reads the repository's own declaration", () => {
    const sources = parseCatalogSources(SOURCES);
    expect(sources.schedule).toEqual({
      enabled: true,
      cron: "0 4 * * *",
      timezone: "UTC"
    });
    expect(sources.autoApply).toBe(false);
    expect(sources.fetch.allowedHosts).toEqual([
      "api.openai.com",
      "api.anthropic.com"
    ]);
    // The config says `anthropic`; usage facts say `claude`. The mapping has to
    // hold or discovered models land under a provider the dashboard never shows.
    const anthropic = sources.providers.find((entry) => entry.key === "anthropic");
    expect(anthropic?.provider).toBe("claude");
    expect(anthropic?.modelApi?.optional).toBe(false);
  });

  it("rejects a declaration it cannot honour", () => {
    expect(() => parseCatalogSources("apiVersion: other\nkind: CatalogSources")).toThrow(
      /unsupported apiVersion/
    );
    expect(() =>
      parseCatalogSources("apiVersion: relaydot.dev/v1alpha1\nkind: Other")
    ).toThrow(/kind must be CatalogSources/);
    // Honker's cron fires on epoch seconds, so a named zone would run the check
    // at the wrong hour for half the year.
    expect(() => parseCatalogSources(SOURCES.replace("timezone: UTC", "timezone: CET"))).toThrow(
      /must be UTC/
    );
    expect(() =>
      parseCatalogSources(SOURCES.replace("        url: https://api.openai.com/v1/models\n", ""))
    ).toThrow(/url must be a string/);
    expect(() =>
      parseCatalogSources(SOURCES.replace("      - api.openai.com\n", "      - 42\n"))
    ).toThrow(/list of strings/);
    expect(() =>
      parseCatalogSources(SOURCES.replace("    totalTimeoutSeconds: 5", "    totalTimeoutSeconds: soon"))
    ).toThrow(/must be a number/);
    expect(() => parseCatalogSources("apiVersion: relaydot.dev/v1alpha1")).toThrow(
      CatalogConfigError
    );
  });

  it("maps a credential reference to an environment variable name", () => {
    expect(credentialEnvName("secrets/openai-api-key")).toBe(
      "RELAYDOT_SECRETS_OPENAI_API_KEY"
    );
  });

  it("loads from disk and reports an unreadable or invalid file", () => {
    const directory = mkdtempSync(join(tmpdir(), "relaydot-catalog-"));
    try {
      const path = join(directory, "sources.yaml");
      writeFileSync(path, SOURCES);
      expect(loadCatalogSources(path).sources?.autoApply).toBe(false);

      writeFileSync(path, "apiVersion: wrong");
      const invalid = loadCatalogSources(path);
      expect(invalid.sources).toBeNull();
      expect(invalid.error).toContain("unsupported apiVersion");

      const missing = loadCatalogSources(join(directory, "absent.yaml"));
      expect(missing.sources).toBeNull();
      expect(missing.error).toContain("cannot read");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses the configuration this repository actually ships", () => {
    const loaded = loadCatalogSources(
      join(import.meta.dirname, "../../../../config/catalog-sources.yaml")
    );
    expect(loaded.error).toBeNull();
    expect(loaded.sources?.providers.map((entry) => entry.key).sort()).toEqual([
      "anthropic",
      "openai"
    ]);
  });
});

describe("catalog refresh", () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
  });

  afterEach(() => cleanup());

  it("records discovered models without inventing prices for them", async () => {
    const report = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async (url) =>
        String(url).includes("openai")
          ? modelList(["gpt-5.6-sol"])
          : modelList(["claude-opus-5"])
    });

    expect(report.status).toBe("ok");
    expect(report.discovered).toBe(2);
    expect(report.added).toBe(2);
    const models = store.catalogModels();
    expect(models.map((model) => model.model_id).sort()).toEqual([
      "claude-opus-5",
      "gpt-5.6-sol"
    ]);
    // Discovery finds identifiers only; a rate still needs a human.
    expect(models.every((model) => model.status === "needs_price")).toBe(true);
    expect(store.modelPrices()).toEqual([]);
    expect(models[0].source_url).toContain("https://");
  });

  it("sends each provider its own authentication scheme", async () => {
    const seen: Array<[string, string | null, string | null]> = [];
    await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        seen.push([
          String(url),
          headers.get("authorization"),
          headers.get("x-api-key")
        ]);
        return modelList([]);
      }
    });
    const openai = seen.find(([url]) => url.includes("openai"));
    const anthropic = seen.find(([url]) => url.includes("anthropic"));
    expect(openai?.[1]).toBe("Bearer openai-key");
    expect(anthropic?.[2]).toBe("anthropic-key");
  });

  it("skips an optional provider with no credential and fails a required one", async () => {
    const report = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: {},
      fetchImpl: async () => {
        throw new Error("must not be called without a credential");
      }
    });
    expect(report.notes[0]).toContain("skipped");
    expect(report.notes[1]).toContain("RELAYDOT_SECRETS_ANTHROPIC_API_KEY");
    expect(report.status).toBe("failed");
    const [check] = store.catalogChecks(1);
    expect(check.status).toBe("failed");
    expect(check.discovered).toBe(0);
  });

  it("keeps one provider's results when the other fails", async () => {
    const report = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async (url) =>
        String(url).includes("openai")
          ? modelList(["gpt-5.6-sol"])
          : new Response("", { status: 503 })
    });
    expect(report.status).toBe("partial");
    expect(report.discovered).toBe(1);
    expect(report.notes.some((note) => note.includes("503"))).toBe(true);
  });

  it("refuses a host outside the declared allowlist", async () => {
    const sources = parseCatalogSources(
      SOURCES.replace(
        "https://api.openai.com/v1/models",
        "https://models.example.com/v1/models"
      )
    );
    const report = await refreshCatalog(store, sources, {
      env: KEYS,
      fetchImpl: async (url) => {
        expect(String(url)).not.toContain("models.example.com");
        return modelList([]);
      }
    });
    expect(report.notes.some((note) => note.includes("not in spec.fetch.allowedHosts"))).toBe(
      true
    );
    expect(store.catalogModels()).toEqual([]);
  });

  it("refuses a plaintext source when https is required", async () => {
    const sources = parseCatalogSources(
      SOURCES.replace("https://api.openai.com/v1/models", "http://api.openai.com/v1/models")
    );
    const report = await refreshCatalog(store, sources, {
      env: KEYS,
      fetchImpl: async () => modelList([])
    });
    expect(report.notes.some((note) => note.includes("must use https"))).toBe(true);
  });

  it("follows a redirect only while it stays inside the allowlist", async () => {
    const visited: string[] = [];
    const sources = parseCatalogSources(SOURCES);
    const report = await refreshCatalog(store, sources, {
      env: KEYS,
      fetchImpl: async (url) => {
        const target = String(url);
        visited.push(target);
        if (target === "https://api.openai.com/v1/models") {
          return new Response("", {
            status: 302,
            headers: { location: "https://api.anthropic.com/v1/models" }
          });
        }
        if (target === "https://api.anthropic.com/v1/models") {
          return modelList(["after-redirect"]);
        }
        return new Response("", { status: 404 });
      }
    });
    expect(visited).toContain("https://api.anthropic.com/v1/models");
    expect(report.discovered).toBeGreaterThan(0);
  });

  it("stops a redirect that leaves the allowlist", async () => {
    const report = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async (url) =>
        String(url).includes("api.openai.com")
          ? new Response("", {
              status: 302,
              headers: { location: "https://evil.example.com/models" }
            })
          : modelList([])
    });
    expect(report.notes.some((note) => note.includes("evil.example.com"))).toBe(true);
  });

  it("refuses a body over the declared cap, before and during the read", async () => {
    const declared = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async () =>
        new Response("{}", { headers: { "content-length": "999999" } })
    });
    expect(declared.notes.some((note) => note.includes("over the"))).toBe(true);

    const streamed = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async () => new Response("x".repeat(9000))
    });
    expect(streamed.notes.some((note) => note.includes("byte cap"))).toBe(true);
  });

  it("rejects a response that is not a model list", async () => {
    const notJson = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async () => new Response("<html>nope</html>")
    });
    expect(notJson.notes.some((note) => note.includes("did not return JSON"))).toBe(true);

    const wrongShape = await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async () => Response.json({ models: [] })
    });
    expect(
      wrongShape.notes.some((note) => note.includes("did not return a model list"))
    ).toBe(true);
  });

  it("ignores list entries with no usable identifier", async () => {
    await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async () =>
        Response.json({ data: [{ id: "" }, { name: "no id" }, null, "text", { id: "kept" }] })
    });
    expect(store.catalogModels().map((model) => model.model_id)).toEqual(["kept"]);
  });

  it("notes a provider whose model API is disabled", async () => {
    const sources = parseCatalogSources(SOURCES.replace("        enabled: true", "        enabled: false"));
    const report = await refreshCatalog(store, sources, {
      env: KEYS,
      fetchImpl: async () => modelList([])
    });
    expect(report.notes.some((note) => note.includes("not enabled"))).toBe(true);
  });

  it("keeps the origin of a model first seen in real usage", async () => {
    store.observeCatalogModels([
      {
        model_id: "gpt-5.6-sol",
        provider: "openai",
        display_name: "gpt-5.6-sol",
        origin: "usage"
      }
    ]);
    await refreshCatalog(store, parseCatalogSources(SOURCES), {
      env: KEYS,
      fetchImpl: async (url) =>
        String(url).includes("openai") ? modelList(["gpt-5.6-sol"]) : modelList([])
    });
    const [model] = store.catalogModels();
    expect(model.origin).toBe("usage");
  });
});

describe("catalog defaults", () => {
  const MINIMAL = [
    "apiVersion: relaydot.dev/v1alpha1",
    "kind: CatalogSources",
    "spec:",
    "  providers:",
    "    openai:",
    "      modelApi:",
    "        url: https://api.openai.com/v1/models"
  ].join("\n");

  it("fills in every omitted section with a documented default", () => {
    const sources = parseCatalogSources(MINIMAL);
    expect(sources.schedule).toEqual({
      enabled: true,
      cron: "0 4 * * *",
      timezone: "UTC"
    });
    expect(sources.autoApply).toBe(false);
    expect(sources.fetch).toEqual({
      totalTimeoutSeconds: 30,
      maxResponseBytes: 10_485_760,
      allowedHosts: [],
      followRedirectsOnlyWithinAllowedHosts: true
    });
    expect(sources.validation).toEqual({
      requireHttps: true,
      requireSourceLocatorPerRate: true,
      requireNonnegativeRates: true,
      blockOnRateChangePercent: 50
    });
    const [provider] = sources.providers;
    // An omitted `enabled` means enabled, and an omitted credentialRef means
    // the endpoint needs no credential rather than an unnamed one.
    expect(provider.modelApi).toEqual({
      enabled: true,
      optional: true,
      url: "https://api.openai.com/v1/models",
      credentialRef: null
    });
    expect(provider.modelDocuments).toEqual([]);
    expect(provider.pricingDocuments).toEqual([]);
    // A provider the label map does not know keeps its own key.
    const other = parseCatalogSources(MINIMAL.replace("openai:", "someone-else:"));
    expect(other.providers[0].provider).toBe("someone-else");
  });

  it("treats a source with no credentialRef as needing none", async () => {
    const fixture = temporaryStore();
    try {
      const report = await refreshCatalog(
        fixture.store,
        parseCatalogSources(MINIMAL.replace("      modelApi:", "      modelApi:\n        optional: false")),
        { env: {}, fetchImpl: async () => Response.json({ data: [{ id: "m" }] }) }
      );
      expect(report.notes[0]).toContain("configuration");
    } finally {
      fixture.cleanup();
    }
  });

  it("falls back to the identifier when a listing has no display name", async () => {
    const fixture = temporaryStore();
    try {
      const sources = parseCatalogSources(
        MINIMAL.replace(
          "spec:",
          "spec:\n  fetch:\n    allowedHosts:\n      - api.openai.com"
        ).replace("        url:", "        credentialRef: secrets/openai-api-key\n        url:")
      );
      await refreshCatalog(fixture.store, sources, {
        env: { RELAYDOT_SECRETS_OPENAI_API_KEY: "k" },
        fetchImpl: async () => Response.json({ data: [{ id: "bare-id" }] })
      });
      expect(fixture.store.catalogModels()[0].display_name).toBe("bare-id");
    } finally {
      fixture.cleanup();
    }
  });

  it("reports a redirect with no location header", async () => {
    const fixture = temporaryStore();
    try {
      const sources = parseCatalogSources(
        MINIMAL.replace(
          "spec:",
          "spec:\n  fetch:\n    allowedHosts:\n      - api.openai.com"
        ).replace("        url:", "        credentialRef: secrets/openai-api-key\n        url:")
      );
      const report = await refreshCatalog(fixture.store, sources, {
        env: { RELAYDOT_SECRETS_OPENAI_API_KEY: "k" },
        fetchImpl: async () => new Response("", { status: 302 })
      });
      expect(report.notes.some((note) => note.includes("redirect without a location"))).toBe(
        true
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("stops after too many redirects", async () => {
    const fixture = temporaryStore();
    try {
      const sources = parseCatalogSources(
        MINIMAL.replace(
          "spec:",
          "spec:\n  fetch:\n    allowedHosts:\n      - api.openai.com"
        ).replace("        url:", "        credentialRef: secrets/openai-api-key\n        url:")
      );
      const report = await refreshCatalog(fixture.store, sources, {
        env: { RELAYDOT_SECRETS_OPENAI_API_KEY: "k" },
        fetchImpl: async () =>
          new Response("", {
            status: 302,
            headers: { location: "https://api.openai.com/v1/models" }
          })
      });
      expect(report.notes.some((note) => note.includes("too many redirects"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a url that is not a URL at all", async () => {
    const fixture = temporaryStore();
    try {
      const sources = parseCatalogSources(
        MINIMAL.replace("https://api.openai.com/v1/models", "::not a url::").replace(
          "        url:",
          "        credentialRef: secrets/openai-api-key\n        url:"
        )
      );
      const report = await refreshCatalog(fixture.store, sources, {
        env: { RELAYDOT_SECRETS_OPENAI_API_KEY: "k" },
        fetchImpl: async () => Response.json({ data: [] })
      });
      expect(report.notes.some((note) => note.includes("not a valid URL"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
