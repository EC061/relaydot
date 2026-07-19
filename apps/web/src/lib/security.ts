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
