from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "base" / "webui" / "overrides"))

from patch_middleware import patch_source


def test_middleware_patch_rejects_unpinned_source() -> None:
    with pytest.raises(RuntimeError, match="unsupported Open WebUI middleware"):
        patch_source("not the pinned upstream source")
