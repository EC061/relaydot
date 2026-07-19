from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def policy_text() -> str:
    return """\
apiVersion: relaydot.dev/v1alpha1
kind: SyncPolicy
metadata:
  name: test
spec:
  behavior:
    deletionPolicy: archive-and-restore
    conflictStrategy: preserve_both_and_pause_path
    secretScan: report
    encryptionRequired: end-to-end
  roots:
    - name: config
      path: ~/.config-tool
      include: [\"/**\"]
      exclude: [\"/excluded/**\"]
    - name: optional
      path: ~/.optional-tool
      optional: true
      include: [\"/**\"]
"""


@pytest.fixture
def policy_file(tmp_path: Path, policy_text: str) -> Path:
    path = tmp_path / "policy.yaml"
    path.write_text(policy_text)
    return path
