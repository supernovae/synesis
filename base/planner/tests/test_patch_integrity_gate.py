"""Tests for patch integrity gate checks."""

from __future__ import annotations

# Import check functions directly to avoid pulling in langchain etc.
from app.nodes.patch_integrity_gate import (
    check_network,
    check_secrets,
    check_utf8,
)


class TestCheckSecrets:
    def test_no_secrets_passes(self):
        assert check_secrets("echo hello") is None
        assert check_secrets("x = 1") is None

    def test_api_key_detected(self):
        assert check_secrets('API_KEY = "sk-1234567890abcdef"') == "secret_detected"
        assert check_secrets("api_key=abc123xyz") == "secret_detected"

    def test_private_key_detected(self):
        code = "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
        assert check_secrets(code) == "secret_detected"


class TestCheckNetwork:
    def test_bash_curl_detected(self):
        assert check_network("curl https://example.com", "bash") == "network_call_detected"
        assert check_network("wget http://x.com", "sh") == "network_call_detected"

    def test_bash_comment_allowed(self):
        # Line that is a comment - we skip it
        assert check_network("# use curl to fetch", "bash") is None

    def test_python_requests_detected(self):
        assert check_network("requests.get('http://x.com')", "python") == "network_call_detected"

    def test_js_fetch_detected(self):
        assert check_network("fetch('/api')", "javascript") == "network_call_detected"

    def test_safe_code_passes(self):
        assert check_network("echo hello", "bash") is None
        assert check_network("print(1+1)", "python") is None


class TestCheckUtf8:
    def test_valid_utf8_passes(self):
        assert check_utf8("echo hello") is None
        assert check_utf8("print('café')") is None

    def test_invalid_encoding_fails(self):
        # Lone surrogate is invalid in UTF-8
        invalid_utf8 = "x\udc80y"
        assert check_utf8(invalid_utf8) == "binary_or_invalid_encoding"
