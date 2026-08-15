"""An in-memory WebDAV server good enough to exercise the real client.

The agent's storage layer is only trustworthy if the request it builds is the
request a server would accept, so the tests drive httpx through a transport that
implements the verbs for real rather than stubbing the client itself.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from email.utils import format_datetime
from urllib.parse import quote, unquote

import httpx

BASE_URL = "https://dav.test/dav/"
_PREFIX = "/dav/"


class FakeDav:
    def __init__(self, username: str = "user", password: str = "pass") -> None:
        self.files: dict[str, bytes] = {}
        self.collections: set[str] = set()
        self.username = username
        self.password = password
        self.log: list[tuple[str, str]] = []
        self.modified: dict[str, datetime] = {}

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport())

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = unquote(request.url.path)
        if not path.startswith(_PREFIX):
            return httpx.Response(404)
        relative = path[len(_PREFIX) :].strip("/")
        self.log.append((request.method, relative))
        if not self._authorized(request):
            return httpx.Response(401)
        handler = getattr(self, f"_{request.method.lower()}", None)
        if handler is None:
            return httpx.Response(405)
        return handler(relative, request)

    def _authorized(self, request: httpx.Request) -> bool:
        header = request.headers.get("authorization", "")
        if not header.startswith("Basic "):
            return False
        decoded = base64.b64decode(header[6:]).decode()
        return decoded == f"{self.username}:{self.password}"

    def _head(self, relative: str, _request: httpx.Request) -> httpx.Response:
        if relative in self.collections:
            return httpx.Response(405)
        return httpx.Response(200 if relative in self.files else 404)

    def _get(self, relative: str, _request: httpx.Request) -> httpx.Response:
        content = self.files.get(relative)
        return httpx.Response(404) if content is None else httpx.Response(200, content=content)

    def _put(self, relative: str, request: httpx.Request) -> httpx.Response:
        parent = relative.rsplit("/", 1)[0] if "/" in relative else ""
        if parent and parent not in self.collections:
            return httpx.Response(409)
        self.files[relative] = request.content
        self.modified[relative] = datetime.now(UTC)
        return httpx.Response(201)

    def _mkcol(self, relative: str, _request: httpx.Request) -> httpx.Response:
        if relative in self.collections:
            return httpx.Response(405)
        self.collections.add(relative)
        return httpx.Response(201)

    def _propfind(self, relative: str, request: httpx.Request) -> httpx.Response:
        depth = request.headers.get("depth", "1")
        if relative and relative not in self.collections and relative not in self.files:
            return httpx.Response(404)
        members = [relative] if relative else []
        if depth != "0":
            prefix = f"{relative}/" if relative else ""
            members.extend(
                name
                for name in sorted(self.files)
                if name.startswith(prefix) and "/" not in name[len(prefix) :]
            )
            members.extend(
                name
                for name in sorted(self.collections)
                if name.startswith(prefix) and name != relative and "/" not in name[len(prefix) :]
            )
        blocks = "".join(self._describe(name) for name in members)
        body = f'<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">{blocks}</D:multistatus>'
        return httpx.Response(207, text=body)

    def _describe(self, name: str) -> str:
        href = _PREFIX + "/".join(quote(part, safe="") for part in name.split("/") if part)
        if name in self.collections:
            return (
                f"<D:response><D:href>{href}/</D:href><D:propstat><D:prop>"
                "<D:resourcetype><D:collection/></D:resourcetype>"
                "</D:prop></D:propstat></D:response>"
            )
        stamp = format_datetime(self.modified.get(name, datetime.now(UTC)), usegmt=True)
        return (
            f"<D:response><D:href>{href}</D:href><D:propstat><D:prop>"
            "<D:resourcetype/>"
            f"<D:getcontentlength>{len(self.files[name])}</D:getcontentlength>"
            f"<D:getlastmodified>{stamp}</D:getlastmodified>"
            "</D:prop></D:propstat></D:response>"
        )
