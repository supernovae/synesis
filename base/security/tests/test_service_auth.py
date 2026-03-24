"""Tests for synesis_service_auth — shared service-to-service auth module."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import synesis_service_auth as auth

_SECRET = "test-secret-for-hmac-signing"
_BODY = b'{"language": "python", "code": "print(1)"}'


# ---------------------------------------------------------------------------
# Tier 1 — verify_bearer
# ---------------------------------------------------------------------------


class TestVerifyBearer:
    def test_valid_token(self):
        assert auth.verify_bearer("token-a", ["token-a", "token-b"]) is True

    def test_second_token(self):
        assert auth.verify_bearer("token-b", ["token-a", "token-b"]) is True

    def test_invalid_token(self):
        assert auth.verify_bearer("wrong", ["token-a", "token-b"]) is False

    def test_empty_token(self):
        assert auth.verify_bearer("", ["token-a"]) is False

    def test_empty_secrets_list(self):
        assert auth.verify_bearer("token-a", []) is False


# ---------------------------------------------------------------------------
# Tier 1 — configured_service_tokens
# ---------------------------------------------------------------------------


class TestConfiguredServiceTokens:
    def test_single_token(self):
        with patch.dict("os.environ", {"TOK": "abc", "TOKS": ""}):
            tokens = auth.configured_service_tokens("TOK", "TOKS")
        assert tokens == ["abc"]

    def test_comma_separated(self):
        with patch.dict("os.environ", {"TOK": "", "TOKS": "a,b,c"}):
            tokens = auth.configured_service_tokens("TOK", "TOKS")
        assert tokens == ["a", "b", "c"]

    def test_deduplication(self):
        with patch.dict("os.environ", {"TOK": "a", "TOKS": "a,b,a"}):
            tokens = auth.configured_service_tokens("TOK", "TOKS")
        assert tokens == ["a", "b"]

    def test_empty(self):
        with patch.dict("os.environ", {"TOK": "", "TOKS": ""}, clear=False):
            tokens = auth.configured_service_tokens("TOK", "TOKS")
        assert tokens == []

    def test_whitespace_stripping(self):
        with patch.dict("os.environ", {"TOK": "  x  ", "TOKS": " y , z "}):
            tokens = auth.configured_service_tokens("TOK", "TOKS")
        assert tokens == ["x", "y", "z"]


# ---------------------------------------------------------------------------
# Tier 2 — sign_request + verify_request round-trip
# ---------------------------------------------------------------------------


class TestSignAndVerify:
    def test_round_trip(self):
        headers = auth.sign_request(_BODY, _SECRET)
        valid, reason = auth.verify_request(headers["Authorization"], _BODY, _SECRET)
        assert valid is True
        assert reason == "ok"

    def test_different_body_rejected(self):
        headers = auth.sign_request(_BODY, _SECRET)
        valid, reason = auth.verify_request(headers["Authorization"], b"tampered", _SECRET)
        assert valid is False
        assert reason == "signature_mismatch"

    def test_wrong_secret_rejected(self):
        headers = auth.sign_request(_BODY, _SECRET)
        valid, reason = auth.verify_request(headers["Authorization"], _BODY, "wrong-secret")
        assert valid is False
        assert reason == "signature_mismatch"

    def test_empty_body_round_trip(self):
        headers = auth.sign_request(b"", _SECRET)
        valid, reason = auth.verify_request(headers["Authorization"], b"", _SECRET)
        assert valid is True

    def test_header_format(self):
        headers = auth.sign_request(_BODY, _SECRET)
        assert headers["Authorization"].startswith("Bearer HMAC-SHA256:")
        parts = headers["Authorization"][7:].split(":")
        assert len(parts) == 4
        assert parts[0] == "HMAC-SHA256"


# ---------------------------------------------------------------------------
# Tier 2 — verify_request edge cases
# ---------------------------------------------------------------------------


class TestVerifyRequest:
    def test_missing_header(self):
        valid, reason = auth.verify_request("", _BODY, _SECRET)
        assert valid is False
        assert reason == "missing_authorization_header"

    def test_invalid_scheme(self):
        valid, reason = auth.verify_request("Bearer BAD-SCHEME:sig:123:nonce", _BODY, _SECRET)
        assert valid is False
        assert reason == "invalid_scheme_or_format"

    def test_too_few_parts(self):
        valid, reason = auth.verify_request("Bearer HMAC-SHA256:sig:123", _BODY, _SECRET)
        assert valid is False
        assert reason == "invalid_scheme_or_format"

    def test_invalid_timestamp(self):
        valid, reason = auth.verify_request("Bearer HMAC-SHA256:sig:notanumber:nonce", _BODY, _SECRET)
        assert valid is False
        assert reason == "invalid_timestamp"

    def test_expired_timestamp(self):
        old_ts = str(int(time.time()) - 600)
        header = f"Bearer HMAC-SHA256:fakesig:{old_ts}:nonce"
        valid, reason = auth.verify_request(header, _BODY, _SECRET)
        assert valid is False
        assert "expired_timestamp" in reason

    def test_empty_secret_allows_all(self):
        valid, reason = auth.verify_request("", _BODY, "")
        assert valid is True
        assert reason == "auth_disabled"

    def test_empty_secret_with_header_allows(self):
        headers = auth.sign_request(_BODY, _SECRET)
        valid, reason = auth.verify_request(headers["Authorization"], _BODY, "")
        assert valid is True
        assert reason == "auth_disabled"

    def test_custom_max_age(self):
        headers = auth.sign_request(_BODY, _SECRET)
        valid, reason = auth.verify_request(
            headers["Authorization"], _BODY, _SECRET, max_age=0
        )
        assert valid is True or "expired" in reason
