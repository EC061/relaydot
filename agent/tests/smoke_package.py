"""Smoke checks run against built wheel and source distributions.

These run outside pytest, in an isolated environment containing only the built
artifact, so they catch what the test suite structurally cannot: a module that
was never packaged, or packaged data that does not ship alongside it.

Assertions here derive expectations from the artifact rather than repeating
constants from the source tree. A hardcoded policy name silently rotted through
a policy rename because nothing in `pnpm check` runs this file.
"""

from __future__ import annotations

import importlib

from typer.testing import CliRunner

from relaydot.cli import DEFAULT_POLICY, app
from relaydot.policy import load_policy

# Every module the agent needs at runtime has to be inside the distribution.
# Missing one only shows up here, because the test suite imports from source.
for module in (
    "relaydot.apply",
    "relaydot.bundle",
    "relaydot.controller",
    "relaydot.ignore",
    "relaydot.manifest",
    "relaydot.merge",
    "relaydot.paths",
    "relaydot.policy",
    "relaydot.secrets",
    "relaydot.service",
    "relaydot.streams",
    "relaydot.sync",
    "relaydot.usage",
    "relaydot.webdav",
):
    importlib.import_module(module)

# The recommended policy is package data, so it ships separately from the code.
assert DEFAULT_POLICY.is_file(), DEFAULT_POLICY
packaged = load_policy(DEFAULT_POLICY)
assert packaged.roots, "packaged policy declares no synchronization roots"

runner = CliRunner()

version = runner.invoke(app, ["--version"])
assert version.exit_code == 0, version.output
assert version.stdout.strip() != "0.0.0"

validation = runner.invoke(app, ["config", "validate"])
assert validation.exit_code == 0, validation.output
# Compared against the packaged policy itself, so renaming it cannot rot this.
assert f"valid: {packaged.name} ({len(packaged.roots)} roots)" in validation.stdout
