"""Fire-and-forget web search event logger — writes to admin Postgres.

Follows the same daemon-thread + lazy psycopg2 connection pattern as
synesis_tracer.py.  Calls never block the request pipeline; if Postgres
is unreachable the event is silently dropped (aggregate Prometheus
metrics remain correct).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger("synesis.web_search_log")

_MAX_SNIPPET_LEN = 500
_MAX_ROWS_PER_SEARCH = 20

_INSERT_SQL = """
INSERT INTO web_search_log
    (timestamp, run_id, query, source_id, profile, url, domain, title,
     snippet, score, latency_ms, outcome, engine)
VALUES
    (%(timestamp)s, %(run_id)s, %(query)s, %(source_id)s, %(profile)s,
     %(url)s, %(domain)s, %(title)s, %(snippet)s, %(score)s,
     %(latency_ms)s, %(outcome)s, %(engine)s)
"""


def _extract_domain(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


def _persist_rows(rows: list[dict[str, Any]]) -> None:
    from .pg_pool import pg_connection

    with pg_connection() as conn:
        if conn is None:
            return
        try:
            with conn.cursor() as cur:
                for row in rows:
                    cur.execute(_INSERT_SQL, row)
        except Exception:
            logger.debug("web_search_log_write_failed", exc_info=True)


def log_web_search_results(
    *,
    run_id: str,
    query: str,
    source_id: str,
    profile: str,
    results: list[Any],
    latency_ms: float,
    outcome: str,
) -> None:
    """Queue a batch INSERT of web search results in a daemon thread.

    ``results`` should be SearchResult-like objects with .title, .url,
    .snippet, .engine, .score attributes.  At most _MAX_ROWS_PER_SEARCH
    rows are written.
    """
    now = time.time()
    rows: list[dict[str, Any]] = []
    for r in results[:_MAX_ROWS_PER_SEARCH]:
        url = getattr(r, "url", "") or ""
        rows.append(
            {
                "timestamp": now,
                "run_id": run_id or "",
                "query": query[:500],
                "source_id": source_id or "",
                "profile": profile or "",
                "url": url,
                "domain": _extract_domain(url),
                "title": (getattr(r, "title", "") or "")[:500],
                "snippet": (getattr(r, "snippet", "") or "")[:_MAX_SNIPPET_LEN],
                "score": float(getattr(r, "score", 0.0) or 0.0),
                "latency_ms": round(latency_ms, 1),
                "outcome": outcome,
                "engine": (getattr(r, "engine", "") or "")[:64],
            }
        )

    if not rows:
        rows.append(
            {
                "timestamp": now,
                "run_id": run_id or "",
                "query": query[:500],
                "source_id": source_id or "",
                "profile": profile or "",
                "url": "",
                "domain": "",
                "title": "",
                "snippet": "",
                "score": 0.0,
                "latency_ms": round(latency_ms, 1),
                "outcome": outcome,
                "engine": "",
            }
        )

    threading.Thread(target=_persist_rows, args=(rows,), daemon=True).start()
