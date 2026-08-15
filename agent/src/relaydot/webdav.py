"""Minimal WebDAV client for the shared content-addressed object store.

Agents talk to WebDAV directly so file bytes never traverse the controller. The
controller reads the same layout to derive usage analytics, which is why the
path helpers here mirror ``apps/web/src/lib/webdav.ts`` exactly:

    objects/<first two hex>/<sha256>   immutable file content
    manifests/<device id>.json         what one device published

Only the verbs that layout needs are implemented: HEAD to test for an existing
digest, GET, PUT, MKCOL, and PROPFIND to enumerate manifests.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from types import TracebackType
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

import httpx

from .errors import StorageError

_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_RESPONSE = re.compile(r"<[a-zA-Z0-9]*:?response[\s>].*?</[a-zA-Z0-9]*:?response>", re.DOTALL)
_COLLECTION = re.compile(r"<[a-zA-Z0-9]*:?collection\s*/?>")

PROPFIND_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<d:propfind xmlns:d="DAV:"><d:prop>'
    "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>"
    "</d:prop></d:propfind>"
)


def object_path(digest: str) -> str:
    """Content-addressed location, sharded so no collection grows unbounded."""

    if not _DIGEST.match(digest):
        raise StorageError(f"digest must be lowercase SHA-256 hex: {digest}")
    return f"objects/{digest[:2]}/{digest}"


def manifest_path(device_id: str) -> str:
    if not device_id or "/" in device_id:
        raise StorageError(f"device id is not a usable path segment: {device_id!r}")
    return f"manifests/{device_id}.json"


def normalize_base_url(raw: str) -> str:
    """Return the base URL with exactly one trailing slash."""

    trimmed = raw.strip()
    if not trimmed:
        raise StorageError("WebDAV base URL must not be empty")
    parts = urlsplit(trimmed)
    if parts.scheme not in ("http", "https"):
        raise StorageError("WebDAV base URL must use http or https")
    if not parts.netloc:
        raise StorageError(f"WebDAV base URL is not absolute: {trimmed}")
    path = parts.path if parts.path.endswith("/") else f"{parts.path}/"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


@dataclass(frozen=True, slots=True)
class WebdavEntry:
    href: str
    name: str
    is_directory: bool
    size: int
    last_modified: int | None


def parse_propfind(xml: str, base_path: str) -> tuple[WebdavEntry, ...]:
    """Extract the four fields the agent needs from a multistatus body.

    A full XML parser is not required for href, collection flag, length, and
    mtime, and avoiding one keeps the agent free of an XML dependency whose
    entity handling would need auditing.
    """

    entries: list[WebdavEntry] = []
    for block in _RESPONSE.findall(xml):
        href = _tag(block, "href")
        if href is None:
            continue
        path = urlsplit(href).path
        relative = unquote(path)
        prefix = unquote(base_path)
        if relative.startswith(prefix):
            relative = relative[len(prefix) :]
        relative = relative.strip("/")
        if not relative:
            continue
        length = _tag(block, "getcontentlength")
        modified = _tag(block, "getlastmodified")
        entries.append(
            WebdavEntry(
                href=relative,
                name=relative.rsplit("/", 1)[-1],
                is_directory=bool(_COLLECTION.search(block)),
                size=int(length) if length and length.isdigit() else 0,
                last_modified=_http_date(modified),
            )
        )
    return tuple(entries)


def _tag(block: str, name: str) -> str | None:
    match = re.search(rf"<[a-zA-Z0-9]*:?{name}[^>]*>(.*?)</[a-zA-Z0-9]*:?{name}>", block, re.DOTALL)
    return match.group(1).strip() if match else None


def _http_date(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed: datetime = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return int(parsed.timestamp())


class WebdavClient:
    """Basic-auth WebDAV over an injectable httpx client."""

    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        client: httpx.Client | None = None,
        *,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self.base_path = urlsplit(self.base_url).path
        self._auth = (username, password)
        self._client = client or httpx.Client(timeout=timeout)
        self._owns_client = client is None

    @classmethod
    def from_config(
        cls, config: dict[str, Any], client: httpx.Client | None = None
    ) -> WebdavClient:
        """Build from the payload the controller hands an enrolled device."""

        try:
            return cls(
                str(config["base_url"]),
                str(config["username"]),
                str(config["password"]),
                client,
            )
        except KeyError as exc:
            raise StorageError(f"storage configuration is missing {exc.args[0]}") from exc

    def __enter__(self) -> WebdavClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def url(self, path: str) -> str:
        encoded = "/".join(quote(part, safe="") for part in path.split("/") if part)
        return urljoin(self.base_url, encoded)

    def _request(
        self,
        method: str,
        path: str,
        *,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        try:
            response = self._client.request(
                method,
                self.url(path),
                auth=self._auth,
                content=content,
                headers=headers,
                follow_redirects=True,
            )
        except httpx.HTTPError as exc:
            raise StorageError(f"WebDAV {method} {path} failed: {exc}") from exc
        # Checked centrally so every verb reports a bad credential the same way
        # instead of surfacing as a confusing per-method failure.
        if response.status_code in (401, 403):
            raise StorageError("WebDAV rejected the credential")
        return response

    def exists(self, path: str) -> bool:
        """Test for a resource with a depth-0 PROPFIND rather than HEAD.

        HEAD would be cheaper, but WsgiDAV — and it is unlikely to be alone —
        answers a 404 HEAD with a ``Content-Length`` for an error page it then
        correctly does not send. That leaves a keep-alive connection expecting
        bytes that never arrive, and the *next* response on it is parsed as a
        status line and fails. Since a sync probes for many digests on one
        connection, that turns into an unusable client. PROPFIND always sends
        the body it declares, so the connection stays consistent.
        """

        response = self._request(
            "PROPFIND",
            path,
            content=PROPFIND_BODY.encode(),
            headers={"Depth": "0", "Content-Type": "application/xml"},
        )
        if response.status_code == 404:
            return False
        if response.status_code not in (200, 207):
            raise StorageError(f"WebDAV PROPFIND {path} returned {response.status_code}")
        return True

    def get_bytes(self, path: str) -> bytes | None:
        response = self._request("GET", path)
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise StorageError(f"WebDAV GET {path} returned {response.status_code}")
        return response.content

    def put_bytes(self, path: str, data: bytes) -> None:
        self.ensure_collection(path.rsplit("/", 1)[0] if "/" in path else "")
        response = self._request(
            "PUT",
            path,
            content=data,
            headers={"Content-Type": "application/octet-stream"},
        )
        if response.status_code >= 400:
            raise StorageError(f"WebDAV PUT {path} returned {response.status_code}")

    def mkcol(self, path: str) -> None:
        response = self._request("MKCOL", path)
        # 405 and 409-after-create races both mean "already there".
        if response.status_code >= 400 and response.status_code not in (405, 409):
            raise StorageError(f"WebDAV MKCOL {path} returned {response.status_code}")

    def ensure_collection(self, path: str) -> None:
        current = ""
        for segment in [part for part in path.split("/") if part]:
            current = segment if not current else f"{current}/{segment}"
            self.mkcol(current)

    def list(self, path: str, depth: str = "1") -> tuple[WebdavEntry, ...]:
        response = self._request(
            "PROPFIND",
            path,
            content=PROPFIND_BODY.encode(),
            headers={"Depth": depth, "Content-Type": "application/xml"},
        )
        if response.status_code == 404:
            return ()
        if response.status_code not in (200, 207):
            raise StorageError(f"WebDAV PROPFIND {path} returned {response.status_code}")
        return parse_propfind(response.text, self.base_path)
