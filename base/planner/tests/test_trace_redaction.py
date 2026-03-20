"""trace_redaction: strip secrets from trace-shaped dicts."""

from __future__ import annotations

from app.trace_redaction import redact_string, redact_trace_payload


def test_redact_bearer():
    assert "secret" not in redact_string("Authorization: Bearer supersecretlongtokenhere")


def test_redact_trace_nested():
    payload = {
        "spans": [
            {
                "llm_calls": [
                    {
                        "prompt_full": "Authorization: Bearer abcdefghijklmnop",
                        "completion_full": "ok",
                    }
                ]
            }
        ]
    }
    out = redact_trace_payload(payload)
    assert "abcdefghijklmnop" not in str(out)
