"""Keyword-service embedding client — delegates to synesis_telemetry.embed."""

from __future__ import annotations

import os

from synesis_telemetry.embed import EmbedClient

EMBEDDER_URL = os.getenv(
    "EMBEDDER_URL",
    "http://embedder.synesis-rag.svc.cluster.local:8080/v1",
)

__all__ = ["EMBEDDER_URL", "EmbedClient"]
