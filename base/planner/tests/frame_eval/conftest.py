"""Fixtures for the frame extractor evaluation suite.

Modes:
  --frame-live       Run against the live LLM (slow, requires model endpoint)
  --frame-update     Run live AND overwrite snapshots with new results
  --frame-difficulty  Set difficulty for live runs (default 0.7)

Without flags, tests run against saved snapshots in snapshots/.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
_DATASET = _HERE / "dataset.json"
_SNAPSHOTS = _HERE / "snapshots"


def pytest_addoption(parser: Any) -> None:
    parser.addoption("--frame-live", action="store_true", default=False, help="Run frame extractor against live LLM")
    parser.addoption("--frame-update", action="store_true", default=False, help="Run live and update snapshots")
    parser.addoption(
        "--frame-difficulty",
        type=float,
        default=0.7,
        help="Difficulty score for live runs (< 0.5 = single-pass, >= 0.5 = two-phase)",
    )


def _load_dataset() -> list[dict[str, Any]]:
    return json.loads(_DATASET.read_text())


def _load_snapshot(case_id: str) -> dict[str, Any] | None:
    path = _SNAPSHOTS / f"{case_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    return None


def _save_snapshot(case_id: str, frame: dict[str, Any]) -> None:
    _SNAPSHOTS.mkdir(exist_ok=True)
    path = _SNAPSHOTS / f"{case_id}.json"
    path.write_text(json.dumps(frame, indent=2, ensure_ascii=False))


async def _run_live_extractor(prompt: str, difficulty: float = 0.7) -> dict[str, Any]:
    """Run the actual frame extractor against the LLM.

    Imports are deferred because they pull in pydantic_settings / langchain
    which aren't available in every local dev environment.
    Direct module import avoids the heavy __init__ chain (pymilvus, etc.).
    """
    import importlib

    mod = importlib.import_module("app.nodes.frame_extractor")
    frame_extractor_node = mod.frame_extractor_node

    state = {
        "task_description": prompt,
        "difficulty": difficulty,
        "taxonomy_metadata": {},
        "explicit_deliverables": 0,
    }
    result = await frame_extractor_node(state)
    return result.get("task_frame", {})


@pytest.fixture
def frame_mode(request: Any) -> str:
    if request.config.getoption("--frame-update"):
        return "update"
    if request.config.getoption("--frame-live"):
        return "live"
    return "snapshot"


@pytest.fixture
def frame_difficulty(request: Any) -> float:
    return request.config.getoption("--frame-difficulty")


def get_frame(
    case: dict[str, Any],
    mode: str,
    difficulty: float = 0.7,
) -> dict[str, Any] | None:
    """Get the frame for a test case based on the current mode.

    Returns None if snapshot mode and no snapshot exists (test should skip).
    """
    case_id = case["id"]

    if mode == "snapshot":
        return _load_snapshot(case_id)

    import asyncio

    frame = asyncio.run(_run_live_extractor(case["prompt"], difficulty=difficulty))

    if mode == "update":
        _save_snapshot(case_id, frame)

    return frame


def load_cases() -> list[dict[str, Any]]:
    """Load test cases for parametrize. Called at collection time."""
    return _load_dataset()
