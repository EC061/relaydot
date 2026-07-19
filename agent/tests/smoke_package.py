"""Smoke checks run against built wheel and source distributions."""

from __future__ import annotations

from typer.testing import CliRunner

from relaydot.cli import DEFAULT_POLICY, app

assert DEFAULT_POLICY.is_file(), DEFAULT_POLICY

runner = CliRunner()

version = runner.invoke(app, ["--version"])
assert version.exit_code == 0, version.output
assert version.stdout.strip() != "0.0.0"

validation = runner.invoke(app, ["config", "validate"])
assert validation.exit_code == 0, validation.output
assert "full-mirror-retain-forever" in validation.stdout
