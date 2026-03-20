"""HTTP client for preprocess-service (simhash + optional HTML clean)."""

from __future__ import annotations

import os

import httpx
from synesis_telemetry import get_logger

logger = get_logger("synesis.indexer.preprocess")

_BATCH = 64


def preprocess_base_url() -> str:
    return (os.getenv("SYNESIS_INDEXER_PREPROCESS_URL") or "").strip().rstrip("/")


def preprocess_clean_html_enabled() -> bool:
    v = (os.getenv("SYNESIS_INDEXER_PREPROCESS_CLEAN_HTML") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def simhash_batch(texts: list[str]) -> list[str]:
    """Return simhash decimal strings; empty string if service disabled or on failure."""
    base = preprocess_base_url()
    if not base or not texts:
        return [""] * len(texts)
    out: list[str] = []
    try:
        with httpx.Client(timeout=120.0) as client:
            for i in range(0, len(texts), _BATCH):
                batch = texts[i : i + _BATCH]
                r = client.post(f"{base}/simhash/batch", json={"texts": batch})
                r.raise_for_status()
                data = r.json()
                part = data.get("simhashes") or []
                out.extend(str(x) if x is not None else "" for x in part)
    except Exception as e:
        logger.warning("preprocess_simhash_failed", extra={"error": str(e)})
        return [""] * len(texts)
    if len(out) != len(texts):
        logger.warning(
            "preprocess_simhash_len_mismatch",
            extra={"expected": len(texts), "got": len(out)},
        )
        return [""] * len(texts)
    return out


def clean_html_document(html: str) -> str | None:
    """Return cleaned main text, or None on failure / disabled."""
    base = preprocess_base_url()
    if not base or not html or not html.strip():
        return None
    try:
        r = httpx.post(
            f"{base}/clean_html",
            json={"html": html[:2_500_000]},
            timeout=90.0,
        )
        r.raise_for_status()
        text = (r.json().get("text") or "").strip()
        return text if text else None
    except Exception as e:
        logger.warning("preprocess_clean_html_failed", extra={"error": str(e)})
        return None
