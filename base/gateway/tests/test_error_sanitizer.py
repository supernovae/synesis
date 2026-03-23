"""Tests for the LiteLLM error-sanitisation callback.

Run with:
    uv run pytest base/gateway/tests/test_error_sanitizer.py -v
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Make the callback module importable without litellm installed: we stub out
# the heavy imports so the pure-Python classification logic can be tested in
# isolation (CI doesn't need a litellm install for this).
# ---------------------------------------------------------------------------

_fastapi = types.ModuleType("fastapi")


class _FakeHTTPException(Exception):
    def __init__(self, *, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail


_fastapi.HTTPException = _FakeHTTPException  # type: ignore[attr-defined]
sys.modules.setdefault("fastapi", _fastapi)

_litellm = types.ModuleType("litellm")
_litellm_int = types.ModuleType("litellm.integrations")
_litellm_cl = types.ModuleType("litellm.integrations.custom_logger")


class _FakeCustomLogger:
    pass


_litellm_cl.CustomLogger = _FakeCustomLogger  # type: ignore[attr-defined]
sys.modules.setdefault("litellm", _litellm)
sys.modules.setdefault("litellm.integrations", _litellm_int)
sys.modules.setdefault("litellm.integrations.custom_logger", _litellm_cl)

_litellm_proxy = types.ModuleType("litellm.proxy")
_litellm_ps = types.ModuleType("litellm.proxy.proxy_server")
_litellm_ps.UserAPIKeyAuth = object  # type: ignore[attr-defined]
sys.modules.setdefault("litellm.proxy", _litellm_proxy)
sys.modules.setdefault("litellm.proxy.proxy_server", _litellm_ps)

# Now we can import the callback module from its canonical location.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from synesis_callbacks import SynesisErrorSanitizer, _classify  # noqa: I001


# ---------------------------------------------------------------------------
# _classify unit tests
# ---------------------------------------------------------------------------

class _FakeExc(Exception):
    """Exception whose __name__ we can control."""

    def __init__(self, name: str, msg: str):
        self._name = name
        super().__init__(msg)

    @property
    def __class__(self):
        # Hack: create a transient type so type(exc).__name__ returns _name.
        return type(self._name, (Exception,), {})


def _exc(name: str, msg: str = "") -> Exception:
    """Helper to build an exception with a given class name."""
    cls = type(name, (Exception,), {})
    return cls(msg)


@pytest.mark.parametrize(
    "exc, expected_status",
    [
        (_exc("AuthenticationError", "bad key"), 502),
        (_exc("SomeError", "got 401 unauthorized"), 502),
        (_exc("SomeError", "oauth token refresh failed"), 502),
        (_exc("RateLimitError", "too many requests"), 429),
        (_exc("SomeError", "429 rate limit exceeded"), 429),
        (_exc("ContextWindowExceededError", "too long"), 400),
        (_exc("SomeError", "context window exceeded"), 400),
        (_exc("Timeout", "read timed out"), 504),
        (_exc("APIConnectionError", "connection refused"), 504),
        (_exc("SomeError", "connection reset by peer"), 504),
        (_exc("ContentPolicyViolationError", ""), 400),
        (_exc("SomeError", "content policy violation"), 400),
        (_exc("ServiceUnavailableError", "service down"), 503),
        (_exc("SomeError", "503 backend unavailable"), 503),
        (_exc("SomeError", "completely unknown failure"), 502),
    ],
)
def test_classify_status_codes(exc: Exception, expected_status: int) -> None:
    status, message = _classify(exc)
    assert status == expected_status, f"Expected {expected_status}, got {status} for {exc}"
    assert message  # non-empty


def test_classify_never_leaks_original_message() -> None:
    secret = "xai-secret-key-abc123"
    exc = _exc("AuthenticationError", f"Invalid API key: {secret}")
    _, message = _classify(exc)
    assert secret not in message


# ---------------------------------------------------------------------------
# Hook integration test
# ---------------------------------------------------------------------------

def test_hook_returns_sanitized_exception() -> None:
    sanitizer = SynesisErrorSanitizer()
    exc = _exc("AuthenticationError", "token refresh failed for x.ai")

    result = asyncio.run(
        sanitizer.async_post_call_failure_hook(
            request_data={"model": "xai/grok-beta"},
            original_exception=exc,
            user_api_key_dict=MagicMock(),
        )
    )

    assert result is not None
    assert result.status_code == 502
    assert "authentication" in result.detail.lower()
    assert "x.ai" not in result.detail
    assert "(ref: " in result.detail


def test_hook_includes_incident_id() -> None:
    sanitizer = SynesisErrorSanitizer()
    exc = _exc("SomeError", "random failure")

    r1 = asyncio.run(
        sanitizer.async_post_call_failure_hook(
            request_data={"model": "test"},
            original_exception=exc,
            user_api_key_dict=MagicMock(),
        )
    )
    r2 = asyncio.run(
        sanitizer.async_post_call_failure_hook(
            request_data={"model": "test"},
            original_exception=exc,
            user_api_key_dict=MagicMock(),
        )
    )

    ref1 = r1.detail.split("ref: ")[1].rstrip(")")
    ref2 = r2.detail.split("ref: ")[1].rstrip(")")
    assert ref1 != ref2, "Each call should generate a unique incident ID"
