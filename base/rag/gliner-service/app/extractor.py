"""GLiNER2 model wrapper for schema-driven entity extraction."""

from __future__ import annotations

import logging
import os
import time

logger = logging.getLogger("gliner_service.extractor")

_MODEL_NAME = os.getenv("GLINER_MODEL", "knowledgator/gliner-multitask-large-v0.5")
_DEFAULT_THRESHOLD = float(os.getenv("GLINER_THRESHOLD", "0.4"))

_model = None


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

    Args:
        text: Raw user prompt.
        entity_labels: Mapping of label -> description for NER extraction.
        classification_categories: Optional list of classification labels.
        threshold: Confidence threshold for entity extraction (default from env).

    Returns:
        dict with "entities" (label -> list of span dicts) and "classification" str.
    """
    if _model is None:
        raise RuntimeError("GLiNER model not loaded — call load_model() first")

    threshold = threshold if threshold is not None else _DEFAULT_THRESHOLD
    labels = list(entity_labels.keys())

    t0 = time.monotonic()
    raw_entities = _model.predict_entities(text, labels, threshold=threshold)
    elapsed_ms = (time.monotonic() - t0) * 1000

    entities: dict[str, list[dict]] = {label: [] for label in labels}
    for ent in raw_entities:
        label = ent.get("label", "")
        if label in entities:
            entities[label].append({
                "text": ent.get("text", ""),
                "start": ent.get("start", -1),
                "end": ent.get("end", -1),
                "confidence": round(ent.get("score", 0.0), 4),
            })

    classification = ""
    if classification_categories and len(classification_categories) > 0:
        best_cat = ""
        best_score = 0.0
        for cat in classification_categories:
            try:
                cat_entities = _model.predict_entities(
                    text, [cat], threshold=0.1
                )
                if cat_entities:
                    score = max(e.get("score", 0.0) for e in cat_entities)
                    if score > best_score:
                        best_score = score
                        best_cat = cat
            except Exception:
                continue
        classification = best_cat

    total_spans = sum(len(v) for v in entities.values())
    logger.info(
        "gliner_extract spans=%d classification=%s elapsed=%.0fms",
        total_spans,
        classification or "none",
        elapsed_ms,
    )

    return {"entities": entities, "classification": classification}
