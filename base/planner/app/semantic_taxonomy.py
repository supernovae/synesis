"""Semantic taxonomy validator — embedding-based cross-check for keyword classification.

Uses cosine similarity between the user query and pre-computed taxonomy node
embeddings to validate (or override) the keyword-based taxonomy assignment from
the entry classifier.  Catches misclassifications where an ambiguous keyword
(e.g. "sample") triggers the wrong domain.

Follows the same pattern as semantic_intent.py: lazy-loaded singleton
embeddings via the TEI embedder, numpy cosine similarity, graceful fallback.

Research basis (shared with semantic_intent):
- Semantic Router (Aurelio Labs) — cosine similarity over route embeddings
- VecStat/NormStat (ICLR 2026) — training-free methods beat keyword classifiers
  on ambiguous and out-of-distribution prompts
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np

logger = logging.getLogger("synesis.semantic_taxonomy")

# ---------------------------------------------------------------------------
# Lazy-loaded state: taxonomy keys + embedding matrix
# ---------------------------------------------------------------------------

_taxonomy_keys: list[str] = []
_taxonomy_embeddings: np.ndarray | None = None
_loaded = False


def _compose_description(key: str, node: dict[str, Any]) -> str:
    """Build a short text description for embedding from taxonomy node fields."""
    parts: list[str] = []

    path = node.get("path", "")
    if path:
        parts.append(path.replace(" > ", ": "))

    persona = node.get("persona", "")
    if persona:
        parts.append(persona)

    tone = (node.get("worker_explain_tone") or "").strip()
    if tone:
        parts.append(tone)

    hints = node.get("query_expansion_hints") or []
    if hints:
        parts.append("Topics: " + ", ".join(str(h) for h in hints[:10]))

    elements = node.get("required_elements") or []
    if elements:
        parts.append("Sections: " + ", ".join(str(e) for e in elements[:8]))

    return ". ".join(parts) if parts else key


def _ensure_loaded() -> bool:
    """Compute taxonomy embeddings on first call via the TEI embedder."""
    global _taxonomy_keys, _taxonomy_embeddings, _loaded
    if _loaded:
        return _taxonomy_embeddings is not None
    _loaded = True
    try:
        from .embed_client import get_embed_client
        from .taxonomy_prompt_factory import _get_taxonomies

        taxonomies = _get_taxonomies()
        if not taxonomies:
            logger.warning("semantic_taxonomy_no_nodes")
            return False

        keys: list[str] = []
        descriptions: list[str] = []
        for key, node in taxonomies.items():
            if not isinstance(node, dict) or not node.get("path"):
                continue
            desc = _compose_description(key, node)
            keys.append(key)
            descriptions.append(desc)

        if not keys:
            logger.warning("semantic_taxonomy_no_descriptions")
            return False

        client = get_embed_client()
        embeddings = client.embed(descriptions, normalize=True)

        _taxonomy_keys = keys
        _taxonomy_embeddings = np.array(embeddings, dtype=np.float32)

        logger.info(
            "semantic_taxonomy_loaded",
            extra={"nodes": len(keys)},
        )
        return True
    except Exception:
        logger.warning("semantic_taxonomy_load_failed", exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass
class TaxonomyValidation:
    """Result of semantic cross-check against keyword-selected taxonomy."""

    recommended_key: str = "generic"
    keyword_key: str = "generic"
    semantic_top: list[tuple[str, float]] = field(default_factory=list)
    keyword_score: float = 0.0
    overridden: bool = False
    ambiguous: bool = False


def validate_taxonomy(
    query: str,
    keyword_key: str,
    top_k: int = 3,
    override_threshold: float = 0.15,
) -> TaxonomyValidation:
    """Cross-check keyword-selected taxonomy against embedding similarity.

    Returns a TaxonomyValidation indicating whether the keyword choice should
    be kept, overridden, or flagged as ambiguous.  On any failure (TEI down,
    embeddings not loaded), returns the keyword_key unchanged.

    Parameters
    ----------
    query : str
        The user's message text.
    keyword_key : str
        The taxonomy key selected by the keyword classifier.
    top_k : int
        Number of top semantic candidates to return.
    override_threshold : float
        Minimum similarity margin between the semantic top-1 and the keyword
        key's score required to trigger an override.
    """
    result = TaxonomyValidation(
        recommended_key=keyword_key,
        keyword_key=keyword_key,
    )

    if not query or not query.strip():
        return result

    try:
        if not _ensure_loaded():
            return result

        from .embed_client import get_embed_client

        client = get_embed_client()
        query_emb = client.embed([query[:1000]], normalize=True)[0]

        similarities = np.dot(_taxonomy_embeddings, query_emb)

        top_indices = np.argsort(similarities)[::-1][:top_k]
        semantic_top = [
            (_taxonomy_keys[i], round(float(similarities[i]), 4))
            for i in top_indices
        ]
        result.semantic_top = semantic_top

        kw_score = 0.0
        if keyword_key in _taxonomy_keys:
            kw_idx = _taxonomy_keys.index(keyword_key)
            kw_score = float(similarities[kw_idx])
        result.keyword_score = round(kw_score, 4)

        if not semantic_top:
            return result

        sem_top_key, sem_top_score = semantic_top[0]

        if sem_top_key == keyword_key:
            result.recommended_key = keyword_key
            logger.info(
                "taxonomy_semantic_agree",
                extra={
                    "key": keyword_key,
                    "score": round(sem_top_score, 3),
                },
            )
            return result

        margin = sem_top_score - kw_score
        sem_top_keys = [k for k, _ in semantic_top]

        if keyword_key not in sem_top_keys or margin > override_threshold:
            result.recommended_key = sem_top_key
            result.overridden = True
            logger.info(
                "taxonomy_semantic_override",
                extra={
                    "keyword_key": keyword_key,
                    "keyword_score": round(kw_score, 3),
                    "semantic_key": sem_top_key,
                    "semantic_score": round(sem_top_score, 3),
                    "margin": round(margin, 3),
                },
            )
        else:
            result.recommended_key = keyword_key
            result.ambiguous = True
            logger.info(
                "taxonomy_semantic_ambiguous",
                extra={
                    "keyword_key": keyword_key,
                    "keyword_score": round(kw_score, 3),
                    "semantic_key": sem_top_key,
                    "semantic_score": round(sem_top_score, 3),
                    "margin": round(margin, 3),
                },
            )

        return result
    except Exception:
        logger.warning("taxonomy_semantic_validate_failed", exc_info=True)
        return result


def invalidate_cache() -> None:
    """Reset cached embeddings (e.g. after taxonomy config reload)."""
    global _taxonomy_keys, _taxonomy_embeddings, _loaded
    _taxonomy_keys = []
    _taxonomy_embeddings = None
    _loaded = False
