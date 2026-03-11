"""Embedding clients for the TEI embedder service.

Provides both synchronous (EmbedClient) and asynchronous (AsyncEmbedClient)
implementations.  Prefer the async variant in async contexts to avoid
blocking the event loop or incurring asyncio.to_thread() overhead.
"""

from __future__ import annotations

import logging

import httpx
import numpy as np

logger = logging.getLogger("synesis.embed_client")

_BATCH_SIZE = 32


def _normalize_vectors(arr: np.ndarray) -> np.ndarray:
    if arr.size > 0:
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        arr = arr / norms
    return arr


class EmbedClient:
    """Synchronous embedding client — used in contexts where async is unavailable."""

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
        return _normalize_vectors(arr) if normalize else arr


class AsyncEmbedClient:
    """Non-blocking embedding client using httpx.AsyncClient.

    Drop-in replacement for EmbedClient in async contexts.  Eliminates
    the ~50-100ms per-call overhead of asyncio.to_thread() wrappers.
    """

    def __init__(self, url: str, model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.url = url.rstrip("/")
        self.model = model
        self._client = httpx.AsyncClient(timeout=60)

    async def embed(self, texts: list[str], normalize: bool = True) -> np.ndarray:
        """Embed texts in batches. Returns (N, D) float32 array."""
        if not texts:
            return np.empty((0, 0), dtype=np.float32)

        all_vecs: list[list[float]] = []
        for i in range(0, len(texts), _BATCH_SIZE):
            batch = texts[i : i + _BATCH_SIZE]
            resp = await self._client.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
            )
            resp.raise_for_status()
            data = resp.json()
            all_vecs.extend(item["embedding"] for item in data["data"])

        arr = np.array(all_vecs, dtype=np.float32)
        return _normalize_vectors(arr) if normalize else arr

    async def aclose(self) -> None:
        await self._client.aclose()


# ---------------------------------------------------------------------------
# Singletons
# ---------------------------------------------------------------------------

_client: EmbedClient | None = None
_async_client: AsyncEmbedClient | None = None


def get_embed_client() -> EmbedClient:
    """Return the singleton synchronous EmbedClient."""
    global _client
    if _client is None:
        from .config import settings

        _client = EmbedClient(url=settings.embedder_url, model=settings.embedder_model)
        logger.info("embed_client_init", extra={"url": settings.embedder_url})
    return _client


def get_async_embed_client() -> AsyncEmbedClient:
    """Return the singleton async EmbedClient."""
    global _async_client
    if _async_client is None:
        from .config import settings

        _async_client = AsyncEmbedClient(url=settings.embedder_url, model=settings.embedder_model)
        logger.info("async_embed_client_init", extra={"url": settings.embedder_url})
    return _async_client
