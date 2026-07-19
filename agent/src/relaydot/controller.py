"""Authenticated controller protocol and foreground endpoint service."""

from __future__ import annotations

import json
import platform
import socket
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from . import __version__
from .manifest import build_manifest
from .policy import load_policy


@dataclass(frozen=True)
class AgentCredentials:
    server: str
    device_id: str
    device_token: str
    name: str


class StateStore:
    def __init__(self, path: Path) -> None:
        self.path = path.expanduser()

    def save(self, credentials: AgentCredentials) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(asdict(credentials), indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(self.path)
        self.path.chmod(0o600)

    def load(self) -> AgentCredentials:
        payload = json.loads(self.path.read_text())
        return AgentCredentials(
            server=str(payload["server"]),
            device_id=str(payload["device_id"]),
            device_token=str(payload["device_token"]),
            name=str(payload["name"]),
        )


class ControllerClient:
    def __init__(self, server: str, client: httpx.Client | None = None) -> None:
        self.server = server.rstrip("/")
        self.client = client or httpx.Client(timeout=30)
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def enroll(self, token: str, name: str, public_key: str | None = None) -> AgentCredentials:
        response = self.client.post(
            f"{self.server}/api/v1/enroll",
            json={
                "token": token,
                "name": name,
                "platform": platform.system().lower(),
                "agent_version": __version__,
                "public_key": public_key,
            },
        )
        response.raise_for_status()
        payload = response.json()
        return AgentCredentials(
            server=self.server,
            device_id=str(payload["device_id"]),
            device_token=str(payload["device_token"]),
            name=name,
        )

    def heartbeat(self, credentials: AgentCredentials) -> dict[str, Any]:
        response = self.client.post(
            f"{self.server}/api/v1/devices/{credentials.device_id}/heartbeat",
            headers=self._headers(credentials),
            json={"agent_version": __version__},
        )
        response.raise_for_status()
        return dict(response.json())

    def claim(self, credentials: AgentCredentials, limit: int = 10) -> list[dict[str, Any]]:
        response = self.client.post(
            f"{self.server}/api/v1/devices/{credentials.device_id}/commands/claim",
            params={"limit": limit},
            headers=self._headers(credentials),
        )
        response.raise_for_status()
        return list(response.json())

    def acknowledge(
        self,
        credentials: AgentCredentials,
        command_id: str,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        response = self.client.post(
            f"{self.server}/api/v1/devices/{credentials.device_id}/commands/{command_id}/ack",
            headers=self._headers(credentials),
            json={"status": status, "result": result, "error": error},
        )
        response.raise_for_status()
        return dict(response.json())

    @staticmethod
    def _headers(credentials: AgentCredentials) -> dict[str, str]:
        return {"Authorization": f"Bearer {credentials.device_token}"}


class AgentService:
    def __init__(
        self,
        credentials: AgentCredentials,
        client: ControllerClient,
        policy: Path,
        home: Path | None = None,
    ) -> None:
        self.credentials = credentials
        self.client = client
        self.policy = policy
        self.home = home

    def run_once(self) -> list[dict[str, Any]]:
        self.client.heartbeat(self.credentials)
        outcomes: list[dict[str, Any]] = []
        for command in self.client.claim(self.credentials):
            command_id = str(command["id"])
            try:
                result = self._execute(str(command["type"]))
                status, error = "succeeded", None
            except Exception as exc:
                result, status, error = None, "failed", str(exc)
            self.client.acknowledge(
                self.credentials,
                command_id,
                status,
                result=result,
                error=error,
            )
            outcomes.append({"id": command_id, "status": status, "result": result, "error": error})
        return outcomes

    def run_forever(self, interval: float = 10) -> None:
        while True:
            self.run_once()
            time.sleep(interval)

    def _execute(self, command_type: str) -> dict[str, Any]:
        if command_type in {"sync", "reload_policy"}:
            policy = load_policy(self.policy, home=self.home)
            if command_type == "reload_policy":
                return {"policy": policy.name, "roots": len(policy.roots)}
            manifest = build_manifest(policy)
            return {
                "digest": manifest.digest,
                "files": len(manifest.entries),
                "bytes": sum(entry.size for entry in manifest.entries),
            }
        if command_type == "collect_diagnostics":
            return {
                "agent_version": __version__,
                "hostname": socket.gethostname(),
                "platform": platform.system().lower(),
                "python": platform.python_version(),
            }
        if command_type == "update_agent":
            raise RuntimeError("remote package updates are not enabled in this agent build")
        raise RuntimeError(f"unsupported command type: {command_type}")
