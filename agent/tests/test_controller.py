from __future__ import annotations

import json
import stat
from pathlib import Path

import httpx
import pytest

from relaydot.controller import (
    AgentCredentials,
    AgentService,
    ControllerClient,
    StateStore,
)


def credentials() -> AgentCredentials:
    return AgentCredentials("https://controller.test", "device-1", "secret", "lab-one")


def test_state_store_round_trip_is_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "state" / "agent.json"
    store = StateStore(path)
    store.save(credentials())
    assert store.load() == credentials()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text())["device_token"] == "secret"


def test_controller_client_complete_protocol() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/v1/enroll":
            return httpx.Response(201, json={"device_id": "device-1", "device_token": "secret"})
        if request.url.path.endswith("/heartbeat"):
            return httpx.Response(200, json={"server_time": 1})
        if request.url.path.endswith("/claim"):
            return httpx.Response(200, json=[{"id": "command-1", "type": "collect_diagnostics"}])
        return httpx.Response(200, json={"id": "command-1", "status": "succeeded"})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = ControllerClient("https://controller.test/", http)
    enrolled = client.enroll("one-time", "lab-one", "age-key")
    assert enrolled == credentials()
    assert client.heartbeat(enrolled) == {"server_time": 1}
    assert client.claim(enrolled) == [{"id": "command-1", "type": "collect_diagnostics"}]
    assert client.acknowledge(enrolled, "command-1", "succeeded", {"ok": True}) == {
        "id": "command-1",
        "status": "succeeded",
    }
    assert requests[1].headers["authorization"] == "Bearer secret"
    client.close()
    http.close()


def test_controller_client_owned_transport_and_http_errors() -> None:
    client = ControllerClient("https://controller.test")
    client.client = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(401))
    )
    with pytest.raises(httpx.HTTPStatusError):
        client.enroll("bad", "lab")
    client.close()


class StubController:
    def __init__(self, commands: list[dict[str, object]]) -> None:
        self.commands = commands
        self.acks: list[dict[str, object]] = []
        self.heartbeats = 0

    def heartbeat(self, _credentials: AgentCredentials) -> dict[str, object]:
        self.heartbeats += 1
        return {"server_time": 1}

    def claim(self, _credentials: AgentCredentials, limit: int = 10) -> list[dict[str, object]]:
        assert limit == 10
        return self.commands

    def acknowledge(
        self,
        _credentials: AgentCredentials,
        command_id: str,
        status: str,
        result: dict[str, object] | None = None,
        error: str | None = None,
    ) -> dict[str, object]:
        self.acks.append({"id": command_id, "status": status, "result": result, "error": error})
        return self.acks[-1]


def test_agent_service_executes_and_acknowledges_commands(
    policy_file: Path, tmp_path: Path
) -> None:
    root = tmp_path / ".config-tool"
    root.mkdir()
    (root / "settings.json").write_text("{}")
    stub = StubController(
        [
            {"id": "sync", "type": "sync"},
            {"id": "reload", "type": "reload_policy"},
            {"id": "doctor", "type": "collect_diagnostics"},
            {"id": "update", "type": "update_agent"},
            {"id": "bad", "type": "unknown"},
        ]
    )
    service = AgentService(
        credentials(),
        stub,  # type: ignore[arg-type]
        policy_file,
        home=tmp_path,
    )
    outcomes = service.run_once()
    assert stub.heartbeats == 1
    assert [outcome["status"] for outcome in outcomes] == [
        "succeeded",
        "succeeded",
        "succeeded",
        "failed",
        "failed",
    ]
    assert outcomes[0]["result"]["files"] == 1  # type: ignore[index]
    assert outcomes[1]["result"] == {"policy": "test", "roots": 2}
    assert "remote package updates" in str(outcomes[3]["error"])
    assert "unsupported command type" in str(outcomes[4]["error"])
