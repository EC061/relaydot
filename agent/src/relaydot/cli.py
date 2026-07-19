"""Relaydot command-line surface for local validation and diagnostics."""

from __future__ import annotations

import json
import platform
import socket
import sys
from pathlib import Path
from typing import Annotated

import typer

from . import __version__
from .controller import AgentService, ControllerClient, StateStore
from .errors import RelaydotError
from .manifest import build_manifest
from .policy import load_policy
from .service import ServiceInstaller

app = typer.Typer(help="Relaydot endpoint synchronization agent", no_args_is_help=True)
config_app = typer.Typer(help="Validate and inspect local policy")
sync_app = typer.Typer(help="Inspect or synchronize local state")
service_app = typer.Typer(help="Run the managed-node agent service")
app.add_typer(config_app, name="config")
app.add_typer(sync_app, name="sync")
app.add_typer(service_app, name="service")


def _default_policy() -> Path:
    return Path(__file__).with_name("data") / "recommended.yaml"


DEFAULT_POLICY = _default_policy()
DEFAULT_STATE = Path("~/.relaydot/agent.json").expanduser()


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
def enroll(
    server: Annotated[str, typer.Option(help="Relaydot controller base URL")],
    token: Annotated[str, typer.Option(help="Single-use enrollment token")],
    name: Annotated[str, typer.Option(help="Device display name")] = socket.gethostname(),
    state: Annotated[Path, typer.Option(help="Agent credential file")] = DEFAULT_STATE,
) -> None:
    """Enroll this node and store its device credential with owner-only permissions."""

    client = ControllerClient(server)
    try:
        credentials = client.enroll(token, name)
        StateStore(state).save(credentials)
    finally:
        client.close()
    typer.echo(f"enrolled: {credentials.device_id}")


def _run_service_once(state: Path, policy: Path, home: Path | None) -> list[dict[str, object]]:
    credentials = StateStore(state).load()
    client = ControllerClient(credentials.server)
    try:
        service = AgentService(credentials, client, policy, home)
        return service.run_once()
    finally:
        client.close()


@sync_app.command("now")
def sync_now(
    state: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_STATE,
    policy: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_POLICY,
    home: Annotated[Path | None, typer.Option(file_okay=False)] = None,
) -> None:
    """Heartbeat, claim durable controller commands, execute, and acknowledge them."""

    typer.echo(json.dumps(_run_service_once(state, policy, home), sort_keys=True))


@service_app.command("run")
def service_run(
    state: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_STATE,
    policy: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_POLICY,
    home: Annotated[Path | None, typer.Option(file_okay=False)] = None,
    interval: Annotated[float, typer.Option(min=1, help="Polling interval in seconds")] = 10,
    once: Annotated[bool, typer.Option(help="Process one polling cycle and exit")] = False,
) -> None:
    """Run the foreground managed-node service."""

    credentials = StateStore(state).load()
    client = ControllerClient(credentials.server)
    service = AgentService(credentials, client, policy, home)
    try:
        if once:
            outcomes = service.run_once()
            typer.echo(json.dumps(outcomes, sort_keys=True))
        else:
            service.run_forever(interval)
    finally:
        client.close()


@service_app.command("install")
def service_install(
    state: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_STATE,
    policy: Annotated[Path, typer.Option(exists=True, dir_okay=False)] = DEFAULT_POLICY,
    interval: Annotated[float, typer.Option(min=1, help="Polling interval in seconds")] = 10,
    start: Annotated[bool, typer.Option(help="Enable and start immediately")] = False,
) -> None:
    """Install a per-user launchd, systemd, or Windows Scheduled Task service."""

    path = ServiceInstaller().install(state, policy, interval, start=start)
    typer.echo(f"installed: {path or 'Relaydot Agent scheduled task'}")


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
