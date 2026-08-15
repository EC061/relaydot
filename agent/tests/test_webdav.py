from __future__ import annotations

import hashlib

import httpx
import pytest
from fakedav import BASE_URL, FakeDav

from relaydot.errors import StorageError
from relaydot.webdav import (
    WebdavClient,
    manifest_path,
    normalize_base_url,
    object_path,
    parse_propfind,
)


def make_client(dav: FakeDav, password: str = "pass") -> WebdavClient:
    return WebdavClient(BASE_URL, dav.username, password, dav.client())


def test_normalize_base_url_adds_one_trailing_slash() -> None:
    assert normalize_base_url(" https://dav.test/dav ") == "https://dav.test/dav/"
    assert normalize_base_url("https://dav.test/dav/") == "https://dav.test/dav/"
    assert normalize_base_url("https://dav.test") == "https://dav.test/"


@pytest.mark.parametrize(
    "value",
    ["", "   ", "ftp://dav.test/", "/relative/path", "not a url"],
)
def test_normalize_base_url_rejects_unusable_values(value: str) -> None:
    with pytest.raises(StorageError):
        normalize_base_url(value)


def test_object_path_is_sharded_and_requires_a_sha256() -> None:
    digest = hashlib.sha256(b"payload").hexdigest()
    assert object_path(digest) == f"objects/{digest[:2]}/{digest}"
    with pytest.raises(StorageError):
        object_path("not-a-digest")
    with pytest.raises(StorageError):
        object_path(digest.upper())


def test_manifest_path_rejects_a_traversing_device_id() -> None:
    assert manifest_path("device-1") == "manifests/device-1.json"
    with pytest.raises(StorageError):
        manifest_path("../escape")
    with pytest.raises(StorageError):
        manifest_path("")


def test_round_trip_through_a_real_transport() -> None:
    dav = FakeDav()
    client = make_client(dav)
    digest = hashlib.sha256(b"hello").hexdigest()

    assert client.exists(object_path(digest)) is False
    client.put_bytes(object_path(digest), b"hello")
    assert client.exists(object_path(digest)) is True
    assert client.get_bytes(object_path(digest)) == b"hello"
    assert client.get_bytes("objects/zz/missing") is None
    client.close()


def test_put_creates_every_missing_ancestor_collection() -> None:
    dav = FakeDav()
    client = make_client(dav)
    client.put_bytes("objects/ab/cd/deep.bin", b"x")
    assert {"objects", "objects/ab", "objects/ab/cd"} <= dav.collections
    client.close()


def test_listing_reports_names_sizes_and_modification_times() -> None:
    dav = FakeDav()
    client = make_client(dav)
    client.put_bytes("manifests/one.json", b"{}")
    client.put_bytes("manifests/two.json", b"{'a':1}")

    entries = client.list("manifests", "1")
    files = {entry.name: entry for entry in entries if not entry.is_directory}
    assert set(files) == {"one.json", "two.json"}
    assert files["one.json"].href == "manifests/one.json"
    assert files["one.json"].size == 2
    assert files["one.json"].last_modified is not None
    assert client.list("manifests/absent") == ()
    client.close()


def test_existence_uses_propfind_so_a_connection_is_never_left_dirty() -> None:
    dav = FakeDav()
    client = make_client(dav)
    client.ensure_collection("objects")
    assert client.exists("objects") is True
    assert client.exists("objects/aa/absent") is False
    # HEAD is deliberately unused: a 404 HEAD from at least one widely
    # deployed server announces a body it does not send, which desynchronizes
    # the keep-alive connection and breaks the next request.
    assert all(method != "HEAD" for method, _ in dav.log)
    client.close()


def test_a_rejected_credential_reports_the_credential_not_the_verb() -> None:
    dav = FakeDav()
    client = make_client(dav, password="wrong")
    with pytest.raises(StorageError, match="rejected the credential"):
        client.exists("objects/aa/bb")
    client.close()


def test_transport_failures_surface_as_storage_errors() -> None:
    def explode(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    client = WebdavClient(
        BASE_URL, "user", "pass", httpx.Client(transport=httpx.MockTransport(explode))
    )
    with pytest.raises(StorageError, match="no route to host"):
        client.get_bytes("objects/aa/bb")
    client.close()


def test_server_errors_are_reported_per_verb() -> None:
    def fail(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = WebdavClient(
        BASE_URL, "user", "pass", httpx.Client(transport=httpx.MockTransport(fail))
    )
    with pytest.raises(StorageError, match="GET"):
        client.get_bytes("objects/aa/bb")
    with pytest.raises(StorageError, match="PROPFIND"):
        client.exists("objects/aa/bb")
    # A top-level name needs no MKCOL, so the failure reported is the PUT.
    with pytest.raises(StorageError, match="PUT"):
        client.put_bytes("blob", b"x")
    with pytest.raises(StorageError, match="MKCOL"):
        client.mkcol("objects")
    with pytest.raises(StorageError, match="PROPFIND"):
        client.list("manifests")
    client.close()


def test_from_config_reports_the_missing_field() -> None:
    dav = FakeDav()
    client = WebdavClient.from_config(
        {"base_url": BASE_URL, "username": "user", "password": "pass"}, dav.client()
    )
    assert client.base_url == BASE_URL
    client.close()
    with pytest.raises(StorageError, match="password"):
        WebdavClient.from_config({"base_url": BASE_URL, "username": "user"})


def test_client_is_usable_as_a_context_manager() -> None:
    dav = FakeDav()
    with WebdavClient(BASE_URL, "user", "pass", dav.client()) as client:
        client.put_bytes("manifests/a.json", b"{}")
    assert dav.files["manifests/a.json"] == b"{}"


def test_propfind_parser_tolerates_odd_and_unusable_entries() -> None:
    xml = (
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
        "<d:response><d:href>/dav/manifests/</d:href>"
        "<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>"
        "</d:prop></d:propstat></d:response>"
        "<d:response><d:href>/dav/</d:href></d:response>"
        "<d:response><d:propstat/></d:response>"
        "<d:response><d:href>/dav/manifests/one%20two.json</d:href>"
        "<d:propstat><d:prop><d:getcontentlength>not-a-number</d:getcontentlength>"
        "<d:getlastmodified>never</d:getlastmodified>"
        "</d:prop></d:propstat></d:response>"
        "</d:multistatus>"
    )
    entries = parse_propfind(xml, "/dav/")
    assert [entry.href for entry in entries] == ["manifests", "manifests/one two.json"]
    assert entries[0].is_directory is True
    # An unparsable length or date degrades to a usable default rather than
    # discarding an entry that otherwise names a real object.
    assert entries[1].size == 0
    assert entries[1].last_modified is None
