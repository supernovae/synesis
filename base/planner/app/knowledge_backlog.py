"""Knowledge backlog — logs RAG retrieval gaps to Postgres for admin review.

When Context Curator finds max RAG score < threshold, publishes the query so
admins can discover "what we don't know" and prioritize SOP authoring.

Gap lifecycle statuses (managed in admin DB):
  - open (default): newly surfaced gap
  - resolved: admin marked as satisfied/addressed
  - reopened: was resolved but resurfaced
"""

from __future__ import annotations

import hashlib
import logging
import time

logger = logging.getLogger("synesis.knowledge_backlog")

async def publish_knowledge_gap(
    query: str,
    task_description: str = "",
    collections_queried: list[str] | None = None,
    max_score: float = 0.0,
    platform_context: str = "generic",
    target_language: str = "python",
    web_search_fallback: bool = False,
) -> str | None:
    """Publish a knowledge gap to the admin Postgres DB.

    Returns gap_id (chunk_id) or None on error.
    Respects ``settings.knowledge_backlog_enabled``; no-op when disabled.
    """
    from .config import settings
    from .pg_pool import pg_connection

    if not settings.knowledge_backlog_enabled:
        return None

    try:
        coll_str = ",".join(collections_queried or [])[:256]
        task_desc = (task_description or query)[:2048]
        raw = f"{query[:500]}:{task_desc[:500]}:{coll_str}:{time.time()}"
        chunk_id = hashlib.sha256(raw.encode()).hexdigest()[:64]

        with pg_connection() as conn:
            if conn is None:
                logger.warning("publish_knowledge_gap_skipped — no DB connection")
                return None

            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO knowledge_gaps
                           (gap_id, query, task_description, collections_queried,
                            max_score, platform_context, language, status,
                            resolved_at, resolved_by, resolution_note,
                            web_search_fallback, timestamp)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, 'open', %s, %s, %s, %s, %s)
                       ON CONFLICT (gap_id) DO NOTHING""",
                    (
                        chunk_id,
                        (query or task_desc)[:4096],
                        task_desc,
                        coll_str,
                        max_score,
                        (platform_context or "generic")[:64],
                        (target_language or "python")[:32],
                        0,
                        "",
                        "",
                        web_search_fallback,
                        int(time.time()),
                    ),
                )

        logger.info(
            "knowledge_backlog_published",
            extra={
                "chunk_id": chunk_id[:12],
                "platform_context": platform_context,
                "max_score": max_score,
            },
        )
        return chunk_id

    except Exception as e:
        logger.warning("publish_knowledge_gap_failed", extra={"error": str(e)[:200]})
        return None
