from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import gatekeeper


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        return None

    def post(self, *_args: Any, **_kwargs: Any) -> _FakeResponse:
        return _FakeResponse(
            {
                "choices": [
                    {
                        "message": {
                            # fenced JSON should still parse
                            "content": """```json
{
  "content_type": "reference",
  "quality_score": 1.2,
  "technical_depth": -1,
  "domain_relevance": 0.88,
  "index_decision": "INDEX",
  "summary_one_line": "Reference page for auth APIs.",
  "keywords": ["auth", "token", "api"],
  "entities": [{"name": "OAuth2", "type": "concept"}],
  "section_outline": ["Overview", "API", "Errors"]
}
```"""
                        }
                    }
                ]
            }
        )


def test_run_document_gatekeeper_parses_and_clamps(monkeypatch):
    monkeypatch.setattr(gatekeeper.httpx, "Client", _FakeClient)

    out = gatekeeper.run_document_gatekeeper(
        document_name="Auth Reference",
        authority="vetted",
        domain="security",
        chunk_texts=["token endpoint", "authorization code flow"],
        base_url="http://mock-llm:8080/v1",
        model="synesis-general",
    )

    assert out is not None
    assert out.content_type == "reference"
    # Clamped from 1.2
    assert out.quality_score == 1.0
    # Negative maps to sentinel -1.0
    assert out.technical_depth == -1.0
    assert out.domain_relevance == 0.88
    # normalized to allowed enum value
    assert out.index_decision == "index"
    assert out.doc_keywords[:2] == ["auth", "token"]
    assert out.entities and out.entities[0]["name"] == "OAuth2"
    assert out.section_outline == ["Overview", "API", "Errors"]

