/**
 * Minimal WebDAV client covering the verbs the controller needs to read the
 * shared object store: PROPFIND to list, GET to read, PUT/MKCOL to write during
 * connection tests. Agents perform the bulk of writes themselves.
 */

export interface WebdavConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface WebdavEntry {
  href: string;
  name: string;
  isDirectory: boolean;
  size: number;
  lastModified: number | null;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>" +
  "</d:prop></d:propfind>";

export class WebdavError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
  }
}

/** Normalizes to exactly one trailing slash so joins never double up. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new WebdavError("WebDAV base URL must not be empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebdavError(`WebDAV base URL is not a valid URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebdavError("WebDAV base URL must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function encodeSegments(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export class WebdavClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(
    config: WebdavConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    const credential = Buffer.from(
      `${config.username}:${config.password}`,
      "utf8"
    ).toString("base64");
    this.authorization = `Basic ${credential}`;
  }

  url(path: string): string {
    return new URL(encodeSegments(path), this.baseUrl).toString();
  }

  private async request(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: { authorization: this.authorization, ...(init.headers ?? {}) },
        body: init.body,
        redirect: "follow"
      });
    } catch (cause) {
      throw new WebdavError(
        `WebDAV ${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebdavError("WebDAV rejected the credential", response.status);
    }
    return response;
  }

  /**
   * True when the resource exists, tested with a depth-0 PROPFIND.
   *
   * HEAD would be cheaper, but WsgiDAV answers a 404 HEAD with a
   * `Content-Length` for an error page it then correctly does not send, which
   * leaves a keep-alive connection expecting bytes that never arrive; the next
   * response on that connection is unparsable. PROPFIND always sends the body
   * it declares. relaydot/webdav.py avoids HEAD for the same reason.
   */
  async exists(path: string): Promise<boolean> {
    const response = await this.request("PROPFIND", path, {
      headers: { depth: "0", "content-type": "application/xml" },
      body: PROPFIND_BODY
    });
    if (response.status === 404) {
      return false;
    }
    if (response.status !== 207 && !response.ok) {
      throw new WebdavError(
        `WebDAV PROPFIND ${path} returned ${response.status}`,
        response.status
      );
    }
    return true;
  }

  async get(path: string): Promise<Uint8Array | null> {
    const response = await this.request("GET", path);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new WebdavError(
        `WebDAV GET ${path} returned ${response.status}`,
        response.status
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async getText(path: string): Promise<string | null> {
    const bytes = await this.get(path);
    return bytes === null ? null : Buffer.from(bytes).toString("utf8");
  }

  async put(path: string, body: Uint8Array | string): Promise<void> {
    const response = await this.request("PUT", path, {
      body: typeof body === "string" ? body : new Uint8Array(body),
      headers: { "content-type": "application/octet-stream" }
    });
    if (!response.ok && response.status !== 204) {
      throw new WebdavError(
        `WebDAV PUT ${path} returned ${response.status}`,
        response.status
      );
    }
  }

  async mkcol(path: string): Promise<void> {
    const response = await this.request("MKCOL", path);
    // 405 means the collection already exists, which is not an error here.
    if (!response.ok && response.status !== 405) {
      throw new WebdavError(
        `WebDAV MKCOL ${path} returned ${response.status}`,
        response.status
      );
    }
  }

  /** Creates every missing ancestor collection of a directory path. */
  async ensureCollection(path: string): Promise<void> {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let current = "";
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      await this.mkcol(current);
    }
  }

  async list(path: string, depth: "1" | "infinity" = "1"): Promise<WebdavEntry[]> {
    const response = await this.request("PROPFIND", path, {
      headers: { depth, "content-type": "application/xml" },
      body: PROPFIND_BODY
    });
    if (response.status === 404) {
      return [];
    }
    if (response.status !== 207 && !response.ok) {
      throw new WebdavError(
        `WebDAV PROPFIND ${path} returned ${response.status}`,
        response.status
      );
    }
    return parsePropfind(await response.text(), this.baseUrl);
  }
}

/**
 * Extracts responses from a multistatus body without a full XML parser. The
 * controller only needs href, collection flag, length, and mtime, and WebDAV
 * multistatus is regular enough that a scan is reliable for those fields.
 */
export function parsePropfind(xml: string, baseUrl: string): WebdavEntry[] {
  const entries: WebdavEntry[] = [];
  const basePath = new URL(baseUrl).pathname;
  const blocks = xml.match(/<[a-zA-Z0-9]*:?response[\s>][\s\S]*?<\/[a-zA-Z0-9]*:?response>/g);
  for (const block of blocks ?? []) {
    const href = tag(block, "href");
    if (href === null) {
      continue;
    }
    let pathname: string;
    try {
      pathname = new URL(href, baseUrl).pathname;
    } catch {
      continue;
    }
    const relative = decodeURIComponent(
      pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
    ).replace(/^\/+|\/+$/g, "");
    if (relative.length === 0) {
      continue;
    }
    const isDirectory = /<[a-zA-Z0-9]*:?collection\s*\/?>/.test(block);
    const length = tag(block, "getcontentlength");
    const modified = tag(block, "getlastmodified");
    const parsedModified = modified === null ? Number.NaN : Date.parse(modified);
    entries.push({
      href: relative,
      name: relative.split("/").pop() ?? relative,
      isDirectory,
      size: length === null ? 0 : Number.parseInt(length, 10) || 0,
      lastModified: Number.isNaN(parsedModified)
        ? null
        : Math.floor(parsedModified / 1000)
    });
  }
  return entries;
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(
    `<[a-zA-Z0-9]*:?${name}[^>]*>([\\s\\S]*?)</[a-zA-Z0-9]*:?${name}>`
  ).exec(block);
  return match === null ? null : match[1].trim();
}

/** Content-addressed object location, sharded to keep collections small. */
export function objectPath(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new WebdavError(`digest must be lowercase SHA-256 hex: ${digest}`);
  }
  return `objects/${digest.slice(0, 2)}/${digest}`;
}

export function manifestPath(deviceId: string): string {
  return `manifests/${deviceId}.json`;
}
