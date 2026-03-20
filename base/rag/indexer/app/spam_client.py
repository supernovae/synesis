"""HTTP client for spam-service (batch P(spam) scores)."""

from __future__ import annotations

import os

import httpx
from synesis_telemetry import get_logger

logger = get_logger("synesis.indexer.spam")

_BATCH = 32


def spam_base_url() -> str:
    return (os.getenv("SYNESIS_INDEXER_SPAM_URL") or "").strip().rstrip("/")


def spam_batch(texts: list[str]) -> list[float]:
    """Return spam probability per text; -1.0 if disabled or on failure."""
    base = spam_base_url()
    if not base or not texts:
        return [-1.0] * len(texts)
    out: list[float] = []
    try:
        with httpx.Client(timeout=120.0) as client:
            for i in range(0, len(texts), _BATCH):
                batch = texts[i : i + _BATCH]
                r = client.post(f"{base}/spam/batch", json={"texts": batch})
                r.raise_for_status()
                data = r.json()
                part = data.get("scores") or []
                for x in part:
                    try:
                        out.append(float(x))
                    except (TypeError, ValueError):
                        out.append(-1.0)
    except Exception as e:
        logger.warning("spam_batch_failed", extra={"error": str(e)})
        return [-1.0] * len(texts)
    if len(out) != len(texts):
        logger.warning("spam_batch_len_mismatch", extra={"expected": len(texts), "got": len(out)})
        return [-1.0] * len(texts)
    return out
