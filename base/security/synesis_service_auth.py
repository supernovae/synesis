"""Synesis service-to-service authentication — stdlib-only, zero dependencies.

This module provides two authentication tiers for internal service communication:

**Tier 1 — Bearer Token** (``verify_bearer``):
  Simple shared-secret comparison.  Appropriate for API services that have
  their own input validation and authorization (admin, planner identity trust,
  indexer queue).

**Tier 2 — HMAC-Signed Request** (``sign_request`` / ``verify_request``):
  Per-request HMAC-SHA256 signature bound to the request body.  Prevents
  replay, tampering, and unauthorized execution even if a static token leaks.
  Required for services that execute untrusted input (warm pool, sandbox).

Protocol (Tier 2)::

    Authorization: Bearer HMAC-SHA256:<hex_sig>:<unix_ts>:<nonce>

    sig = HMAC-SHA256(secret, "<timestamp>:<nonce>:<sha256(body)>")

The module is **stdlib-only** so it can be COPY'd into minimal container
images (sandbox, warm pool) that have no pip-installed packages.

See ``docs/PRODUCTION_SECURITY.md`` for deployment guidance and
``.cursor/rules/service-to-service-auth.mdc`` for the development standard.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time

_SCHEME = "HMAC-SHA256"
_DEFAULT_MAX_AGE = 300  # 5-minute clock-skew tolerance


# ---------------------------------------------------------------------------
# Tier 1 — Bearer Token
# ---------------------------------------------------------------------------


def configured_service_tokens(
    token_env: str = "SYNESIS_INTERNAL_SERVICE_TOKEN",  # noqa: S107
    tokens_env: str = "SYNESIS_INTERNAL_SERVICE_TOKENS",
) -> list[str]:
    """Read and deduplicate service tokens from environment variables."""
    out: list[str] = []
    one = os.environ.get(token_env, "").strip()
    if one:
        out.append(one)
    many = os.environ.get(tokens_env, "").strip()
    if many:
        out.extend(t.strip() for t in many.split(",") if t.strip())
    seen: set[str] = set()
    deduped: list[str] = []
    for t in out:
        if t not in seen:
            seen.add(t)
            deduped.append(t)
    return deduped


def verify_bearer(token: str, secrets: list[str]) -> bool:
    """Constant-time comparison of *token* against a list of valid secrets."""
    if not token:
        return False
    for candidate in secrets:
        if hmac.compare_digest(token, candidate):
            return True
    return False


# ---------------------------------------------------------------------------
# Tier 2 — HMAC-Signed Request
# ---------------------------------------------------------------------------


def sign_request(body: bytes, secret: str) -> dict[str, str]:
    """Create an ``Authorization`` header with an HMAC-SHA256 signature.

    Returns a dict suitable for passing as ``headers=`` to httpx / urllib.

    The signature covers ``<timestamp>:<nonce>:<sha256(body)>`` so the
    token is bound to the specific request body and a time window.
    """
    ts = str(int(time.time()))
    nonce = hashlib.sha256(os.urandom(16)).hexdigest()[:16]
    body_hash = hashlib.sha256(body).hexdigest()
    payload = f"{ts}:{nonce}:{body_hash}"
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return {"Authorization": f"Bearer {_SCHEME}:{sig}:{ts}:{nonce}"}


def verify_request(
    auth_header: str,
    body: bytes,
    secret: str,
    *,
    max_age: int = _DEFAULT_MAX_AGE,
) -> tuple[bool, str]:
    """Validate an HMAC-signed ``Authorization`` header.

    Returns ``(valid, reason)`` where *reason* explains rejection.
    When *secret* is empty, returns ``(True, "auth_disabled")`` — this
    allows dev/test environments to run without configuring secrets.
    """
    if not secret:
        return True, "auth_disabled"

    if not auth_header:
        return False, "missing_authorization_header"

    token = auth_header
    if token.lower().startswith("bearer "):
        token = token[7:]

    parts = token.split(":")
    if len(parts) != 4 or parts[0] != _SCHEME:
        return False, "invalid_scheme_or_format"

    _, sig_hex, ts_str, nonce = parts

    try:
        ts = int(ts_str)
    except ValueError:
        return False, "invalid_timestamp"

    age = abs(int(time.time()) - ts)
    if age > max_age:
        return False, f"expired_timestamp (age={age}s, max={max_age}s)"

    if not nonce or len(nonce) > 64:
        return False, "invalid_nonce"

    body_hash = hashlib.sha256(body).hexdigest()
    payload = f"{ts_str}:{nonce}:{body_hash}"
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(sig_hex, expected):
        return False, "signature_mismatch"

    return True, "ok"
