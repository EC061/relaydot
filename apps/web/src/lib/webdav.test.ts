import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WebdavClient,
  WebdavError,
  manifestPath,
  normalizeBaseUrl,
  objectPath,
  parsePropfind
} from "./webdav";

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/objects/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/objects/ab/abc%20def</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/>
      <D:getcontentlength>1234</D:getcontentlength>
      <D:getlastmodified>Wed, 13 Aug 2026 07:00:00 GMT</D:getlastmodified>
    </D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

describe("WebDAV addressing", () => {
  it("normalizes base URLs to a single trailing slash", () => {
    expect(normalizeBaseUrl("https://dav.test/remote.php/dav")).toBe(
      "https://dav.test/remote.php/dav/"
    );
    expect(normalizeBaseUrl("https://dav.test/x/?a=1#f")).toBe("https://dav.test/x/");
    expect(() => normalizeBaseUrl("  ")).toThrow(WebdavError);
    expect(() => normalizeBaseUrl("not a url")).toThrow(WebdavError);
    expect(() => normalizeBaseUrl("ftp://dav.test/x")).toThrow(WebdavError);
  });

  it("shards object paths by digest prefix and rejects bad digests", () => {
    const digest = "a".repeat(64);
    expect(objectPath(digest)).toBe(`objects/aa/${digest}`);
    expect(() => objectPath("short")).toThrow(WebdavError);
    expect(() => objectPath("A".repeat(64))).toThrow(WebdavError);
    expect(manifestPath("dev-1")).toBe("manifests/dev-1.json");
  });

  it("percent-encodes each path segment", () => {
    const client = new WebdavClient({
      baseUrl: "https://dav.test/base/",
      username: "u",
      password: "p"
    });
    expect(client.url("manifests/a b.json")).toBe(
      "https://dav.test/base/manifests/a%20b.json"
    );
  });

  it("extracts entries, sizes, and mtimes from a multistatus body", () => {
    const entries = parsePropfind(MULTISTATUS, "https://dav.test/dav/");
    // The collection itself is skipped; children are relative to the base.
    expect(entries.map((entry) => entry.href)).toEqual([
      "objects",
      "objects/ab/abc def"
    ]);
    expect(entries[0].isDirectory).toBe(true);
    const file = entries[1];
    expect(file.isDirectory).toBe(false);
    expect(file.size).toBe(1234);
    expect(file.lastModified).toBe(Math.floor(Date.parse("2026-08-13T07:00:00Z") / 1000));
  });

  it("sends basic auth and surfaces credential rejection", async () => {
    let seen = "";
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "bob", password: "s3cret" },
      async (_url, init) => {
        seen = String((init?.headers as Record<string, string>).authorization);
        return new Response("", { status: 401 });
      }
    );
    await expect(client.list("objects")).rejects.toThrow(/rejected the credential/);
    expect(seen).toBe(`Basic ${Buffer.from("bob:s3cret").toString("base64")}`);
  });

  it("treats a missing object as null rather than an error", async () => {
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async () => new Response("", { status: 404 })
    );
    expect(await client.get("objects/aa/missing")).toBeNull();
    expect(await client.list("objects")).toEqual([]);
  });

  it("creates every ancestor collection and tolerates existing ones", async () => {
    const created: string[] = [];
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async (url, init) => {
        if (init?.method === "MKCOL") {
          created.push(new URL(String(url)).pathname);
          // 405 is how servers report "collection already exists".
          return new Response("", { status: created.length === 1 ? 405 : 201 });
        }
        return new Response("", { status: 200 });
      }
    );
    await client.ensureCollection("objects/ab");
    expect(created).toEqual(["/objects", "/objects/ab"]);
  });

  it("tests existence with a depth-0 PROPFIND and never HEAD", async () => {
    const seen: Array<{ method: string; depth: string | undefined }> = [];
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async (_url, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ method: String(init?.method), depth: headers.get("depth") ?? undefined });
        return new Response("", { status: 207 });
      }
    );
    expect(await client.exists("objects")).toBe(true);
    // HEAD is avoided deliberately: a 404 HEAD from at least one widely
    // deployed server announces a body it does not send, which desynchronizes
    // a keep-alive connection and breaks the following request.
    expect(seen).toEqual([{ method: "PROPFIND", depth: "0" }]);
  });

  it("surfaces non-success statuses for GET, PUT, MKCOL, and PROPFIND", async () => {
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async () => new Response("", { status: 500 })
    );
    await expect(client.get("objects/aa/x")).rejects.toThrow(/GET .* returned 500/);
    await expect(client.put("objects/aa/x", "body")).rejects.toThrow(
      /PUT .* returned 500/
    );
    await expect(client.mkcol("objects")).rejects.toThrow(/MKCOL .* returned 500/);
    await expect(client.list("objects")).rejects.toThrow(/PROPFIND .* returned 500/);
    await expect(client.exists("objects")).rejects.toThrow(/PROPFIND .* returned 500/);
  });

  it("accepts 204 from PUT and reads text bodies", async () => {
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async (_url, init) =>
        init?.method === "PUT"
          ? new Response(null, { status: 204 })
          : new Response("stored", { status: 200 })
    );
    await expect(client.put("objects/aa/x", new Uint8Array([1]))).resolves.toBeUndefined();
    expect(await client.getText("objects/aa/x")).toBe("stored");
  });

  it("returns null text for a missing object", async () => {
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async () => new Response("", { status: 404 })
    );
    expect(await client.getText("manifests/gone.json")).toBeNull();
    expect(await client.exists("manifests/gone.json")).toBe(false);
  });

  it("skips multistatus entries that are unusable", () => {
    const body =
      '<d:multistatus xmlns:d="DAV:">' +
      // No href at all, so nothing to address.
      "<d:response><d:propstat/></d:response>" +
      // The collection itself, which is not a child entry.
      "<d:response><d:href>/dav/</d:href></d:response>" +
      // An unparseable modified date must not become a bogus timestamp.
      "<d:response><d:href>/dav/plain</d:href>" +
      "<d:getlastmodified>never</d:getlastmodified></d:response>" +
      "</d:multistatus>";
    const entries = parsePropfind(body, "https://dav.test/dav/");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      href: "plain",
      name: "plain",
      isDirectory: false,
      size: 0,
      lastModified: null
    });
    expect(parsePropfind("no responses here", "https://dav.test/dav/")).toEqual([]);
  });

  it("wraps transport failures with the verb and cause", async () => {
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async () => {
        throw new Error("ECONNREFUSED");
      }
    );
    await expect(client.get("objects/aa/x")).rejects.toThrow(
      /WebDAV GET failed: ECONNREFUSED/
    );
  });
});

/**
 * Exercises the client against a real WebDAV server when one is running.
 * Start one with:
 *   uvx --from wsgidav --with cheroot wsgidav --port 4999 --root /tmp/dav-root \
 *     --auth anonymous
 */
const LIVE = process.env.RELAYDOT_WEBDAV_TEST_URL;

describe.skipIf(LIVE === undefined)("WebDAV against a live server", () => {
  it("round-trips content-addressed objects and manifests", async () => {
    const client = new WebdavClient({
      baseUrl: LIVE as string,
      username: process.env.RELAYDOT_WEBDAV_TEST_USER ?? "u",
      password: process.env.RELAYDOT_WEBDAV_TEST_PASS ?? "p"
    });

    const body = Buffer.from(`relaydot live probe ${LIVE}\n`);
    const digest = createHash("sha256").update(body).digest("hex");
    const path = objectPath(digest);

    await client.ensureCollection(path.split("/").slice(0, -1).join("/"));
    await client.put(path, body);

    expect(await client.exists(path)).toBe(true);
    const fetched = await client.get(path);
    expect(fetched).not.toBeNull();
    expect(Buffer.from(fetched as Uint8Array).equals(body)).toBe(true);
    // A digest that was never written must report absent, which is what makes
    // hash-based dedup safe.
    expect(await client.exists(objectPath("0".repeat(64)))).toBe(false);

    await client.ensureCollection("manifests");
    await client.put(manifestPath("live-device"), JSON.stringify({ entries: [] }));
    const listed = await client.list("manifests", "1");
    expect(listed.some((entry) => entry.href === "manifests/live-device.json")).toBe(
      true
    );
    const found = listed.find((entry) => entry.href === "manifests/live-device.json");
    expect(found?.isDirectory).toBe(false);
    expect(found?.lastModified).not.toBeNull();
  });
});
