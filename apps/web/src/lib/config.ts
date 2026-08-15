/**
 * Environment-derived controller settings.
 *
 * Kept separate from routes.ts so the background worker can read the same
 * values without importing the request layer, which would import the store back
 * and close a module cycle.
 */
import { resolve } from "node:path";

import { deriveSecretKey } from "./crypto";

const DEVELOPMENT_TOKEN = "relaydot-development-only";

/**
 * A missing administrator token is fatal in production rather than silently
 * falling back to a published constant that would leave the controller open
 * to anyone who has read this repository.
 */
export function adminToken(): string {
  const configured = process.env.RELAYDOT_ADMIN_TOKEN;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "RELAYDOT_ADMIN_TOKEN must be set; refusing to start with a default token"
    );
  }
  return DEVELOPMENT_TOKEN;
}

/**
 * The externally reachable URL of this controller, e.g.
 * `https://relaydot.example.com`. When set it pins browser origin checks and
 * cookie flags instead of trusting the request `Host` header. Unset falls back
 * to per-request host comparison, which suits local development.
 */
export function publicUrl(): string | null {
  const configured = process.env.RELAYDOT_PUBLIC_URL?.trim();
  if (configured === undefined || configured.length === 0) {
    return null;
  }
  try {
    return new URL(configured).origin;
  } catch {
    throw new Error(
      `RELAYDOT_PUBLIC_URL must be an absolute URL, received "${configured}"`
    );
  }
}

/**
 * Key that encrypts stored operator secrets. A dedicated
 * `RELAYDOT_SECRET_KEY` survives admin-token rotation; without one the key is
 * derived from the admin token, so rotating it requires re-entering the WebDAV
 * password.
 */
export function secretKey(): Buffer {
  const dedicated = process.env.RELAYDOT_SECRET_KEY;
  if (dedicated !== undefined && dedicated.length > 0) {
    return deriveSecretKey(dedicated);
  }
  return deriveSecretKey(adminToken());
}

/**
 * Where the declared official catalog sources live. Bind-mounting over this
 * path lets an operator change the allowlist or schedule without a rebuild.
 */
export function catalogSourcesPath(): string {
  const configured = process.env.RELAYDOT_CATALOG_SOURCES?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return resolve(process.cwd(), "../../config/catalog-sources.yaml");
}

/**
 * How often the controller re-reads the shared object store. Ingest is
 * incremental and content-addressed, so a short interval usually costs one
 * PROPFIND and nothing else.
 */
export function ingestSchedule(): string {
  const configured = process.env.RELAYDOT_INGEST_SCHEDULE?.trim();
  return configured !== undefined && configured.length > 0 ? configured : "@every 5m";
}
