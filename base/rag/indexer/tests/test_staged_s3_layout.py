from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.staged_s3 import StagedS3Store


def test_put_enriched_json_uses_versioned_layout(monkeypatch):
    store = object.__new__(StagedS3Store)
    store.prefix = "ingest/"

    captured = {"key": "", "content_type": "", "body": b""}

    def _fake_put_bytes(key: str, body: bytes, content_type: str) -> str:
        captured["key"] = key
        captured["content_type"] = content_type
        captured["body"] = body
        return key

    monkeypatch.setattr(store, "put_bytes", _fake_put_bytes)

    key = store.put_enriched_json(
        "v2",
        "abc123",
        {"doc_key": "abc123", "chunk_count": 7},
    )

    assert key == "ingest/enriched/v2/abc123/result.json"
    assert captured["content_type"] == "application/json"
    assert b'"chunk_count": 7' in captured["body"]
