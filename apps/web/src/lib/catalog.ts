/**
 * Scheduled official-source check for the model and price catalog.
 *
 * config/catalog-sources.yaml declares where the controller may look and under
 * what limits. This module honours that declaration literally: HTTPS only, only
 * the hosts listed there, redirects followed only within those hosts, a byte
 * cap, and a total timeout.
 *
 * A check discovers *model identifiers*, not prices. Provider list prices are
 * published as prose on documentation pages, and scraping a dollar figure out
 * of marketing HTML and then labelling real spend with it is exactly the kind
 * of silent error the catalog design exists to prevent. Discovered models land
 * in the review queue with the documentation URL an operator should read, and a
 * rate only enters `model_prices` when a human approves it with that source
 * recorded. `spec.autoApply: false` says the same thing.
 */
import { readFileSync } from "node:fs";

import { parseYaml } from "./yaml-lite";
import type { Store } from "./store";
import type { CatalogCheckRow } from "./types";

export class CatalogConfigError extends Error {}

export interface ModelApiSource {
  enabled: boolean;
  optional: boolean;
  url: string;
  credentialRef: string | null;
}

export interface ProviderSources {
  /** Key as written in the configuration file, e.g. `openai`. */
  key: string;
  /** The provider label used by usage facts, e.g. `claude` for Anthropic. */
  provider: string;
  modelApi: ModelApiSource | null;
  modelDocuments: string[];
  pricingDocuments: string[];
}

export interface FetchLimits {
  totalTimeoutSeconds: number;
  maxResponseBytes: number;
  allowedHosts: string[];
  followRedirectsOnlyWithinAllowedHosts: boolean;
}

export interface CatalogSources {
  schedule: { enabled: boolean; cron: string; timezone: string };
  autoApply: boolean;
  providers: ProviderSources[];
  fetch: FetchLimits;
  validation: {
    requireHttps: boolean;
    requireSourceLocatorPerRate: boolean;
    requireNonnegativeRates: boolean;
    blockOnRateChangePercent: number;
  };
}

/** Usage facts label Anthropic traffic `claude`; the config file says `anthropic`. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "claude",
  openai: "openai"
};

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogConfigError(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CatalogConfigError(`${label} must be a list of strings`);
  }
  return value as string[];
}

function integer(value: unknown, label: string, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CatalogConfigError(`${label} must be a number`);
  }
  return value;
}

export function parseCatalogSources(source: string): CatalogSources {
  const document = mapping(parseYaml(source), "catalog sources");
  if (document.apiVersion !== "relaydot.dev/v1alpha1") {
    throw new CatalogConfigError("unsupported apiVersion");
  }
  if (document.kind !== "CatalogSources") {
    throw new CatalogConfigError("kind must be CatalogSources");
  }
  const spec = mapping(document.spec, "spec");
  const schedule = mapping(spec.schedule ?? {}, "spec.schedule");
  const timezone = String(schedule.timezone ?? "UTC");
  if (timezone.toUpperCase() !== "UTC") {
    // Honker's cron fires on absolute epoch seconds. Accepting a named zone
    // here would silently run the check at the wrong hour half the year.
    throw new CatalogConfigError(
      `spec.schedule.timezone must be UTC; got ${timezone}`
    );
  }
  const fetchSpec = mapping(spec.fetch ?? {}, "spec.fetch");
  const validation = mapping(spec.validation ?? {}, "spec.validation");
  const providersSpec = mapping(spec.providers ?? {}, "spec.providers");

  const providers: ProviderSources[] = Object.entries(providersSpec).map(
    ([key, raw]) => {
      const entry = mapping(raw, `spec.providers.${key}`);
      const apiRaw = entry.modelApi;
      let modelApi: ModelApiSource | null = null;
      if (apiRaw !== null && apiRaw !== undefined) {
        const api = mapping(apiRaw, `spec.providers.${key}.modelApi`);
        if (typeof api.url !== "string" || api.url.length === 0) {
          throw new CatalogConfigError(
            `spec.providers.${key}.modelApi.url must be a string`
          );
        }
        modelApi = {
          enabled: api.enabled !== false,
          optional: api.optional !== false,
          url: api.url,
          credentialRef:
            typeof api.credentialRef === "string" ? api.credentialRef : null
        };
      }
      return {
        key,
        provider: PROVIDER_LABELS[key] ?? key,
        modelApi,
        modelDocuments: stringList(
          entry.modelDocuments,
          `spec.providers.${key}.modelDocuments`
        ),
        pricingDocuments: stringList(
          entry.pricingDocuments,
          `spec.providers.${key}.pricingDocuments`
        )
      };
    }
  );

  return {
    schedule: {
      enabled: schedule.enabled !== false,
      cron: String(schedule.cron ?? "0 4 * * *"),
      timezone: "UTC"
    },
    autoApply: spec.autoApply === true,
    providers,
    fetch: {
      totalTimeoutSeconds: integer(
        fetchSpec.totalTimeoutSeconds,
        "spec.fetch.totalTimeoutSeconds",
        30
      ),
      maxResponseBytes: integer(
        fetchSpec.maxResponseBytes,
        "spec.fetch.maxResponseBytes",
        10_485_760
      ),
      allowedHosts: stringList(fetchSpec.allowedHosts, "spec.fetch.allowedHosts"),
      followRedirectsOnlyWithinAllowedHosts:
        fetchSpec.followRedirectsOnlyWithinAllowedHosts !== false
    },
    validation: {
      requireHttps: validation.requireHttps !== false,
      requireSourceLocatorPerRate: validation.requireSourceLocatorPerRate !== false,
      requireNonnegativeRates: validation.requireNonnegativeRates !== false,
      blockOnRateChangePercent: integer(
        validation.blockOnRateChangePercent,
        "spec.validation.blockOnRateChangePercent",
        50
      )
    }
  };
}

/**
 * Reads the declared sources from disk. A missing file disables the check
 * rather than breaking the controller: a deployment that never mounts the
 * configuration should still serve the dashboard.
 */
export function loadCatalogSources(
  path: string
): { sources: CatalogSources; error: null } | { sources: null; error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      sources: null,
      error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  try {
    return { sources: parseCatalogSources(text), error: null };
  } catch (error) {
    return {
      sources: null,
      error: `${path}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Maps a declared `credentialRef` to an environment variable name. The
 * configuration file deliberately holds no keys, so `secrets/openai-api-key`
 * resolves from `RELAYDOT_SECRETS_OPENAI_API_KEY`.
 */
export function credentialEnvName(ref: string): string {
  return `RELAYDOT_${ref.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

function assertAllowed(url: string, limits: FetchLimits, requireHttps: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CatalogConfigError(`not a valid URL: ${url}`);
  }
  if (requireHttps && parsed.protocol !== "https:") {
    throw new CatalogConfigError(`source must use https: ${url}`);
  }
  if (!limits.allowedHosts.includes(parsed.hostname)) {
    throw new CatalogConfigError(
      `host ${parsed.hostname} is not in spec.fetch.allowedHosts`
    );
  }
  return parsed;
}

/**
 * Fetches a declared source under the configured limits: manual redirects so
 * each hop is re-validated against the allowlist, a total timeout, and a hard
 * byte cap enforced while reading rather than after.
 */
async function fetchLimited(
  url: string,
  headers: Record<string, string>,
  limits: FetchLimits,
  requireHttps: boolean,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    limits.totalTimeoutSeconds * 1000
  );
  try {
    let target = assertAllowed(url, limits, requireHttps).toString();
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await fetchImpl(target, {
        headers,
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new CatalogConfigError(`redirect without a location from ${target}`);
        }
        const next = new URL(location, target).toString();
        if (limits.followRedirectsOnlyWithinAllowedHosts) {
          assertAllowed(next, limits, requireHttps);
        }
        target = next;
        continue;
      }
      return { status: response.status, body: await readCapped(response, limits) };
    }
    throw new CatalogConfigError(`too many redirects from ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, limits: FetchLimits): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limits.maxResponseBytes) {
    throw new CatalogConfigError(
      `response declares ${declared} bytes, over the ${limits.maxResponseBytes} cap`
    );
  }
  const stream = response.body;
  if (stream === null) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limits.maxResponseBytes) {
      throw new CatalogConfigError("response exceeded the configured byte cap");
    }
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limits.maxResponseBytes) {
      await reader.cancel();
      throw new CatalogConfigError("response exceeded the configured byte cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface DiscoveredModel {
  model_id: string;
  provider: string;
  display_name: string;
  origin: "official_source";
  source_url: string;
}

/** Both provider list endpoints answer `{ "data": [{ "id": ... }] }`. */
function readModelList(
  body: string,
  provider: string,
  sourceUrl: string
): DiscoveredModel[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new CatalogConfigError(`${sourceUrl} did not return JSON`);
  }
  const data =
    typeof payload === "object" && payload !== null
      ? (payload as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) {
    throw new CatalogConfigError(`${sourceUrl} did not return a model list`);
  }
  const models: DiscoveredModel[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as { id?: unknown; display_name?: unknown };
    if (typeof record.id !== "string" || record.id.length === 0) {
      continue;
    }
    models.push({
      model_id: record.id,
      provider,
      display_name:
        typeof record.display_name === "string" && record.display_name.length > 0
          ? record.display_name
          : record.id,
      origin: "official_source",
      source_url: sourceUrl
    });
  }
  return models;
}

export interface CatalogCheckReport {
  status: CatalogCheckRow["status"];
  discovered: number;
  added: number;
  notes: string[];
}

/**
 * Runs one check across every declared provider and records the attempt.
 *
 * A provider whose model API is `optional` and has no credential configured is
 * noted and skipped, not treated as a failure: the documentation links still
 * give an operator everything needed to approve a rate by hand.
 */
export async function refreshCatalog(
  store: Store,
  sources: CatalogSources,
  options: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<CatalogCheckReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const id = store.startCatalogCheck();
  const notes: string[] = [];
  const discovered: DiscoveredModel[] = [];
  let failures = 0;
  let attempted = 0;

  for (const provider of sources.providers) {
    const api = provider.modelApi;
    if (api === null || !api.enabled) {
      notes.push(`${provider.key}: model API not enabled`);
      continue;
    }
    const credential =
      api.credentialRef === null ? undefined : env[credentialEnvName(api.credentialRef)];
    if (credential === undefined || credential.length === 0) {
      const note =
        `${provider.key}: no credential in ` +
        `${api.credentialRef === null ? "configuration" : credentialEnvName(api.credentialRef)}`;
      if (api.optional) {
        notes.push(`${note}; skipped`);
        continue;
      }
      notes.push(note);
      failures += 1;
      continue;
    }
    attempted += 1;
    try {
      const { status, body } = await fetchLimited(
        api.url,
        authHeaders(provider.key, credential),
        sources.fetch,
        sources.validation.requireHttps,
        fetchImpl
      );
      if (status !== 200) {
        throw new CatalogConfigError(`${api.url} returned ${status}`);
      }
      const models = readModelList(body, provider.provider, api.url);
      discovered.push(...models);
      notes.push(`${provider.key}: ${models.length} models listed`);
    } catch (error) {
      failures += 1;
      notes.push(
        `${provider.key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const added = store.observeCatalogModels(discovered);
  const status: CatalogCheckRow["status"] =
    failures === 0 ? "ok" : attempted > failures || discovered.length > 0 ? "partial" : "failed";
  store.finishCatalogCheck(id, {
    status,
    discovered: discovered.length,
    added,
    detail: notes.join("; ")
  });
  return { status, discovered: discovered.length, added, notes };
}

function authHeaders(providerKey: string, credential: string): Record<string, string> {
  if (providerKey === "anthropic") {
    return { "x-api-key": credential, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${credential}` };
}
