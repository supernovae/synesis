"""HTTP client for the Synesis TEI embedder service."""

from __future__ import annotations

import logging
import os

import httpx
import numpy as np

logger = logging.getLogger("keyword_service.embed")

EMBEDDER_URL = os.getenv(
    "EMBEDDER_URL",
    "http://embedder.synesis-rag.svc.cluster.local:8080/v1",
)
EMBED_BATCH_SIZE = 32


class EmbedClient:
    """Embeds texts via the TEI embedder HTTP API, returns numpy arrays."""

    def __init__(self, url: str = EMBEDDER_URL, model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.url = url.rstrip("/")
        self.model = model

    def embed(self, texts: list[str]) -> np.ndarray:
        """Embed texts in batches. Returns (N, D) float32 array, L2-normalised."""
        filtered = [t for t in texts if t and t.strip()]
        if not filtered:
            return np.empty((0, 0), dtype=np.float32)

        all_vecs: list[list[float]] = []
        for i in range(0, len(filtered), EMBED_BATCH_SIZE):
            batch = filtered[i : i + EMBED_BATCH_SIZE]
            resp = httpx.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            all_vecs.extend(item["embedding"] for item in data["data"])

        arr = np.array(all_vecs, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return arr / norms
