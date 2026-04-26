"""Indexer embedding client — delegates to synesis_telemetry.embed.

Re-exports EmbedClient with a service-specific default URL so callers
that construct ``EmbedClient()`` without arguments get the right endpoint.
"""

from __future__ import annotations

from synesis_telemetry.embed import EmbedClient as _SharedEmbedClient

EMBEDDER_URL = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"


class EmbedClient(_SharedEmbedClient):
    """Indexer-flavored embed client with default URL."""

    def __init__(self, url: str = EMBEDDER_URL, model: str = "BAAI/bge-m3", **kwargs):
        super().__init__(url=url, model=model, **kwargs)


__all__ = ["EMBEDDER_URL", "EmbedClient"]
