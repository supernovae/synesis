"""Frame-driven query distillation for focused RAG and web retrieval.

Builds retrieval queries from the pre-extracted UserTask (main_question,
deliverables, domain) instead of parsing raw prompt text.  This eliminates
instructional language, newlines, and prompt boilerplate from queries.

Fallback path (distill_query) preserved for callers without a frame.

Research basis:
- FrameRTE (EMNLP 2025) — "frame first, then extract" paradigm
- Generative FrameNet (NeuSymBridge 2025) — task-specific frames improve
  retrieval grounding by up to 8 points
- IterKey (arXiv:2505.08450) — keyword-based retrieval queries achieve
  5-20% accuracy improvement over raw BM25
- Keyword extraction via keyword-service microservice (replaces in-process
  KeyBERT), reuses the same all-MiniLM-L6-v2 model via TEI embedder
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

logger = logging.getLogger("synesis.query_distiller")

_WHITESPACE_RE = re.compile(r"\s+")
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "shall",
        "should",
        "may",
        "might",
        "must",
        "can",
        "could",
        "to",
        "of",
        "in",
        "for",
        "on",
        "with",
        "at",
        "by",
        "from",
        "as",
        "into",
        "through",
        "during",
        "before",
        "after",
        "above",
        "below",
        "between",
        "out",
        "off",
        "over",
        "under",
        "again",
        "further",
        "then",
        "once",
        "here",
        "there",
        "when",
        "where",
        "why",
        "how",
        "all",
        "each",
        "every",
        "both",
        "few",
        "more",
        "most",
        "other",
        "some",
        "such",
        "no",
        "nor",
        "not",
        "only",
        "own",
        "same",
        "so",
        "than",
        "too",
        "very",
        "just",
        "because",
        "but",
        "and",
        "or",
        "if",
        "while",
        "about",
        "up",
        "it",
        "its",
        "this",
        "that",
        "these",
        "those",
        "i",
        "me",
        "my",
        "we",
        "our",
        "you",
        "your",
        "he",
        "him",
        "she",
        "her",
        "they",
        "them",
        "what",
        "which",
        "who",
        "whom",
    }
)


_keyword_client: httpx.Client | None = None


def _get_keyword_client() -> httpx.Client:
    global _keyword_client
    if _keyword_client is None:
        from .config import settings

        _keyword_client = httpx.Client(
            base_url=settings.keyword_service_url,
            timeout=10,
        )
    return _keyword_client


def _extract_section_topic(section_action: str) -> str:
    """Extract clean section topic from a planner action string."""
    topic = section_action.split("\u2014")[0].strip() if "\u2014" in section_action else section_action
    if ":" in topic:
        topic = topic.split(":", 1)[1].strip()
    return _sanitize(topic)


def _sanitize(text: str) -> str:
    """Strip newlines, collapse whitespace, remove instructional prefixes."""
    text = text.replace("\n", " ").replace("\r", " ")
    text = _WHITESPACE_RE.sub(" ", text).strip()
    return text


def _extract_key_terms(text: str, max_terms: int = 5) -> list[str]:
    """Extract salient terms via the keyword-service or word-frequency fallback."""
    text = _sanitize(text)
    if not text:
        return []

    try:
        resp = _get_keyword_client().post(
            "/keywords",
            json={
                "text": text[:500],
                "top_n": max_terms,
                "ngram_range": [1, 2],
                "use_mmr": False,
            },
        )
        resp.raise_for_status()
        keywords = resp.json().get("keywords", [])
        if keywords:
            return [kw for kw, _score in keywords]
    except Exception:
        logger.debug("keyword_service_extraction_failed", exc_info=True)

    words = [w for w in re.findall(r"\w+", text.lower()) if w not in _STOPWORDS and len(w) > 2]
    seen: set[str] = set()
    unique: list[str] = []
    for w in words:
        if w not in seen:
            seen.add(w)
            unique.append(w)
    return unique[:max_terms]


def _match_deliverable(section_topic: str, deliverables: list[str]) -> str:
    """Find the deliverable that best matches the section topic.

    Uses the TEI embedder for cosine similarity when available, falling back
    to token overlap.
    """
    if not deliverables:
        return ""

    try:
        import numpy as np

        from .embed_client import get_embed_client

        client = get_embed_client()
        texts = [section_topic, *deliverables]
        embs = client.embed(texts, normalize=True)
        topic_emb = embs[0]
        sims = [float(np.dot(topic_emb, embs[i + 1])) for i in range(len(deliverables))]
        best_idx = sims.index(max(sims))
        logger.debug(
            "deliverable_matched_encoder",
            extra={
                "section": section_topic[:40],
                "matched": deliverables[best_idx][:60],
                "similarity": round(max(sims), 3),
            },
        )
        return deliverables[best_idx]
    except Exception:
        logger.debug("deliverable_match_encoder_fallback", exc_info=True)

    topic_tokens = set(section_topic.lower().split())
    best_score = 0
    best = deliverables[0]
    for d in deliverables:
        d_tokens = set(d.lower().split())
        overlap = len(topic_tokens & d_tokens)
        if overlap > best_score:
            best_score = overlap
            best = d
    return best


# ---------------------------------------------------------------------------
# Frame-driven query builders (preferred path for section workers)
# ---------------------------------------------------------------------------


def _dedup_terms(terms: list[str], exclude_tokens: set[str]) -> list[str]:
    """Remove terms that overlap with exclude_tokens (case-insensitive)."""
    seen: set[str] = set()
    out: list[str] = []
    for t in terms:
        t_lower = t.lower()
        if t_lower in seen or t_lower in exclude_tokens:
            continue
        if any(tok in exclude_tokens for tok in t_lower.split()):
            continue
        seen.add(t_lower)
        out.append(t)
    return out


def distill_from_frame(
    section_action: str,
    user_task: dict[str, Any],
) -> str:
    """Build a focused RAG query from UserTask fields.

    Extracts key terms from the main question and constraints — NOT
    from the deliverable, which tends to echo the section title and
    produce repetitive queries.  Terms are deduplicated against the
    section topic to avoid word repetition.

    Produces queries like:
      "Model Choices coding assistant latency cost budget"
    instead of:
      "Model Choices model choices model choices software architecture"
    """
    section_topic = _extract_section_topic(section_action)
    domain_tags = user_task.get("domain_tags") or []
    domain = domain_tags[0] if domain_tags else ""
    problem = _sanitize(user_task.get("main_question", ""))
    constraints = user_task.get("constraints") or []
    constraint_text = " ".join(constraints[:3])

    source_text = f"{problem} {constraint_text}".strip()
    key_terms = _extract_key_terms(source_text, max_terms=5)

    topic_tokens = {w.lower() for w in section_topic.split() if len(w) > 2}
    unique_terms = _dedup_terms(key_terms, topic_tokens)

    parts = [section_topic, *unique_terms[:4]]
    if domain and domain.lower() not in section_topic.lower():
        parts.append(domain.replace("_", " "))

    query = " ".join(parts)
    query = _sanitize(query)

    logger.debug(
        "distill_from_frame",
        extra={
            "section": section_topic[:40],
            "key_terms": unique_terms[:4],
            "domain": domain,
            "query": query[:100],
        },
    )
    return query[:200]


_AUTHORITY_QUALIFIERS: dict[str, str] = {
    "architecture": "best practices",
    "design": "best practices",
    "pattern": "best practices",
    "retrieval": "documentation",
    "security": "best practices OWASP",
    "deployment": "production guide",
    "scaling": "production",
    "monitoring": "observability guide",
    "testing": "best practices",
    "cost": "optimization guide",
    "model": "comparison benchmark",
    "rollout": "implementation guide",
    "migration": "guide",
}


def distill_web_from_frame(
    section_action: str,
    user_task: dict[str, Any],
) -> str:
    """Build a concise web search query (5-10 words) from UserTask fields.

    Extracts key terms from main_question + constraints (the rich context) rather
    than the deliverable, which echoes the section title.  Deduplicates
    against the section topic to keep queries short and search-engine-friendly.

    Appends authority-seeking qualifiers based on the section topic to steer
    results toward official docs and established guides.

    Produces: "Model Choices coding assistant best practices"
    """
    section_topic = _extract_section_topic(section_action)
    domain_tags = user_task.get("domain_tags") or []
    domain = domain_tags[0] if domain_tags else ""
    problem = _sanitize(user_task.get("main_question", ""))
    constraints = user_task.get("constraints") or []
    constraint_text = " ".join(constraints[:3])

    source_text = f"{problem} {constraint_text}".strip()
    key_terms = _extract_key_terms(source_text, max_terms=4)

    topic_tokens = {w.lower() for w in section_topic.split() if len(w) > 2}
    unique_terms = _dedup_terms(key_terms, topic_tokens)

    parts = [section_topic, *unique_terms[:3]]
    if domain and domain.lower() not in section_topic.lower():
        parts.append(domain.replace("_", " "))

    # Authority qualifier: append topic-aware suffix to steer toward
    # official docs and established guides rather than blog posts
    topic_lower = section_topic.lower()
    qualifier = ""
    for keyword, qual in _AUTHORITY_QUALIFIERS.items():
        if keyword in topic_lower:
            qualifier = qual
            break
    if qualifier:
        parts.append(qualifier)

    query = " ".join(parts)
    query = _sanitize(query)

    logger.debug(
        "distill_web_from_frame",
        extra={"section": section_topic[:40], "web_query": query[:80], "qualifier": qualifier},
    )
    return query[:80]


def decompose_section_queries(
    section_action: str,
    user_task: dict[str, Any],
    max_queries: int = 3,
) -> list[tuple[str, str]]:
    """Decompose a complex section into multiple (rag_query, web_query) pairs.

    Uses the user_task's explicit_requirements to identify sub-topics relevant
    to this section.  For each matching requirement, builds a targeted query
    combining the requirement with relevant constraints.  Returns 1-3 query pairs.

    Deterministic — no LLM call.  Uses TEI embedder for requirement-section
    similarity when available, falling back to token overlap.
    """
    primary_rag = distill_from_frame(section_action, user_task)
    primary_web = distill_web_from_frame(section_action, user_task)
    pairs: list[tuple[str, str]] = [(primary_rag, primary_web)]

    goals = user_task.get("explicit_requirements") or []
    if not goals or max_queries <= 1:
        return pairs

    section_topic = _extract_section_topic(section_action)
    constraints = user_task.get("constraints") or []
    domain_tags = user_task.get("domain_tags") or []
    domain = domain_tags[0] if domain_tags else ""

    scored_goals: list[tuple[float, str]] = []
    try:
        import numpy as np

        from .embed_client import get_embed_client

        client = get_embed_client()
        texts = [section_topic, *goals]
        embs = client.embed(texts, normalize=True)
        topic_emb = embs[0]
        for i, goal in enumerate(goals):
            sim = float(np.dot(topic_emb, embs[i + 1]))
            if sim > 0.3:
                scored_goals.append((sim, goal))
        scored_goals.sort(reverse=True)
    except Exception:
        logger.debug("decompose_encoder_fallback", exc_info=True)
        topic_tokens = set(section_topic.lower().split())
        for goal in goals:
            goal_tokens = set(goal.lower().split())
            overlap = len(topic_tokens & goal_tokens)
            if overlap >= 1:
                scored_goals.append((float(overlap), goal))
        scored_goals.sort(reverse=True)

    topic_tokens_set = {w.lower() for w in section_topic.split() if len(w) > 2}

    for _sim, goal in scored_goals[: max_queries - 1]:
        goal_text = f"{goal} {' '.join(constraints[:2])}".strip()
        terms = _extract_key_terms(goal_text, max_terms=4)
        unique = _dedup_terms(terms, topic_tokens_set)
        if not unique:
            continue

        rag_parts = [section_topic, *unique[:3]]
        if domain and domain.lower() not in section_topic.lower():
            rag_parts.append(domain.replace("_", " "))
        rag_q = _sanitize(" ".join(rag_parts))[:200]

        web_parts = [section_topic, *unique[:2]]
        web_q = _sanitize(" ".join(web_parts))[:80]

        pairs.append((rag_q, web_q))

    logger.debug(
        "decompose_section_queries",
        extra={"section": section_topic[:40], "query_count": len(pairs)},
    )
    return pairs


# ---------------------------------------------------------------------------
# Legacy fallback (for callers without a frame, e.g. supervisor web search)
# ---------------------------------------------------------------------------


def distill_query(section_action: str, task_description: str) -> str:
    """Extract keyphrases and compose a focused retrieval query.

    Legacy path for callers that don't have a UserTask available.
    Prefer distill_from_frame() when the frame is available.
    """
    section_topic = _extract_section_topic(section_action)

    fallback = section_topic
    if task_description:
        first_sentence = task_description.split(".")[0].strip()[:80]
        if first_sentence:
            fallback = _sanitize(f"{section_topic} {first_sentence}")

    if not task_description or not task_description.strip():
        return fallback

    try:
        combined = _sanitize(f"{section_action} {task_description}")[:1000]
        resp = _get_keyword_client().post(
            "/keywords",
            json={
                "text": combined,
                "top_n": 5,
                "ngram_range": [1, 3],
                "use_mmr": False,
            },
        )
        resp.raise_for_status()
        keywords = resp.json().get("keywords", [])
        if not keywords:
            return fallback

        phrases = [kw for kw, _score in keywords]
        query = f"{section_topic} {' '.join(phrases)}"
        query = _sanitize(query)
        logger.debug(
            "distill_query",
            extra={"section": section_topic[:40], "keyphrases": phrases},
        )
        return query[:200]
    except Exception:
        logger.warning("distill_query_failed", exc_info=True)
        return fallback
