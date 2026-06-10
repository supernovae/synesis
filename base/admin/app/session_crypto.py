"""Encryption helpers for OIDC tokens stored in admin session rows."""

from __future__ import annotations

import base64
import os
from hashlib import sha256

from cryptography.fernet import Fernet, InvalidToken

_PREFIX = "fernet:v1:"


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _secret() -> str:
    return os.getenv("SYNESIS_ADMIN_SESSION_TOKEN_KEY", "").strip()


def _fernet_from_secret(secret: str) -> Fernet:
    raw = secret.encode()
    try:
        return Fernet(raw)
    except (ValueError, TypeError):
        derived = base64.urlsafe_b64encode(sha256(raw).digest())
        return Fernet(derived)


def assert_session_token_encryption_ready() -> None:
    if _truthy(os.getenv("SYNESIS_ADMIN_REQUIRE_SESSION_TOKEN_ENCRYPTION")) and not _secret():
        raise RuntimeError(
            "SYNESIS_ADMIN_SESSION_TOKEN_KEY is required when SYNESIS_ADMIN_REQUIRE_SESSION_TOKEN_ENCRYPTION=true"
        )


def encrypt_session_token(token: str) -> str:
    token = str(token or "")
    if not token:
        return ""
    secret = _secret()
    if not secret:
        assert_session_token_encryption_ready()
        return token
    encrypted = _fernet_from_secret(secret).encrypt(token.encode()).decode()
    return f"{_PREFIX}{encrypted}"


def decrypt_session_token(value: str) -> str:
    value = str(value or "")
    if not value:
        return ""
    if not value.startswith(_PREFIX):
        return value
    secret = _secret()
    if not secret:
        raise RuntimeError("SYNESIS_ADMIN_SESSION_TOKEN_KEY is required to decrypt admin session tokens")
    encrypted = value[len(_PREFIX) :].encode()
    try:
        return _fernet_from_secret(secret).decrypt(encrypted).decode()
    except InvalidToken as exc:
        raise ValueError("invalid encrypted admin session token") from exc


def is_encrypted_session_token(value: str) -> bool:
    return str(value or "").startswith(_PREFIX)
