"""Live HTTP tests against a running planner (optional, local or cluster port-forward).

Environment:
  SYNESIS_TEST_AUTH          Required to run this module (Bearer value, no ``Bearer `` prefix)
  SYNESIS_PLANNER_BASE_URL   default http://127.0.0.1:8000
  SYNESIS_LIVE_CHAT=1        optional: POST /v1/chat/completions (full pipeline — costs tokens)

Run (example):
  export SYNESIS_TEST_AUTH='syn-...'   # or internal service token for planner
  export SYNESIS_PLANNER_BASE_URL='https://synesis-planner...'
  uv run pytest base/planner/tests/test_integration_live.py -m integration -v

CI: omit SYNESIS_TEST_AUTH — entire module skips.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import pytest

_BASE = os.environ.get("SYNESIS_PLANNER_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
_TOKEN = (os.environ.get("SYNESIS_TEST_AUTH") or "").strip()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not _TOKEN, reason="Set SYNESIS_TEST_AUTH for live planner tests"),
]


def _get(path: str, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(f"{_BASE}{path}", headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post_json(path: str, body: dict, headers: dict[str, str]) -> tuple[int, bytes]:
    data = json.dumps(body).encode("utf-8")
    h = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(f"{_BASE}{path}", data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_live_health_no_auth_required():
    code, raw = _get("/health")
    assert code == 200
    assert json.loads(raw.decode())["status"] == "ok"


def test_live_models_no_auth_required():
    code, raw = _get("/v1/models")
    assert code == 200
    data = json.loads(raw.decode())
    assert data["object"] == "list"
    assert any(m.get("id") == "Synesis" for m in data.get("data", []))
    syn = next(m for m in data["data"] if m.get("id") == "Synesis")
    assert syn.get("object") == "model"
    assert isinstance(syn.get("created"), int)


def test_live_models_with_bearer_succeeds():
    code, raw = _get("/v1/models", headers={"Authorization": f"Bearer {_TOKEN}"})
    assert code == 200


def test_live_chat_minimal_when_enabled():
    if os.environ.get("SYNESIS_LIVE_CHAT", "").strip() != "1":
        pytest.skip("Set SYNESIS_LIVE_CHAT=1 to run one chat completion (uses quota)")

    code, raw = _post_json(
        "/v1/chat/completions",
        {
            "model": "Synesis",
            "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
            "max_tokens": 8,
            "stream": False,
        },
        headers={"Authorization": f"Bearer {_TOKEN}"},
    )
    assert code == 200, raw.decode()[:500]
    payload = json.loads(raw.decode())
    assert payload.get("choices")
    usage = payload.get("usage") or {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        assert key in usage, f"missing usage.{key}"
