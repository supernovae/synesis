"""TEI embedding client shared across Synesis services.

Provides sync and async variants with persistent connection pooling,
batch splitting, and optional L2 normalization.

Requires httpx and numpy — both provided by the base-api image.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import httpx
import numpy as np

if TYPE_CHECKING:
    pass

logger = logging.getLogger("synesis.embed_client")

DEFAULT_BATCH_SIZE = 32
DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def _normalize(arr: np.ndarray) -> np.ndarray:
    """L2-normalize rows in-place, treating zero-norm rows as unit."""
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


class EmbedClient:
    """Synchronous embedding client with persistent connection pooling."""

    def __init__(
        self,
        url: str,
        model: str = DEFAULT_MODEL,
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
        timeout: float = 60,
    ):
        self.url = url.rstrip("/")
        self.model = model
        self.batch_size = batch_size
        self._client = httpx.Client(timeout=timeout)

    # -- numpy interface (planner, keyword-service) --

    def embed(self, texts: list[str], *, normalize: bool = True) -> np.ndarray:
        """Embed texts in batches. Returns (N, D) float32 array."""
        if not texts:
            return np.empty((0, 0), dtype=np.float32)

        all_vecs: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            resp = self._client.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
            )
            resp.raise_for_status()
            all_vecs.extend(item["embedding"] for item in resp.json()["data"])

        arr = np.array(all_vecs, dtype=np.float32)
        return _normalize(arr) if normalize else arr

    # -- list interface (indexer) --

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed texts in batches. Returns raw list-of-lists (no normalization)."""
        if not texts:
            return []

        all_embeddings: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            resp = self._client.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
            )
            resp.raise_for_status()
            all_embeddings.extend(item["embedding"] for item in resp.json()["data"])
        return all_embeddings

    def close(self) -> None:
        self._client.close()


class AsyncEmbedClient:
    """Non-blocking embedding client using httpx.AsyncClient.

    Drop-in replacement for EmbedClient in async contexts — eliminates
    the ~50-100ms per-call overhead of asyncio.to_thread() wrappers.
    """

    def __init__(
        self,
        url: str,
        model: str = DEFAULT_MODEL,
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
        timeout: float = 60,
    ):
        self.url = url.rstrip("/")
        self.model = model
        self.batch_size = batch_size
        self._client = httpx.AsyncClient(timeout=timeout)

    async def embed(self, texts: list[str], *, normalize: bool = True) -> np.ndarray:
        """Embed texts in batches. Returns (N, D) float32 array."""
        if not texts:
            return np.empty((0, 0), dtype=np.float32)

        all_vecs: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            resp = await self._client.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
            )
            resp.raise_for_status()
            all_vecs.extend(item["embedding"] for item in resp.json()["data"])

        arr = np.array(all_vecs, dtype=np.float32)
        return _normalize(arr) if normalize else arr

    async def aclose(self) -> None:
        await self._client.aclose()
