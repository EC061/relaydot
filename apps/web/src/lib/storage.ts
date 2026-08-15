/**
 * Resolves the single configured WebDAV backend into usable credentials.
 *
 * Shared by the request layer and the background worker so both decrypt the
 * password the same way, and so a failure to decrypt (a rotated
 * `RELAYDOT_SECRET_KEY`) degrades to "not configured" rather than throwing
 * somewhere with no operator visible.
 */
import { decryptSecret } from "./crypto";
import type { Store } from "./store";
import type { WebdavConfig } from "./webdav";

export function resolveStorage(
  store: Store,
  secretKey: Buffer | null
): WebdavConfig | null {
  const backend = store.storageBackend();
  if (backend === null || secretKey === null) {
    return null;
  }
  try {
    return {
      baseUrl: backend.base_url,
      username: backend.username,
      password: decryptSecret(backend.password_encrypted, secretKey)
    };
  } catch {
    return null;
  }
}
