"""Semantic intent classifier — embedding-based is_code_task detection.

Replaces regex-based code_rescue with cosine similarity against pre-computed
route embeddings. Uses the TEI embedder service over HTTP via embed_client.

Research basis:
- Semantic Router (Aurelio Labs) — cosine similarity over route embeddings
- VecStat/NormStat (ICLR 2026) — training-free methods are more robust to
  ambiguous and out-of-distribution prompts than keyword classifiers
- Routesplain (arXiv:2511.09373) — interpretable concept-based routing for
  software tasks outperforms black-box and keyword baselines
"""

from __future__ import annotations

import logging

import numpy as np

logger = logging.getLogger("synesis.semantic_intent")

# ---------------------------------------------------------------------------
# Route utterances — example phrases for each intent category.
# The classifier embeds the user query and compares against the mean embedding
# of each route. More examples = better coverage of the semantic space.
# ---------------------------------------------------------------------------

CODE_OUTPUT_UTTERANCES = [
    "Write a Python function to sort a list",
    "Create a React component for a login form",
    "Show me a code snippet for a sticky header in CSS and JavaScript",
    "Implement binary search in Rust",
    "Write a bash script to deploy to Kubernetes",
    "Create a Terraform module for an S3 bucket",
    "Give me a Python class that handles database connections",
    "Write unit tests for this function",
    "Refactor this code to use async/await",
    "Show me how to parse JSON in Go",
    "Build a REST API endpoint in FastAPI",
    "Write a Dockerfile for a Node.js app",
    "Create a GitHub Actions workflow for CI/CD",
    "Implement a linked list in TypeScript",
    "Write a SQL query to find duplicate records",
]

KNOWLEDGE_DISCUSSION_UTTERANCES = [
    "Propose an architecture for an internal coding assistant supporting Python workflows",
    "Explain how Kubernetes scheduling works",
    "What are the tradeoffs between SQL and NoSQL for this use case",
    "Design a system architecture for 80 engineers",
    "Compare microservices vs monolith for a small team",
    "How does the CAP theorem apply to distributed databases",
    "What model should I use for a RAG pipeline",
    "Explain the difference between REST and gRPC",
    "What are failure modes in a distributed cache",
    "How should I structure my Terraform for multi-environment deployments",
    "What are best practices for Kubernetes RBAC",
    "Explain how vector databases work for retrieval",
    "What are the tradeoffs of using spot instances on AWS",
    "How does OAuth 2.0 work with PKCE",
    "Describe a phased rollout plan for deploying an AI assistant",
]

# ---------------------------------------------------------------------------
# Lazy-loaded singleton route embeddings (computed once via TEI embedder)
# ---------------------------------------------------------------------------

_code_embedding: np.ndarray | None = None
_knowledge_embedding: np.ndarray | None = None
_loaded = False


def _ensure_loaded() -> bool:
    """Compute route embeddings on first call via the TEI embedder service."""
    global _code_embedding, _knowledge_embedding, _loaded
    if _loaded:
        return _code_embedding is not None
    _loaded = True
    try:
        from .embed_client import get_embed_client

        client = get_embed_client()
        code_embs = client.embed(CODE_OUTPUT_UTTERANCES, normalize=True)
        _code_embedding = np.mean(code_embs, axis=0)

        knowledge_embs = client.embed(KNOWLEDGE_DISCUSSION_UTTERANCES, normalize=True)
        _knowledge_embedding = np.mean(knowledge_embs, axis=0)

        logger.info("semantic_intent_loaded", extra={"source": "tei_embedder"})
        return True
    except Exception:
        logger.warning("semantic_intent_load_failed", exc_info=True)
        return False


def classify_code_intent(text: str, threshold: float = 0.5) -> tuple[bool, float]:
    """Classify whether the user query requests code output or knowledge discussion.

    Returns (is_code, confidence) where confidence is the margin between the
    code similarity and knowledge similarity scores. Positive = code, negative = knowledge.
    The threshold controls how much margin is needed to classify as code.

    On any error, returns (False, 0.0) — safe fallback to knowledge/markdown.
    """
    if not text or not text.strip():
        return False, 0.0
    try:
        if not _ensure_loaded():
            return False, 0.0

        from .embed_client import get_embed_client

        client = get_embed_client()
        query_embedding = client.embed([text[:1000]], normalize=True)[0]

        code_sim = float(np.dot(query_embedding, _code_embedding))
        knowledge_sim = float(np.dot(query_embedding, _knowledge_embedding))
        margin = code_sim - knowledge_sim

        is_code = margin > threshold
        logger.info(
            "semantic_classify",
            extra={
                "code_sim": round(code_sim, 3),
                "knowledge_sim": round(knowledge_sim, 3),
                "margin": round(margin, 3),
                "threshold": threshold,
                "is_code": is_code,
            },
        )
        return is_code, margin
    except Exception:
        logger.warning("semantic_classify_failed", exc_info=True)
        return False, 0.0
