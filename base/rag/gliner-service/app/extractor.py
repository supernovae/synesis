"""GLiNER2 model wrapper for schema-driven entity extraction.

Optimizations:
- Classification uses a single predict_entities call (not one per category)
- LRU cache avoids recomputation for identical prompts
- Thread-safe for use with asyncio.to_thread()
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict

logger = logging.getLogger("gliner_service.extractor")

_MODEL_NAME = os.getenv("GLINER_MODEL", "knowledgator/gliner-multitask-large-v0.5")
_DEFAULT_THRESHOLD = float(os.getenv("GLINER_THRESHOLD", "0.4"))
_CACHE_SIZE = int(os.getenv("GLINER_CACHE_SIZE", "256"))

_model = None
_model_lock = threading.Lock()

_cache: OrderedDict[str, dict] = OrderedDict()
_cache_lock = threading.Lock()


def _cache_key(text: str, labels: list[str], threshold: float) -> str:
    raw = f"{text}|{'|'.join(sorted(labels))}|{threshold}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _cache_get(key: str) -> dict | None:
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    return None


def _cache_put(key: str, value: dict) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)


def load_model():
    """Load GLiNER model at startup. Called once from lifespan."""
    global _model
    from gliner import GLiNER

    t0 = time.monotonic()
    _model = GLiNER.from_pretrained(_MODEL_NAME)
    elapsed = time.monotonic() - t0
    logger.info("gliner_model_loaded model=%s elapsed=%.1fs", _MODEL_NAME, elapsed)
    return _model


def extract(
    text: str,
    entity_labels: dict[str, str],
    classification_categories: list[str] | None = None,
    threshold: float | None = None,
) -> dict:
    """Run GLiNER entity extraction on text with the given schema.

    Entity extraction and classification run as at most 2 predict_entities
    calls (down from 1 + N_categories in the original implementation).
    Results are LRU-cached by (text, labels, threshold).
    """
    if _model is None:
        raise RuntimeError("GLiNER model not loaded — call load_model() first")

    threshold = threshold if threshold is not None else _DEFAULT_THRESHOLD
    labels = list(entity_labels.keys())
    all_labels = labels + (classification_categories or [])

    key = _cache_key(text, all_labels, threshold)
    cached = _cache_get(key)
    if cached is not None:
        logger.info("gliner_cache_hit key=%s", key[:12])
        return cached

    t0 = time.monotonic()

    with _model_lock:
        raw_entities = _model.predict_entities(text, labels, threshold=threshold)

    entity_ms = (time.monotonic() - t0) * 1000

    entities: dict[str, list[dict]] = {label: [] for label in labels}
    for ent in raw_entities:
        label = ent.get("label", "")
        if label in entities:
            entities[label].append(
                {
                    "text": ent.get("text", ""),
                    "start": ent.get("start", -1),
                    "end": ent.get("end", -1),
                    "confidence": round(ent.get("score", 0.0), 4),
                }
            )

    classification = ""
    if classification_categories:
        t1 = time.monotonic()
        with _model_lock:
            cls_entities = _model.predict_entities(text, classification_categories, threshold=0.1)
        cls_ms = (time.monotonic() - t1) * 1000

        best_cat = ""
        best_score = 0.0
        for ent in cls_entities:
            score = ent.get("score", 0.0)
            if score > best_score:
                best_score = score
                best_cat = ent.get("label", "")
        classification = best_cat

        logger.info(
            "gliner_classification category=%s score=%.3f elapsed=%.0fms",
            classification or "none",
            best_score,
            cls_ms,
        )

    total_spans = sum(len(v) for v in entities.values())
    total_ms = (time.monotonic() - t0) * 1000
    logger.info(
        "gliner_extract spans=%d classification=%s entity_ms=%.0f total_ms=%.0f",
        total_spans,
        classification or "none",
        entity_ms,
        total_ms,
    )

    result = {"entities": entities, "classification": classification}
    _cache_put(key, result)
    return result
