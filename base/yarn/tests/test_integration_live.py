"""Live HTTP tests against a running Yarn (Synesis Coder) service.

Environment:
  SYNESIS_TEST_AUTH       Required: syn-… PAT with coder scope (admin DB)
  SYNESIS_YARN_BASE_URL   default http://127.0.0.1:8000
  SYNESIS_LIVE_CHAT=1     optional: POST /v1/chat/completions (real LLM)

Run:
  export SYNESIS_TEST_AUTH='syn-...'
  export SYNESIS_YARN_BASE_URL='http://127.0.0.1:8000'
  cd base/yarn && uv run pytest tests/test_integration_live.py -m integration -v
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

import pytest

_BASE = os.environ.get("SYNESIS_YARN_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
_TOKEN = (os.environ.get("SYNESIS_TEST_AUTH") or "").strip()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not _TOKEN, reason="Set SYNESIS_TEST_AUTH for live Yarn tests"),
]


def _safe_urlopen(
    req: urllib.request.Request, *, timeout: int
) -> tuple[int, bytes]:
    """urlopen wrapper that rejects non-HTTP(S) schemes (B310 mitigation)."""
    scheme = urllib.parse.urlparse(req.full_url).scheme
    if scheme not in ("http", "https"):
        raise ValueError(f"Refusing non-HTTP scheme: {scheme}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _get(path: str, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(f"{_BASE}{path}", headers=headers or {}, method="GET")
    return _safe_urlopen(req, timeout=30)


def _post_json(path: str, body: dict, headers: dict[str, str]) -> tuple[int, bytes]:
    data = json.dumps(body).encode("utf-8")
    h = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(f"{_BASE}{path}", data=data, headers=h, method="POST")
    return _safe_urlopen(req, timeout=120)


def test_yarn_live_health():
    code, raw = _get("/health")
    assert code == 200
    assert json.loads(raw.decode())["status"] == "ok"


def test_yarn_live_models_public():
    code, raw = _get("/v1/models")
    assert code == 200
    data = json.loads(raw.decode())
    assert any(m.get("id") == "synesis-yarn" for m in data.get("data", []))


def test_yarn_live_mcp_tools_lists_with_pat():
    code, raw = _get("/v1/mcp/tools", headers={"Authorization": f"Bearer {_TOKEN}"})
    assert code == 200, raw.decode()[:500]
    data = json.loads(raw.decode())
    assert "tools" in data


def test_yarn_live_chat_minimal_when_enabled():
    if os.environ.get("SYNESIS_LIVE_CHAT", "").strip() != "1":
        pytest.skip("Set SYNESIS_LIVE_CHAT=1 to run one chat completion (uses provider quota)")

    code, raw = _post_json(
        "/v1/chat/completions",
        {
            "model": "synesis-yarn",
            "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
            "max_tokens": 8,
            "stream": False,
        },
        headers={
            "Authorization": f"Bearer {_TOKEN}",
            "user-agent": "SynesisIntegrationTest/1.0",
        },
    )
    assert code == 200, raw.decode()[:800]
    payload = json.loads(raw.decode())
    assert payload.get("choices")
