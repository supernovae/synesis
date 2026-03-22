"""DistilBERT (or compatible) sequence classifier — spam probability on CPU."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("synesis.spam_service.classifier")

_pipe: Any = None
_spam_label_upper: str = "SPAM"


def _resolve_spam_label(id2label: dict[int | str, Any]) -> str:
    labs = {int(k): str(v).upper() for k, v in id2label.items()}
    for v in labs.values():
        if "SPAM" in v and "NOT" not in v:
            return v
    for v in labs.values():
        if "HAM" not in v and "LEGIT" not in v:
            return v
    if len(labs) == 2:
        return labs[max(labs.keys())]
    return "SPAM"


def load_model() -> None:
    global _pipe, _spam_label_upper
    if _pipe is not None:
        return
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

    model_id = (os.getenv("SPAM_MODEL") or "mariagrandury/distilbert-base-uncased-finetuned-sms-spam-detection").strip()
    revision = (os.getenv("SPAM_MODEL_REVISION") or "main").strip()
    token = (os.getenv("HF_TOKEN") or "").strip() or None
    logger.info("loading spam model %s@%s", model_id, revision)
    tok_kw: dict[str, Any] = {}
    model_kw: dict[str, Any] = {}
    if token:
        tok_kw["token"] = token
        model_kw["token"] = token
    # revision= must be explicit for supply-chain pinning (Bandit B615).
    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision, **tok_kw)
    model = AutoModelForSequenceClassification.from_pretrained(model_id, revision=revision, **model_kw)
    _spam_label_upper = _resolve_spam_label(model.config.id2label)
    logger.info("using spam label %s (id2label=%s)", _spam_label_upper, model.config.id2label)
    _pipe = pipeline(
        "text-classification",
        model=model,
        tokenizer=tokenizer,
        top_k=None,
        truncation=True,
        max_length=512,
    )


def spam_probabilities(texts: list[str]) -> list[float]:
    """Return P(spam) in [0,1] per text (0.0 for empty)."""
    if _pipe is None:
        raise RuntimeError("spam model not loaded")
    if not texts:
        return []
    raw = _pipe(texts)
    if not isinstance(raw, list):
        raw = [raw]
    return [_row_spam_score(row) for row in raw]


def _row_spam_score(row: Any) -> float:
    if isinstance(row, dict):
        row = [row]
    if not row:
        return 0.0
    lu = {str(x.get("label", "")).upper(): float(x.get("score", 0.0)) for x in row}
    if _spam_label_upper in lu:
        return min(1.0, max(0.0, lu[_spam_label_upper]))
    for k, v in lu.items():
        if "SPAM" in k and "NOT" not in k:
            return min(1.0, max(0.0, v))
    return 0.0
