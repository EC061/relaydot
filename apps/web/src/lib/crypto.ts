/**
 * Symmetric encryption for operator secrets held in SQLite, currently the
 * WebDAV password. The controller must be able to read these back to reach the
 * storage server, so they are encrypted rather than hashed.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
/** Fixed so the same passphrase derives the same key across restarts. */
const KEY_SALT = "relaydot/secret-key/v1";

export class SecretKeyError extends Error {}

export function deriveSecretKey(passphrase: string): Buffer {
  if (passphrase.length === 0) {
    throw new SecretKeyError("secret passphrase must not be empty");
  }
  return scryptSync(passphrase, KEY_SALT, 32);
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    sealed.toString("base64")
  ].join(":");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretKeyError("unrecognized secret envelope");
  }
  const [, iv, tag, sealed] = parts;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext are indistinguishable and both fatal.
    throw new SecretKeyError(
      "stored secret could not be decrypted; the secret key may have changed"
    );
  }
}

/** Constant-time comparison for the sentinel used to detect key rotation. */
export function keysMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
