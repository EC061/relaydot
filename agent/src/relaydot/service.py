"""Per-user service installation for managed endpoint agents."""

from __future__ import annotations

import os
import platform
import plistlib
import shlex
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

Runner = Callable[[Sequence[str]], object]


def _default_runner(command: Sequence[str]) -> object:
    return subprocess.run(command, check=True)


class ServiceInstaller:
    def __init__(
        self,
        *,
        system: str | None = None,
        home: Path | None = None,
        executable: Path | None = None,
        runner: Runner = _default_runner,
    ) -> None:
        self.system = system or platform.system()
        self.home = (home or Path.home()).expanduser()
        self.executable = executable or Path(sys.argv[0]).resolve()
        self.runner = runner

    def install(
        self,
        state: Path,
        policy: Path,
        interval: float,
        *,
        start: bool,
    ) -> Path | None:
        command = [
            str(self.executable),
            "service",
            "run",
            "--state",
            str(state.expanduser().resolve()),
            "--policy",
            str(policy.expanduser().resolve()),
            "--interval",
            str(interval),
        ]
        if self.system == "Linux":
            path = self.home / ".config/systemd/user/relaydot.service"
            content = (
                "[Unit]\n"
                "Description=Relaydot managed-node agent\n"
                "After=network-online.target\n"
                "Wants=network-online.target\n\n"
                "[Service]\n"
                f"ExecStart={shlex.join(command)}\n"
                "Restart=on-failure\n"
                "RestartSec=5\n\n"
                "[Install]\n"
                "WantedBy=default.target\n"
            )
            self._write(path, content.encode())
            self.runner(["systemctl", "--user", "daemon-reload"])
            if start:
                self.runner(["systemctl", "--user", "enable", "--now", "relaydot.service"])
            return path
        if self.system == "Darwin":
            path = self.home / "Library/LaunchAgents/dev.relaydot.agent.plist"
            payload = plistlib.dumps(
                {
                    "Label": "dev.relaydot.agent",
                    "ProgramArguments": command,
                    "RunAtLoad": True,
                    "KeepAlive": {"SuccessfulExit": False},
                    "ProcessType": "Background",
                }
            )
            self._write(path, payload)
            if start:
                domain = f"gui/{os.getuid()}"
                self.runner(["launchctl", "bootstrap", domain, str(path)])
            return path
        if self.system == "Windows":
            task_command = subprocess.list2cmdline(command)
            self.runner(
                [
                    "schtasks",
                    "/Create",
                    "/TN",
                    "Relaydot Agent",
                    "/TR",
                    task_command,
                    "/SC",
                    "ONLOGON",
                    "/F",
                ]
            )
            if start:
                self.runner(["schtasks", "/Run", "/TN", "Relaydot Agent"])
            return None
        raise RuntimeError(f"unsupported service platform: {self.system}")

    @staticmethod
    def _write(path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.tmp")
        temporary.write_bytes(payload)
        temporary.chmod(0o600)
        temporary.replace(path)
