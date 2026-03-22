from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import enrichment


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


def test_enrich_chunk_full_mode_uses_structured_pass_b(monkeypatch):
    def _fake_post(*_args: Any, **_kwargs: Any) -> _FakeResponse:
        return _FakeResponse(
            {
                "choices": [
                    {
                        "message": {
                            "content": """```json
{
  "summary_one_line": "Explains OAuth2 token exchange endpoint behavior.",
  "context_prefix": "From auth docs, this section details token exchange semantics.",
  "keywords": ["oauth2", "token endpoint", "authorization code"],
  "confidence": 0.92
}
```"""
                        }
                    }
                ]
            }
        )

    monkeypatch.setattr(enrichment.httpx, "post", _fake_post)

    out = enrichment.enrich_chunk(
        text="POST /token with grant_type=authorization_code ...",
        document_name="Auth API",
        heading_path="OAuth2 > Token",
        full_mode=True,
        llm_url="http://mock-llm:8080/v1",
    )

    assert out.chunk_summary.startswith("Explains OAuth2 token exchange")
    assert out.context_prefix.startswith("From auth docs")
    assert "oauth2" in out.keywords
    assert out.semantic_profile is not None
    assert out.semantic_profile.get("contract_version") == "pass_b_v1"
