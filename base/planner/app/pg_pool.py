"""Shared Postgres connection pool for the planner process.

All planner subsystems (tracer, failure_store, knowledge_backlog,
web_search_log, pat_auth) share a single ThreadedConnectionPool
to keep total connection count bounded — critical when running
multiple planner replicas under HPA.

Usage::

    from .pg_pool import pg_connection

    with pg_connection() as conn:
        if conn is None:
            return  # DB not configured or pool exhausted
        with conn.cursor() as cur:
            cur.execute(...)
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Generator

logger = logging.getLogger("synesis.pg_pool")

_pool = None
_pool_lock = threading.Lock()

MAX_CONNECTIONS = 12


def _init_pool():
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is not None:
            return _pool
        db_url = os.environ.get("SYNESIS_TRACE_DATABASE_URL", "")
        if not db_url:
            return None
        try:
            from psycopg2.pool import ThreadedConnectionPool

            dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
            _pool = ThreadedConnectionPool(minconn=2, maxconn=MAX_CONNECTIONS, dsn=dsn)
            logger.info("shared_pg_pool_ready maxconn=%d", MAX_CONNECTIONS)
            return _pool
        except Exception:
            logger.warning("shared_pg_pool_init_failed", exc_info=True)
            return None


@contextmanager
def pg_connection(*, autocommit: bool = True) -> Generator:
    """Borrow a connection from the shared pool.

    Yields a psycopg2 connection or None if the pool is unavailable.
    The connection is returned to the pool on exit regardless of exceptions.
    """
    pool = _init_pool()
    if pool is None:
        yield None
        return

    conn = None
    try:
        conn = pool.getconn()
        conn.autocommit = autocommit
        yield conn
    except Exception:
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.rollback()
        raise
    finally:
        if conn is not None:
            with contextlib.suppress(Exception):
                pool.putconn(conn)


def pool_stats() -> dict:
    """Return pool metrics for health/debug endpoints."""
    if _pool is None:
        return {"status": "not_initialized"}
    try:
        used = len(_pool._used)
        free = len(_pool._pool)
        return {"max": MAX_CONNECTIONS, "used": used, "free": free}
    except Exception:
        return {"max": MAX_CONNECTIONS, "status": "unknown"}
