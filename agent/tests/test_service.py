from __future__ import annotations

import plistlib
from pathlib import Path

import pytest

from relaydot.service import ServiceInstaller


def test_systemd_install_and_start(tmp_path: Path) -> None:
    commands: list[list[str]] = []
    installer = ServiceInstaller(
        system="Linux",
        home=tmp_path,
        executable=Path("/opt/relaydot"),
        runner=lambda command: commands.append(list(command)),
    )
    path = installer.install(tmp_path / "agent.json", tmp_path / "policy.yaml", 10, start=True)
    assert path == tmp_path / ".config/systemd/user/relaydot.service"
    assert "ExecStart=/opt/relaydot service run" in path.read_text()
    assert commands == [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "relaydot.service"],
    ]


def test_launchd_install_without_start(tmp_path: Path) -> None:
    commands: list[list[str]] = []
    installer = ServiceInstaller(
        system="Darwin",
        home=tmp_path,
        executable=Path("/opt/relaydot"),
        runner=lambda command: commands.append(list(command)),
    )
    path = installer.install(tmp_path / "agent.json", tmp_path / "policy.yaml", 5, start=False)
    assert path is not None
    payload = plistlib.loads(path.read_bytes())
    assert payload["Label"] == "dev.relaydot.agent"
    assert payload["ProgramArguments"][:3] == ["/opt/relaydot", "service", "run"]
    assert commands == []


def test_windows_scheduled_task_install_and_run(tmp_path: Path) -> None:
    commands: list[list[str]] = []
    installer = ServiceInstaller(
        system="Windows",
        home=tmp_path,
        executable=Path("C:/relaydot.exe"),
        runner=lambda command: commands.append(list(command)),
    )
    assert (
        installer.install(tmp_path / "agent.json", tmp_path / "policy.yaml", 10, start=True) is None
    )
    assert commands[0][:4] == ["schtasks", "/Create", "/TN", "Relaydot Agent"]
    assert commands[1] == ["schtasks", "/Run", "/TN", "Relaydot Agent"]


def test_unsupported_service_platform(tmp_path: Path) -> None:
    installer = ServiceInstaller(system="Plan9", home=tmp_path)
    with pytest.raises(RuntimeError, match="unsupported service platform"):
        installer.install(tmp_path / "agent.json", tmp_path / "policy.yaml", 10, start=False)
