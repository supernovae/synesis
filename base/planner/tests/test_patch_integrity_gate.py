"""Tests for patch integrity gate checks.

Core check functions now live in integrity_core.py (shared with MCP tool).
"""

from __future__ import annotations

from app.integrity_core import (
    IntegrityResult,
    check_network,
    check_secrets,
    check_utf8,
)


class TestCheckSecrets:
    def test_no_secrets_passes(self):
        assert check_secrets("echo hello") is None
        assert check_secrets("x = 1") is None

    def test_api_key_detected(self):
        r = check_secrets('API_KEY = "sk-1234567890abcdef"')
        assert isinstance(r, IntegrityResult) and r.category == "secret"
        r2 = check_secrets("api_key=abc123xyz")
        assert isinstance(r2, IntegrityResult) and r2.category == "secret"

    def test_private_key_detected(self):
        code = "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
        r = check_secrets(code)
        assert isinstance(r, IntegrityResult) and r.category == "secret"


class TestCheckNetwork:
    def test_bash_curl_detected(self):
        r = check_network("curl https://example.com", "bash")
        assert isinstance(r, IntegrityResult) and r.category == "network"
        r2 = check_network("wget http://x.com", "sh")
        assert isinstance(r2, IntegrityResult) and r2.category == "network"

    def test_bash_comment_allowed(self):
        # Line that is a comment - we skip it
        assert check_network("# use curl to fetch", "bash") is None

    def test_python_requests_detected(self):
        r = check_network("requests.get('http://x.com')", "python")
        assert isinstance(r, IntegrityResult) and r.category == "network"

    def test_js_fetch_detected(self):
        r = check_network("fetch('/api')", "javascript")
        assert isinstance(r, IntegrityResult) and r.category == "network"

    def test_safe_code_passes(self):
        assert check_network("echo hello", "bash") is None
        assert check_network("print(1+1)", "python") is None


class TestCheckUtf8:
    def test_valid_utf8_passes(self):
        assert check_utf8("echo hello") is None
        assert check_utf8("print('café')") is None

    def test_invalid_encoding_fails(self):
        invalid_utf8 = "x\udc80y"
        r = check_utf8(invalid_utf8)
        assert isinstance(r, IntegrityResult) and r.category == "binary"
