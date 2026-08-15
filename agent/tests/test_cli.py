from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from relaydot.cli import DEFAULT_POLICY, app

runner = CliRunner()


def test_version() -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.stdout.strip() == "0.1.0"


def test_packaged_default_policy_is_available() -> None:
    assert DEFAULT_POLICY.is_file()
    repository_policy = Path(__file__).parents[2] / "policies" / "recommended.yaml"
    assert DEFAULT_POLICY.read_bytes() == repository_policy.read_bytes()
    result = runner.invoke(app, ["config", "validate"])
    assert result.exit_code == 0
    assert "valid: curated-subset (2 roots)" in result.stdout


def test_doctor_reports_machine_readable_health() -> None:
    result = runner.invoke(app, ["doctor"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["relaydot"] == "0.1.0"
    assert payload["supported_python"] is True
    assert payload["platform"]


def test_config_validate_and_show(policy_file: Path, tmp_path: Path) -> None:
    valid = runner.invoke(
        app, ["config", "validate", "--policy", str(policy_file), "--home", str(tmp_path)]
    )
    assert valid.exit_code == 0
    assert "valid: test (2 roots)" in valid.stdout
    shown = runner.invoke(
        app, ["config", "show", "--policy", str(policy_file), "--home", str(tmp_path)]
    )
    assert shown.exit_code == 0
    payload = json.loads(shown.stdout)
    assert payload["roots"][0]["path"] == str(tmp_path / ".config-tool")


def test_config_validate_failure_is_nonzero(tmp_path: Path) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("kind: no")
    result = runner.invoke(app, ["config", "validate", "--policy", str(bad)])
    assert result.exit_code == 2
    assert "invalid:" in result.stderr


def test_inventory_reports_counts_without_content(policy_file: Path, tmp_path: Path) -> None:
    root = tmp_path / ".config-tool"
    root.mkdir()
    (root / "file").write_text("content")
    result = runner.invoke(
        app, ["sync", "inventory", "--policy", str(policy_file), "--home", str(tmp_path)]
    )
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["files"] == 1
    assert payload["bytes"] == 7
    assert "content" not in result.stdout


def test_sync_status_and_diff_report_local_state(policy_file: Path, tmp_path: Path) -> None:
    root = tmp_path / ".config-tool"
    root.mkdir()
    (root / "file").write_text("content")
    credential = tmp_path / "agent.json"
    credential.write_text(
        json.dumps(
            {
                "server": "https://controller.test",
                "device_id": "device-1",
                "device_token": "secret",
                "name": "lab-one",
            }
        )
    )
    shared = ["--state", str(credential), "--policy", str(policy_file), "--home", str(tmp_path)]

    status = runner.invoke(app, ["sync", "status", *shared])
    assert status.exit_code == 0
    payload = json.loads(status.stdout)
    assert payload["files"] == 1
    # Nothing has been exchanged yet, so no object is known and no path applied.
    assert payload["known_objects"] == 0
    assert payload["applied_paths"] == 0
    assert payload["state_path"].endswith("sync-state.json")

    diff = runner.invoke(app, ["sync", "diff", *shared])
    assert diff.exit_code == 0
    assert json.loads(diff.stdout) == {
        "added": ["config/file"],
        "changed": [],
        "removed": [],
    }
