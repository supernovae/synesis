"""64-bit simhash for near-duplicate signals (stored as decimal string in Content graph)."""

from __future__ import annotations

from simhash import Simhash


def text_simhash_decimal(text: str) -> str:
    """Return unsigned 64-bit simhash as decimal string (fits VARCHAR 24)."""
    if not text or not text.strip():
        return ""
    return str(Simhash(text).value)
