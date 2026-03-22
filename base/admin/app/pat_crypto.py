"""PAT (Personal Access Token) cryptographic helpers.

Centralizes token generation, hashing, and verification so that both
the creation flow (``routers/tokens.py``) and the authentication flow
(``auth.py``) share identical logic.

Threat model
------------
PATs are high-entropy secrets (24 random hex bytes = 192 bits) prefixed
with ``syn-``.  They are never stored in plaintext.

**Without pepper (default / dev):**
    SHA-256(plaintext) — sufficient against online brute-force given the
    192-bit token space, but a DB dump exposes hashes vulnerable to
    rainbow-table or length-extension attacks if the attacker also
    compromises the token-generation PRNG seed (unlikely).

**With pepper (production):**
    HMAC-SHA256(pepper, plaintext) — the pepper is a server-side secret
    (``SYNESIS_PAT_PEPPER`` env var) never stored in the database.  Even
    if the DB is fully compromised, an attacker cannot verify candidate
    tokens without the pepper.

Migration: existing SHA-256 hashes continue to verify correctly when no
pepper is set. Setting a pepper invalidates all previously-issued tokens
— the operator should revoke-and-reissue via the admin UI after rotating
the pepper.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets

_PREFIX = "syn-"
_TOKEN_BYTES = 24

_PAT_PEPPER = os.getenv("SYNESIS_PAT_PEPPER", "")


def generate() -> tuple[str, str, str]:
    """Create a new PAT.  Returns ``(plaintext, hash, display_prefix)``."""
    raw = secrets.token_hex(_TOKEN_BYTES)
    plaintext = f"{_PREFIX}{raw}"
    token_hash = hash_token(plaintext)
    display_prefix = plaintext[:12]
    return plaintext, token_hash, display_prefix


def hash_token(plaintext: str) -> str:
    """Produce the storage hash for *plaintext*.

    Uses HMAC-SHA256 when ``SYNESIS_PAT_PEPPER`` is set, otherwise plain
    SHA-256 for backward compatibility with existing tokens.
    """
    if _PAT_PEPPER:
        return hmac.new(_PAT_PEPPER.encode(), plaintext.encode(), hashlib.sha256).hexdigest()
    return hashlib.sha256(plaintext.encode()).hexdigest()


def verify(plaintext: str, stored_hash: str) -> bool:
    """Constant-time comparison of *plaintext* against *stored_hash*."""
    return hmac.compare_digest(hash_token(plaintext), stored_hash)
