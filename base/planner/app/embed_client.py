"""Planner embedding client — thin wrapper with config-driven singletons.

The actual HTTP/batch/normalization logic lives in synesis_telemetry.embed;
this module adds lazy singleton access keyed to planner Settings.
"""

from __future__ import annotations

import logging

from synesis_telemetry.embed import AsyncEmbedClient, EmbedClient

logger = logging.getLogger("synesis.embed_client")

# Re-export for callers that import the classes from here
__all__ = [
    "AsyncEmbedClient",
    "EmbedClient",
    "get_async_embed_client",
    "get_embed_client",
]

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
