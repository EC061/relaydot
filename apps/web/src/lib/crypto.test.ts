import { describe, expect, it } from "vitest";

import {
  SecretKeyError,
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  keysMatch
} from "./crypto";

describe("operator secret encryption", () => {
  const key = deriveSecretKey("controller-admin-token");

  it("derives a stable 32-byte key and rejects an empty passphrase", () => {
    expect(key).toHaveLength(32);
    expect(keysMatch(key, deriveSecretKey("controller-admin-token"))).toBe(true);
    expect(keysMatch(key, deriveSecretKey("different"))).toBe(false);
    expect(() => deriveSecretKey("")).toThrow(SecretKeyError);
  });

  it("round-trips a secret without storing plaintext", () => {
    const sealed = encryptSecret("webdav-password", key);
    expect(sealed).not.toContain("webdav-password");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(decryptSecret(sealed, key)).toBe("webdav-password");
  });

  it("produces a distinct envelope per call", () => {
    // A fresh IV each time, so identical passwords do not reveal reuse.
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("fails closed on a rotated key or tampered ciphertext", () => {
    const sealed = encryptSecret("webdav-password", key);
    expect(() => decryptSecret(sealed, deriveSecretKey("rotated"))).toThrow(
      SecretKeyError
    );

    const parts = sealed.split(":");
    const flipped = Buffer.from(parts[3], "base64");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow(SecretKeyError);
  });

  it("rejects an unrecognized envelope", () => {
    expect(() => decryptSecret("v2:a:b:c", key)).toThrow(/unrecognized/);
    expect(() => decryptSecret("nonsense", key)).toThrow(/unrecognized/);
  });

  it("compares keys of differing length without throwing", () => {
    expect(keysMatch(Buffer.alloc(8), Buffer.alloc(16))).toBe(false);
  });
});
