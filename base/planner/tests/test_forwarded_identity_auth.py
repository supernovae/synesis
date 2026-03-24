"""Tests for forwarded-identity trust enforcement (C2 hardening).

Validates that:
- Only dedicated internal_service_token(s) grant forwarded-identity trust.
- The model_api_key is rejected for identity trust by default.
- strict_forwarded_identity_mode rejects untrusted forwarded headers with 403.
- PAT bearers (syn-…) bypass forwarded identity entirely (no 403).
- Startup audit emits warnings for insecure configurations.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

try:
    import fastapi  # noqa: F401
    _has_fastapi = True
except ImportError:
    _has_fastapi = False

skip_no_fastapi = pytest.mark.skipif(not _has_fastapi, reason="fastapi not installed")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_INTERNAL_TOKEN = "synesis-internal-test-token-abc123"
_MODEL_API_KEY = "sk-test-model-api-key"
_RANDOM_BEARER = "some-unknown-bearer-token"


class _HeaderDict(dict):
    """Dict subclass that allows Starlette-style ``.get(key)`` with case-insensitive keys."""

    def get(self, key: str, default: str = "") -> str:  # type: ignore[override]
        return super().get(key.lower(), default)


def _mock_request(headers: dict[str, str] | None = None, remote: str = "127.0.0.1") -> MagicMock:
    req = MagicMock()
    hdr = _HeaderDict({k.lower(): v for k, v in (headers or {}).items()})
    req.headers = hdr
    client = MagicMock()
    client.host = remote
    req.client = client
    return req


_FORWARDED_HEADERS = {
    "authorization": f"Bearer {_INTERNAL_TOKEN}",
    "x-openwebui-user-id": "user-42",
    "x-openwebui-user-email": "alice@example.com",
    "x-synesis-org-id": "org-7",
    "x-synesis-org-name": "Acme Corp",
}


# ---------------------------------------------------------------------------
# _is_trusted_service_bearer
# ---------------------------------------------------------------------------


@skip_no_fastapi
class TestIsTrustedServiceBearer:
    """Unit tests for _is_trusted_service_bearer."""

    def test_internal_token_trusted(self):
        from app.main import _is_trusted_service_bearer

        with patch("app.main.settings") as s:
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.log_untrusted_identity_attempts = False
            assert _is_trusted_service_bearer(_INTERNAL_TOKEN) is True

    def test_comma_separated_tokens(self):
        from app.main import _is_trusted_service_bearer

        with patch("app.main.settings") as s:
            s.internal_service_token = ""
            s.internal_service_tokens = f"other-token,{_INTERNAL_TOKEN}"
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = ""
            s.log_untrusted_identity_attempts = False
            assert _is_trusted_service_bearer(_INTERNAL_TOKEN) is True

    def test_model_api_key_rejected_by_default(self):
        from app.main import _is_trusted_service_bearer

        with patch("app.main.settings") as s:
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.log_untrusted_identity_attempts = False
            assert _is_trusted_service_bearer(_MODEL_API_KEY) is False

    def test_model_api_key_accepted_when_opted_in(self):
        from app.main import _is_trusted_service_bearer

        with patch("app.main.settings") as s:
            s.internal_service_token = ""
            s.internal_service_tokens = ""
            s.trust_model_api_key_for_forwarded_identity = True
            s.model_api_key = _MODEL_API_KEY
            s.log_untrusted_identity_attempts = False
            assert _is_trusted_service_bearer(_MODEL_API_KEY) is True

    def test_empty_token_rejected(self):
        from app.main import _is_trusted_service_bearer

        assert _is_trusted_service_bearer("") is False

    def test_random_token_rejected(self):
        from app.main import _is_trusted_service_bearer

        with patch("app.main.settings") as s:
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.log_untrusted_identity_attempts = False
            assert _is_trusted_service_bearer(_RANDOM_BEARER) is False

    def test_model_key_rejection_logged(self):
        from app.main import _is_trusted_service_bearer

        with patch("app.main.settings") as s, patch("app.main.logger") as mock_logger:
            s.internal_service_token = ""
            s.internal_service_tokens = ""
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.log_untrusted_identity_attempts = True
            _is_trusted_service_bearer(_MODEL_API_KEY)
            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert "model_api_key_identity_trust_rejected" in str(call_args)


# ---------------------------------------------------------------------------
# _enforce_auth_and_header_trust
# ---------------------------------------------------------------------------


@skip_no_fastapi
class TestEnforceAuthAndHeaderTrust:
    """Unit tests for _enforce_auth_and_header_trust."""

    def test_missing_bearer_returns_401(self):
        from app.main import _enforce_auth_and_header_trust
        from fastapi import HTTPException

        req = _mock_request(headers={})
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            with pytest.raises(HTTPException) as exc_info:
                _enforce_auth_and_header_trust(req)
            assert exc_info.value.status_code == 401

    def test_internal_token_trusts_forwarded_headers(self):
        from app.main import _enforce_auth_and_header_trust

        req = _mock_request(headers=_FORWARDED_HEADERS)
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.log_untrusted_identity_attempts = False
            bearer, trust = _enforce_auth_and_header_trust(req)
            assert bearer == _INTERNAL_TOKEN
            assert trust is True

    def test_strict_mode_rejects_untrusted_forwarded_headers(self):
        from app.main import _enforce_auth_and_header_trust
        from fastapi import HTTPException

        headers = {
            "authorization": f"Bearer {_RANDOM_BEARER}",
            "x-openwebui-user-id": "spoofed-user",
        }
        req = _mock_request(headers=headers)
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.log_untrusted_identity_attempts = False
            with pytest.raises(HTTPException) as exc_info:
                _enforce_auth_and_header_trust(req)
            assert exc_info.value.status_code == 403

    def test_strict_mode_model_key_rejected_for_identity(self):
        """Model API key bearer + forwarded headers = 403 in strict mode (default)."""
        from app.main import _enforce_auth_and_header_trust
        from fastapi import HTTPException

        headers = {
            "authorization": f"Bearer {_MODEL_API_KEY}",
            "x-openwebui-user-id": "spoofed-user",
            "x-synesis-org-id": "spoofed-org",
        }
        req = _mock_request(headers=headers)
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.log_untrusted_identity_attempts = False
            with pytest.raises(HTTPException) as exc_info:
                _enforce_auth_and_header_trust(req)
            assert exc_info.value.status_code == 403

    def test_non_strict_mode_ignores_untrusted_headers(self):
        """Non-strict mode: untrusted forwarded headers are silently ignored, not rejected."""
        from app.main import _enforce_auth_and_header_trust

        headers = {
            "authorization": f"Bearer {_RANDOM_BEARER}",
            "x-openwebui-user-id": "spoofed-user",
        }
        req = _mock_request(headers=headers)
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = False
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.log_untrusted_identity_attempts = False
            bearer, trust = _enforce_auth_and_header_trust(req)
            assert bearer == _RANDOM_BEARER
            assert trust is False

    def test_pat_bearer_bypasses_forwarded_identity(self):
        """PAT (syn-…) bearers never trust forwarded headers and never 403."""
        from app.main import _enforce_auth_and_header_trust

        headers = {
            "authorization": "Bearer syn-test-pat-token",
            "x-openwebui-user-id": "should-be-ignored",
            "x-synesis-org-id": "should-be-ignored",
        }
        req = _mock_request(headers=headers)
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.log_untrusted_identity_attempts = False
            bearer, trust = _enforce_auth_and_header_trust(req)
            assert bearer == "syn-test-pat-token"
            assert trust is False

    def test_no_forwarded_headers_no_rejection(self):
        """Bearer that isn't trusted but no forwarded headers present = no 403."""
        from app.main import _enforce_auth_and_header_trust

        headers = {"authorization": f"Bearer {_RANDOM_BEARER}"}
        req = _mock_request(headers=headers)
        with patch("app.main.settings") as s:
            s.planner_require_bearer_auth = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.trust_model_api_key_for_forwarded_identity = False
            s.model_api_key = _MODEL_API_KEY
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            s.log_untrusted_identity_attempts = False
            bearer, trust = _enforce_auth_and_header_trust(req)
            assert bearer == _RANDOM_BEARER
            assert trust is False


# ---------------------------------------------------------------------------
# _audit_identity_trust_config (startup warnings)
# ---------------------------------------------------------------------------


@skip_no_fastapi
class TestAuditIdentityTrustConfig:
    """Startup security audit emits correct warnings."""

    def test_warns_on_model_key_trust_enabled(self):
        from app.main import _audit_identity_trust_config

        with patch("app.main.settings") as s, patch("app.main.logger") as mock_logger:
            s.trust_model_api_key_for_forwarded_identity = True
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            _audit_identity_trust_config()
            warnings = [c for c in mock_logger.warning.call_args_list if "model_api_key" in str(c)]
            assert len(warnings) >= 1

    def test_warns_on_non_strict_mode(self):
        from app.main import _audit_identity_trust_config

        with patch("app.main.settings") as s, patch("app.main.logger") as mock_logger:
            s.trust_model_api_key_for_forwarded_identity = False
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = False
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            _audit_identity_trust_config()
            warnings = [c for c in mock_logger.warning.call_args_list if "strict_forwarded_identity_mode" in str(c)]
            assert len(warnings) >= 1

    def test_warns_on_no_service_tokens(self):
        from app.main import _audit_identity_trust_config

        with patch("app.main.settings") as s, patch("app.main.logger") as mock_logger:
            s.trust_model_api_key_for_forwarded_identity = False
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.internal_service_token = ""
            s.internal_service_tokens = ""
            _audit_identity_trust_config()
            warnings = [c for c in mock_logger.warning.call_args_list if "internal_service_token" in str(c)]
            assert len(warnings) >= 1

    def test_healthy_config_logs_ok(self):
        from app.main import _audit_identity_trust_config

        with patch("app.main.settings") as s, patch("app.main.logger") as mock_logger:
            s.trust_model_api_key_for_forwarded_identity = False
            s.trust_forwarded_identity_headers = True
            s.strict_forwarded_identity_mode = True
            s.internal_service_token = _INTERNAL_TOKEN
            s.internal_service_tokens = ""
            _audit_identity_trust_config()
            mock_logger.warning.assert_not_called()
            info_calls = [c for c in mock_logger.info.call_args_list if "identity_trust_config_ok" in str(c)]
            assert len(info_calls) == 1
