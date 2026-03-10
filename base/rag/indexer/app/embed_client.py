"""Batch embedding client using the Synesis embedder service (TEI)."""

from __future__ import annotations

import logging

import httpx

logger = logging.getLogger("synesis.indexer.embed")

EMBEDDER_URL = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"
EMBED_BATCH_SIZE = 32


class EmbedClient:
    """Batch embedding via the Synesis TEI embedder HTTP API."""

    def __init__(self, url: str = EMBEDDER_URL, model: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.url = url
        self.model = model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed a list of texts in batches. Returns one vector per input text."""
        if not texts:
            return []

        all_embeddings: list[list[float]] = []
        for i in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = texts[i : i + EMBED_BATCH_SIZE]
            resp = httpx.post(
                f"{self.url}/embeddings",
                json={"input": batch, "model": self.model},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            batch_embeddings = [item["embedding"] for item in data["data"]]
            all_embeddings.extend(batch_embeddings)

        return all_embeddings
