"""Relaydot command-line surface for local validation and diagnostics."""

from __future__ import annotations

import json
import platform
import sys
from pathlib import Path
from typing import Annotated

import typer

from . import __version__
from .errors import RelaydotError
from .manifest import build_manifest
from .policy import load_policy

app = typer.Typer(help="Relaydot endpoint synchronization agent", no_args_is_help=True)
config_app = typer.Typer(help="Validate and inspect local policy")
sync_app = typer.Typer(help="Inspect or synchronize local state")
app.add_typer(config_app, name="config")
app.add_typer(sync_app, name="sync")


def _default_policy() -> Path:
    return Path(__file__).resolve().parents[3] / "policies" / "recommended.yaml"


DEFAULT_POLICY = _default_policy()


@app.callback(invoke_without_command=True)
def main(
    version: Annotated[
        bool,
        typer.Option("--version", help="Show the installed version", is_eager=True),
    ] = False,
) -> None:
    if version:
        typer.echo(__version__)
        raise typer.Exit()


@config_app.command("validate")
def config_validate(
    policy: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_POLICY,
    home: Annotated[Path | None, typer.Option(file_okay=False)] = None,
) -> None:
    """Validate policy syntax and safety invariants."""

    try:
        parsed = load_policy(policy, home=home)
    except RelaydotError as exc:
        typer.echo(f"invalid: {exc}", err=True)
        raise typer.Exit(2) from exc
    typer.echo(f"valid: {parsed.name} ({len(parsed.roots)} roots)")


@config_app.command("show")
def config_show(
    policy: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_POLICY,
    home: Annotated[Path | None, typer.Option(file_okay=False)] = None,
) -> None:
    parsed = load_policy(policy, home=home)
    typer.echo(
        json.dumps(
            {
                "name": parsed.name,
                "roots": [
                    {"name": root.name, "path": str(root.path), "optional": root.optional}
                    for root in parsed.roots
                ],
            },
            indent=2,
        )
    )


@sync_app.command("inventory")
def sync_inventory(
    policy: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_POLICY,
    home: Annotated[Path | None, typer.Option(file_okay=False)] = None,
) -> None:
    parsed = load_policy(policy, home=home)
    manifest = build_manifest(parsed)
    typer.echo(
        json.dumps(
            {
                "digest": manifest.digest,
                "files": len(manifest.entries),
                "bytes": sum(entry.size for entry in manifest.entries),
                "secret_findings": sum(bool(entry.secret_findings) for entry in manifest.entries),
            },
            sort_keys=True,
        )
    )


@app.command()
def doctor() -> None:
    """Report local runtime support without reading synchronized content."""

    supported = sys.version_info >= (3, 11)
    typer.echo(
        json.dumps(
            {
                "relaydot": __version__,
                "python": platform.python_version(),
                "platform": platform.system().lower(),
                "supported_python": supported,
            },
            sort_keys=True,
        )
    )
    if not supported:
        raise typer.Exit(1)


if __name__ == "__main__":  # pragma: no cover
    app()
