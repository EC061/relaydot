"""Policy loading, validation, and include/exclude evaluation."""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .errors import PolicyError
from .paths import normalize_relative_path


@dataclass(frozen=True, slots=True)
class RootPolicy:
    name: str
    path: Path
    include: tuple[str, ...]
    exclude: tuple[str, ...] = ()
    optional: bool = False
    classification: str = "unspecified"
    sync_mode: str = "full-mirror"

    def includes(self, relative: str) -> bool:
        normalized = normalize_relative_path(relative)
        subject = f"/{normalized}"
        included = any(_glob_match(subject, pattern) for pattern in self.include)
        excluded = any(_glob_match(subject, pattern) for pattern in self.exclude)
        return included and not excluded


@dataclass(frozen=True, slots=True)
class SyncPolicy:
    name: str
    roots: tuple[RootPolicy, ...]
    deletion_policy: str
    conflict_strategy: str
    secret_scan: str
    encryption_required: str

    def root(self, name: str) -> RootPolicy:
        for item in self.roots:
            if item.name == name:
                return item
        raise KeyError(name)


def _glob_match(subject: str, pattern: str) -> bool:
    if not isinstance(pattern, str) or not pattern.startswith("/"):
        raise PolicyError(f"glob must start with '/': {pattern!r}")
    # fnmatch's '*' crosses '/', which is exactly the recursive policy behavior
    # expected by the documented '/**' presets.
    return fnmatch.fnmatchcase(subject, pattern)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PolicyError(f"{label} must be a mapping")
    return value


def load_policy(path: Path, *, home: Path | None = None) -> SyncPolicy:
    """Load the supported v1alpha1 subset and fail closed on unsafe omissions."""

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise PolicyError(f"cannot read policy: {exc}") from exc
    doc = _mapping(raw, "policy")
    if doc.get("apiVersion") != "relaydot.dev/v1alpha1":
        raise PolicyError("unsupported apiVersion")
    if doc.get("kind") != "SyncPolicy":
        raise PolicyError("kind must be SyncPolicy")
    metadata = _mapping(doc.get("metadata"), "metadata")
    spec = _mapping(doc.get("spec"), "spec")
    behavior = _mapping(spec.get("behavior"), "spec.behavior")
    roots_raw = spec.get("roots")
    if not isinstance(roots_raw, list) or not roots_raw:
        raise PolicyError("spec.roots must be a non-empty list")

    base_home = (home or Path.home()).resolve()
    roots: list[RootPolicy] = []
    names: set[str] = set()
    for index, value in enumerate(roots_raw):
        item = _mapping(value, f"spec.roots[{index}]")
        name = item.get("name")
        raw_path = item.get("path")
        include = item.get("include")
        if not isinstance(name, str) or not name or name in names:
            raise PolicyError("root names must be non-empty and unique")
        if not isinstance(raw_path, str) or not raw_path:
            raise PolicyError(f"root {name!r} requires a path")
        if (
            not isinstance(include, list)
            or not include
            or not all(isinstance(x, str) for x in include)
        ):
            raise PolicyError(f"root {name!r} requires include globs")
        exclude = item.get("exclude", [])
        if not isinstance(exclude, list) or not all(isinstance(x, str) for x in exclude):
            raise PolicyError(f"root {name!r} exclude must be a string list")
        for pattern in [*include, *exclude]:
            if not pattern.startswith("/") or ".." in pattern.split("/"):
                raise PolicyError(f"unsafe glob in root {name!r}: {pattern!r}")
        expanded = (
            Path(raw_path.replace("~", str(base_home), 1))
            if raw_path.startswith("~")
            else Path(raw_path)
        )
        if not expanded.is_absolute():
            raise PolicyError(f"root {name!r} must be absolute or home-relative")
        names.add(name)
        roots.append(
            RootPolicy(
                name=name,
                path=expanded,
                include=tuple(include),
                exclude=tuple(exclude),
                optional=bool(item.get("optional", False)),
                classification=str(item.get("classification", "unspecified")),
                sync_mode=str(item.get("syncMode", "full-mirror")),
            )
        )

    required = {
        "deletionPolicy": {"archive-and-restore", "managed-only"},
        "conflictStrategy": {"preserve_both_and_pause_path"},
        "secretScan": {"report", "block"},
        "encryptionRequired": {"end-to-end"},
    }
    for key, allowed in required.items():
        if behavior.get(key) not in allowed:
            raise PolicyError(f"unsupported or missing behavior.{key}")
    return SyncPolicy(
        name=str(metadata.get("name", "unnamed")),
        roots=tuple(roots),
        deletion_policy=str(behavior["deletionPolicy"]),
        conflict_strategy=str(behavior["conflictStrategy"]),
        secret_scan=str(behavior["secretScan"]),
        encryption_required=str(behavior["encryptionRequired"]),
    )
