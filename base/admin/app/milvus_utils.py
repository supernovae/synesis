"""Shared Milvus client utilities for the admin service."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

logger = logging.getLogger("synesis.admin.milvus_utils")

_CONNECTION_DEAD_MARKERS = (
    "closed channel",
    "cannot invoke rpc",
    "connection reset",
    "connection refused",
    "rpc error",
    "unavailable",
    "connection reset by peer",
    "failed to connect to all addresses",
)


def is_connection_dead(exc: BaseException) -> bool:
    msg = (getattr(exc, "message", None) or str(exc)).lower()
    return any(marker in msg for marker in _CONNECTION_DEAD_MARKERS)


def _evict_alias(client: Any) -> None:
    try:
        from pymilvus.orm.connections import connections

        alias = getattr(client, "_using", None)
        if alias and connections.has_connection(alias):
            connections.remove_connection(alias)
            logger.debug("milvus_alias_evicted", extra={"alias": alias})
    except Exception:
        pass


class ResilientMilvusClient:
    """Thread-safe Milvus client wrapper with automatic reconnect."""

    def __init__(self, uri: str, timeout: float = 10.0):
        self._uri = uri
        self._timeout = timeout
        self._client: Any | None = None
        self._lock = threading.Lock()

    def _create(self) -> Any:
        from pymilvus import MilvusClient

        return MilvusClient(uri=self._uri, timeout=self._timeout)

    def get(self) -> Any:
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is None:
                self._client = self._create()
            return self._client

    def invalidate(self) -> None:
        with self._lock:
            old = self._client
            self._client = None
        if old is not None:
            _evict_alias(old)

    def reconnect_if_dead(self, exc: BaseException) -> Any | None:
        if not is_connection_dead(exc):
            return None
        logger.warning("milvus_reconnect", extra={"error": str(exc)[:120], "uri": self._uri})
        self.invalidate()
        try:
            return self.get()
        except Exception as reconnect_exc:
            logger.error("milvus_reconnect_failed", extra={"error": str(reconnect_exc)[:120]})
            return None


def with_retry[T](
    resilient: ResilientMilvusClient,
    fn: Callable[..., T],
    *args: Any,
    **kwargs: Any,
) -> T:
    """Execute *fn(client, *args, **kwargs)* with one retry on dead channel."""
    client = resilient.get()
    try:
        return fn(client, *args, **kwargs)
    except Exception as exc:
        new_client = resilient.reconnect_if_dead(exc)
        if new_client is None:
            raise
        return fn(new_client, *args, **kwargs)
