"""Relaydot endpoint-agent core."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("relaydot")
except PackageNotFoundError:  # pragma: no cover - only when running an unpackaged source tree
    __version__ = "0.0.0"
