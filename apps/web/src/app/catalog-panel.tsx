"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type {
  CatalogCheckRow,
  CatalogModelRow,
  ModelPriceRow
} from "@/lib/types";

export interface SourcesSummary {
  schedule: { enabled: boolean; cron: string; timezone: string };
  auto_apply: boolean;
  providers: Array<{
    key: string;
    provider: string;
    model_api_enabled: boolean;
    model_documents: string[];
    pricing_documents: string[];
  }>;
}

/** Dollars per million tokens, which is how providers publish list prices. */
interface Draft {
  modelId: string;
  provider: string;
  displayName: string;
  input: string;
  output: string;
  cacheRead: string;
  write5m: string;
  write1h: string;
  sourceUrl: string;
  effectiveDate: string;
}

function usdPerMtok(microUsd: number): string {
  return (microUsd / 1_000_000).toFixed(2);
}

function ago(timestamp: number | null): string {
  if (timestamp === null || timestamp === 0) {
    return "never";
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function draftFor(model: CatalogModelRow, suggestedSource: string): Draft {
  return {
    modelId: model.model_id,
    provider: model.provider === "openai" ? "openai" : "claude",
    displayName: model.display_name,
    input: "",
    output: "",
    // Neutral defaults are filled in only once input is known, so nothing is
    // silently assumed here; empty means "same as the input rate".
    cacheRead: "",
    write5m: "",
    write1h: "",
    sourceUrl: model.source_url.length > 0 ? model.source_url : suggestedSource,
    effectiveDate: ""
  };
}

async function send(
  path: string,
  method: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("session expired");
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error ?? `request failed with ${response.status}`));
  }
  return payload;
}

function number(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The reviewed model and price catalog.
 *
 * A check discovers model identifiers from the declared official endpoints; it
 * does not read prices, because list prices are published as prose and a figure
 * scraped out of a documentation page would end up labelling real spend. So a
 * rate enters the catalog only when an operator approves it here with the source
 * they read it from, which is what `autoApply: false` in
 * config/catalog-sources.yaml asks for.
 */
export function CatalogPanel({
  models,
  prices,
  checks,
  sources,
  sourcesError
}: {
  models: CatalogModelRow[];
  prices: ModelPriceRow[];
  checks: CatalogCheckRow[];
  sources: SourcesSummary | null;
  sourcesError: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmNeeded, setConfirmNeeded] = useState(false);

  const priced = new Map(prices.map((price) => [price.model_id, price]));
  const pending = models.filter((model) => model.status === "needs_price");
  const ignored = models.filter((model) => model.status === "ignored");
  const lastCheck = checks[0];

  const pricingDocFor = (provider: string): string => {
    const match = sources?.providers.find((entry) => entry.provider === provider);
    return match?.pricing_documents[0] ?? "";
  };

  async function act(label: string, run: () => Promise<string>): Promise<void> {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      setNotice(await run());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  const check = () =>
    act("check", async () => {
      const result = await send("/api/v1/admin/catalog/check", "POST");
      const notes = Array.isArray(result.notes) ? (result.notes as string[]) : [];
      return (
        `Check ${String(result.status)}: ${Number(result.discovered)} models listed, ` +
        `${Number(result.added)} new. ${notes.join("; ")}`
      );
    });

  async function approve(confirm: boolean): Promise<void> {
    if (draft === null) {
      return;
    }
    const input = number(draft.input);
    const output = number(draft.output);
    if (input === null || output === null) {
      setError("Input and output rates are required and must be nonnegative.");
      return;
    }
    await act("approve", async () => {
      const body: Record<string, unknown> = {
        model_id: draft.modelId,
        provider: draft.provider,
        display_name: draft.displayName,
        input_usd_per_mtok: input,
        output_usd_per_mtok: output,
        source_url: draft.sourceUrl,
        confirm
      };
      for (const [field, value] of [
        ["cache_read_usd_per_mtok", draft.cacheRead],
        ["cache_write_5m_usd_per_mtok", draft.write5m],
        ["cache_write_1h_usd_per_mtok", draft.write1h]
      ] as const) {
        const parsed = number(value);
        if (parsed !== null) {
          body[field] = parsed;
        }
      }
      if (draft.effectiveDate.length > 0) {
        body.effective_date = draft.effectiveDate;
      }
      const response = await fetch("/api/v1/admin/prices", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (response.status === 409 && payload.requires_confirmation === true) {
        setConfirmNeeded(true);
        throw new Error(String(payload.error));
      }
      if (!response.ok) {
        throw new Error(String(payload.error ?? `failed with ${response.status}`));
      }
      setDraft(null);
      setConfirmNeeded(false);
      return `Approved a rate for ${draft.modelId}.`;
    });
  }

  const withdraw = (modelId: string) =>
    act(`withdraw:${modelId}`, async () => {
      await send(`/api/v1/admin/prices/${encodeURIComponent(modelId)}`, "DELETE");
      return `Withdrew the rate for ${modelId}; its usage now reports tokens without cost.`;
    });

  const setStatus = (modelId: string, status: "ignored" | "needs_price") =>
    act(`status:${modelId}`, async () => {
      await send(`/api/v1/admin/catalog/models/${encodeURIComponent(modelId)}`, "PATCH", {
        status
      });
      return status === "ignored"
        ? `${modelId} will no longer be listed as needing a price.`
        : `${modelId} is back in the review queue.`;
    });

  return (
    <section className="catalogPanel" id="catalog" aria-labelledby="catalog-heading">
      <header className="catalogTop">
        <div>
          <p className="eyebrow">Reviewed catalog</p>
          <h2 id="catalog-heading">Model prices</h2>
        </div>
        <button disabled={busy !== null} onClick={() => void check()} type="button">
          {busy === "check" ? "Checking…" : "Check for updates"}
        </button>
      </header>

      <p className="catalogLede">
        Costs on this dashboard are official API-equivalent estimates, not a claim
        about what a Claude or ChatGPT subscription billed. A scheduled check
        discovers which model identifiers exist; the rates themselves are approved
        here against the source they were read from.
      </p>

      <dl className="storageFacts">
        <div>
          <dt>Schedule</dt>
          <dd>
            {sources === null
              ? "unavailable"
              : sources.schedule.enabled
                ? `${sources.schedule.cron} ${sources.schedule.timezone}`
                : "disabled"}
          </dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>
            {lastCheck === undefined
              ? "never"
              : `${lastCheck.status} · ${ago(lastCheck.started_at)} · ${lastCheck.discovered} listed`}
          </dd>
        </div>
        <div>
          <dt>Approved rates</dt>
          <dd>{prices.length}</dd>
        </div>
        <div>
          <dt>Awaiting a rate</dt>
          <dd>{pending.length}</dd>
        </div>
      </dl>

      {sourcesError !== null ? <p className="formError">{sourcesError}</p> : null}
      {lastCheck !== undefined && lastCheck.detail.length > 0 ? (
        <p className="storageDetail">{lastCheck.detail}</p>
      ) : null}
      {error ? <p className="formError">{error}</p> : null}
      {notice ? <p className="formNotice">{notice}</p> : null}

      <div className="breakdown">
        <div className="breakdownHead">
          <p className="tileLabel">Awaiting a reviewed rate</p>
        </div>
        {pending.length === 0 ? (
          <p className="quiet">
            Every model seen in synced history has an approved rate.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col">First seen</th>
                <th scope="col">Origin</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {pending.map((model) => (
                <tr key={model.model_id}>
                  <th scope="row">{model.model_id}</th>
                  <td>{model.provider}</td>
                  <td>{ago(model.first_seen_at)}</td>
                  <td>{model.origin.replace("_", " ")}</td>
                  <td className="num">
                    <button
                      className="ghost small"
                      disabled={busy !== null}
                      onClick={() => {
                        setDraft(draftFor(model, pricingDocFor(model.provider)));
                        setConfirmNeeded(false);
                      }}
                      type="button"
                    >
                      Set rate…
                    </button>
                    <button
                      className="ghost small"
                      disabled={busy !== null}
                      onClick={() => void setStatus(model.model_id, "ignored")}
                      type="button"
                    >
                      Ignore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {draft !== null ? (
        <form
          className="priceForm"
          onSubmit={(event) => {
            event.preventDefault();
            void approve(false);
          }}
        >
          <p className="tileLabel">Approve a rate for {draft.modelId}</p>
          <p className="priceHint">
            Dollars per million tokens, as published. Leave a cache field empty to
            bill it at the input rate; relaydot does not assume a provider&apos;s
            cache multipliers.
          </p>
          <div className="priceGrid">
            {(
              [
                ["input", "Input", true],
                ["output", "Output", true],
                ["cacheRead", "Cached input", false],
                ["write5m", "5m cache write", false],
                ["write1h", "1h cache write", false]
              ] as const
            ).map(([field, label, required]) => (
              <label key={field}>
                <span>
                  {label}
                  {required ? "" : " (optional)"}
                </span>
                <input
                  inputMode="decimal"
                  min="0"
                  onChange={(event) =>
                    setDraft({ ...draft, [field]: event.target.value })
                  }
                  required={required}
                  step="0.01"
                  type="number"
                  value={draft[field]}
                />
              </label>
            ))}
            <label>
              <span>Source URL</span>
              <input
                onChange={(event) =>
                  setDraft({ ...draft, sourceUrl: event.target.value })
                }
                placeholder="https://…"
                required
                type="url"
                value={draft.sourceUrl}
              />
            </label>
            <label>
              <span>Effective date (optional)</span>
              <input
                onChange={(event) =>
                  setDraft({ ...draft, effectiveDate: event.target.value })
                }
                type="date"
                value={draft.effectiveDate}
              />
            </label>
          </div>
          <div className="buttonRow">
            <button disabled={busy !== null} type="submit">
              {busy === "approve" ? "Approving…" : "Approve rate"}
            </button>
            {confirmNeeded ? (
              <button
                className="ghost danger"
                disabled={busy !== null}
                onClick={() => void approve(true)}
                type="button"
              >
                Approve despite the change threshold
              </button>
            ) : null}
            <button
              className="ghost"
              onClick={() => {
                setDraft(null);
                setConfirmNeeded(false);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="breakdown">
        <div className="breakdownHead">
          <p className="tileLabel">Approved rates</p>
        </div>
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th className="num" scope="col">
                Input
              </th>
              <th className="num" scope="col">
                Cached
              </th>
              <th className="num" scope="col">
                Output
              </th>
              <th scope="col">Source</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {prices.map((price) => (
              <tr key={price.model_id}>
                <th scope="row">
                  {price.display_name}
                  {price.approved_by === "seed" ? (
                    <em className="unpriced">seed</em>
                  ) : null}
                </th>
                <td className="num">
                  ${usdPerMtok(price.input_uncached_microusd_per_mtok)}
                </td>
                <td className="num">
                  ${usdPerMtok(price.cache_read_microusd_per_mtok)}
                </td>
                <td className="num">${usdPerMtok(price.output_microusd_per_mtok)}</td>
                <td>
                  {price.source_url !== undefined && price.source_url.length > 0 ? (
                    <a href={price.source_url} rel="noreferrer" target="_blank">
                      published rates
                    </a>
                  ) : (
                    <span className="quiet">not recorded</span>
                  )}
                </td>
                <td className="num">
                  <button
                    className="ghost small"
                    disabled={busy !== null}
                    onClick={() => void withdraw(price.model_id)}
                    type="button"
                  >
                    Withdraw
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {priced.size === 0 ? (
          <p className="quiet">No rates are approved, so usage reports tokens only.</p>
        ) : null}
      </div>

      {ignored.length > 0 ? (
        <p className="quiet">
          Ignored:{" "}
          {ignored.map((model, index) => (
            <span key={model.model_id}>
              {index > 0 ? ", " : ""}
              <button
                className="linkButton"
                disabled={busy !== null}
                onClick={() => void setStatus(model.model_id, "needs_price")}
                type="button"
              >
                {model.model_id}
              </button>
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
