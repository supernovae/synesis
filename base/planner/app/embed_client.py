"""Lightweight synchronous embedding client for the TEI embedder service.

Used by semantic_intent, unified_retrieval, and query_distiller to replace
local sentence-transformers with HTTP calls to the shared TEI embedder.
"""

from __future__ import annotations

import logging

import httpx
import numpy as np

logger = logging.getLogger("synesis.embed_client")

_BATCH_SIZE = 32


class EmbedClient:
    """Embeds texts via the TEI embedder HTTP API, returns numpy arrays."""

    def __init__(self, url: str, model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.url = url.rstrip("/")
        self.model = model

    def embed(self, texts: list[str], normalize: bool = True) -> np.ndarray:
        """Embed texts in batches. Returns (N, D) float32 array."""
        if not texts:
            return np.empty((0, 0), dtype=np.float32)

        all_vecs: list[list[float]] = []
        for i in range(0, len(texts), _BATCH_SIZE):
            batch = texts[i : i + _BATCH_SIZE]
            resp = httpx.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            all_vecs.extend(item["embedding"] for item in data["data"])

        arr = np.array(all_vecs, dtype=np.float32)
        if normalize and arr.size > 0:
            norms = np.linalg.norm(arr, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            arr = arr / norms
        return arr


_client: EmbedClient | None = None


def get_embed_client() -> EmbedClient:
    """Return the singleton EmbedClient, lazily initialised from config."""
    global _client
    if _client is None:
        from .config import settings

        _client = EmbedClient(url=settings.embedder_url, model=settings.embedder_model)
        logger.info("embed_client_init", extra={"url": settings.embedder_url})
    return _client
