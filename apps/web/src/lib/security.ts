/** Token primitives used only in the Next.js server runtime. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokensMatch(left: string, right: string): boolean {
  const leftDigest = Buffer.from(hashToken(left), "hex");
  const rightDigest = Buffer.from(hashToken(right), "hex");
  return timingSafeEqual(leftDigest, rightDigest);
}

export const SESSION_COOKIE = "relaydot_session";

/** Eight hours: long enough for an operator shift, short enough to expire. */
export const SESSION_TTL_SECONDS = 28_800;

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

/**
 * The operator-declared public URL of this controller, when configured. It
 * pins origin checks and cookie flags to a trusted value instead of the
 * client-supplied `Host` header.
 */
export type PublicUrl = string | null;

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * `Secure` is omitted only for plain-HTTP origins so that a loopback
 * development controller can still log in; every real deployment terminates
 * TLS and gets the attribute.
 */
export function sessionCookie(
  request: Request,
  token: string,
  maxAge: number,
  publicUrl: PublicUrl = null
): string {
  const secure = isSecureRequest(request, publicUrl) ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

export function clearedSessionCookie(
  request: Request,
  publicUrl: PublicUrl = null
): string {
  return sessionCookie(request, "", 0, publicUrl);
}

function isSecureRequest(request: Request, publicUrl: PublicUrl): boolean {
  if (publicUrl !== null) {
    return normalizedOrigin(publicUrl)?.startsWith("https:") === true;
  }
  if (request.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https") {
    return true;
  }
  return new URL(request.url).protocol === "https:";
}

/**
 * Rejects a browser request whose `Origin` is not this controller. SameSite
 * already blocks the common cross-site case; this closes the gap for clients
 * that ignore the attribute. When `RELAYDOT_PUBLIC_URL` is configured the
 * comparison uses it, so a forged `Host` header cannot widen the check.
 */
export function isSameOrigin(
  request: Request,
  publicUrl: PublicUrl = null
): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) {
    // Non-browser clients omit Origin entirely; they authenticate with the
    // administrator header, which cannot be set by a cross-site form.
    return true;
  }
  const sent = normalizedOrigin(origin);
  if (sent === null) {
    return false;
  }
  if (publicUrl !== null) {
    return sent === normalizedOrigin(publicUrl);
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return host !== null && new URL(sent).host === host;
}

interface Attempts {
  count: number;
  resetAt: number;
}

const LOGIN_WINDOW_MS = 900_000;
const LOGIN_LIMIT = 10;
const attempts = new Map<string, Attempts>();

/**
 * Fixed-window throttle so a weak operator-chosen administrator token cannot
 * be brute forced. State is per process, which matches the single-container
 * controller deployment.
 */
export function loginThrottle(key: string): {
  blocked: boolean;
  fail: () => void;
  reset: () => void;
} {
  const now = Date.now();
  const existing = attempts.get(key);
  const window =
    existing === undefined || existing.resetAt <= now
      ? { count: 0, resetAt: now + LOGIN_WINDOW_MS }
      : existing;
  attempts.set(key, window);
  if (attempts.size > 1000) {
    for (const [candidate, value] of attempts) {
      if (value.resetAt <= now) {
        attempts.delete(candidate);
      }
    }
  }
  return {
    blocked: window.count >= LOGIN_LIMIT,
    fail: () => {
      window.count += 1;
    },
    reset: () => attempts.delete(key)
  };
}

export function resetLoginThrottle(): void {
  attempts.clear();
}
