"""Knowledge backlog — logs RAG retrieval gaps for knowledge base improvement.

When Context Curator finds max RAG score < threshold, publishes the query to Milvus
so admins can discover "what we don't know" and prioritize SOP authoring.

Gap lifecycle statuses:
  - open (default): newly surfaced gap
  - resolved: admin marked as satisfied/addressed
  - reopened: was resolved but resurfaced
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Literal

from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from .config import settings

logger = logging.getLogger("synesis.knowledge_backlog")

COLLECTION = "synesis_knowledge_backlog"
STATUS_COLLECTION = "synesis_knowledge_gap_status"
EMBEDDING_DIM = 384

GapStatus = Literal["open", "resolved", "reopened"]

_client: MilvusClient | None = None
_initialized = False


def _get_client() -> MilvusClient:
    global _client
    if _client is None:
        uri = f"http://{settings.milvus_host}:{settings.milvus_port}"
        _client = MilvusClient(uri=uri)
    return _client


def _ensure_collection() -> None:
    global _initialized
    if _initialized:
        return

    client = _get_client()
    if COLLECTION in client.list_collections():
        try:
            client.load_collection(collection_name=COLLECTION)
        except Exception as e:
            logger.debug("collection_load_deferred", extra={"collection": COLLECTION, "error": str(e)[:200]})
        _initialized = True
        return

    schema = CollectionSchema(
        fields=[
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema(name="query", dtype=DataType.VARCHAR, max_length=1024),
            FieldSchema(name="task_description", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="collections_queried", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="max_score", dtype=DataType.FLOAT),
            FieldSchema(name="platform_context", dtype=DataType.VARCHAR, max_length=64),
            FieldSchema(name="timestamp", dtype=DataType.INT64),
            FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        ],
        description="Synesis knowledge gaps — queries with low RAG confidence",
    )

    client.create_collection(collection_name=COLLECTION, schema=schema)
    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(
        field_name="embedding",
        index_type="IVF_FLAT",
        metric_type="COSINE",
        params={"nlist": 128},
    )
    client.create_index(collection_name=COLLECTION, index_params=index_params)
    logger.info("milvus_collection_created", extra={"collection": COLLECTION})
    try:
        client.load_collection(collection_name=COLLECTION)
    except Exception as e:
        logger.debug("initial_collection_load_deferred", extra={"collection": COLLECTION, "error": str(e)[:200]})
    _initialized = True


def _embed(text: str) -> list[float] | None:
    """Embed text via the shared EmbedClient singleton."""
    try:
        from .embed_client import get_embed_client

        arr = get_embed_client().embed([text], normalize=True)
        if arr.size > 0:
            return arr[0].tolist()
        return None
    except Exception:
        return None


async def publish_knowledge_gap(
    query: str,
    task_description: str = "",
    collections_queried: list[str] | None = None,
    max_score: float = 0.0,
    platform_context: str = "generic",
    target_language: str = "python",
    web_search_fallback: bool = False,
) -> str | None:
    """Publish a knowledge gap to the backlog. Returns chunk_id or None on error."""
    try:
        _ensure_collection()

        coll_str = ",".join(collections_queried or [])[:256]
        task_desc = (task_description or query)[:512]
        raw = f"{query[:500]}:{task_desc}:{coll_str}:{time.time()}"
        chunk_id = hashlib.sha256(raw.encode()).hexdigest()[:64]

        embed_text = f"{query[:1024]}\n{task_desc}"
        embedding = _embed(embed_text)
        if embedding is None:
            return None

        entity = {
            "chunk_id": chunk_id,
            "query": (query or task_desc)[:1024],
            "task_description": task_desc,
            "collections_queried": coll_str,
            "max_score": max_score,
            "platform_context": (platform_context or "generic")[:64],
            "timestamp": int(time.time()),
            "language": (target_language or "python")[:32],
            "embedding": embedding,
        }

        client = _get_client()
        client.upsert(collection_name=COLLECTION, data=[entity])
        _persist_gap_pg(entity, web_search_fallback)
        logger.info(
            "knowledge_backlog_published",
            extra={"chunk_id": chunk_id[:12], "platform_context": platform_context, "max_score": max_score},
        )
        return chunk_id

    except Exception as e:
        logger.warning("publish_knowledge_gap_failed", extra={"error": str(e)[:200]})
        return None


def _persist_gap_pg(entity: dict, web_search_fallback: bool = False) -> None:
    """Write knowledge gap to admin Postgres (best-effort)."""
    import os

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return
    try:
        import psycopg2

        dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
        conn = psycopg2.connect(dsn)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO knowledge_gaps (gap_id, query, task_description, collections_queried, max_score, platform_context, language, status, web_search_fallback, timestamp)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 'open', %s, %s)
               ON CONFLICT (gap_id) DO NOTHING""",
            (
                entity["chunk_id"],
                entity.get("query", ""),
                entity.get("task_description", ""),
                entity.get("collections_queried", ""),
                entity.get("max_score", 0.0),
                entity.get("platform_context", "generic"),
                entity.get("language", ""),
                web_search_fallback,
                entity.get("timestamp", 0),
            ),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.debug("persist_gap_pg_failed", extra={"error": str(e)[:200]})


# ---------------------------------------------------------------------------
# Gap lifecycle — status tracking (companion to the main backlog collection)
# ---------------------------------------------------------------------------

_status_initialized = False


def _ensure_status_collection() -> None:
    global _status_initialized
    if _status_initialized:
        return

    client = _get_client()
    if STATUS_COLLECTION in client.list_collections():
        try:
            client.load_collection(collection_name=STATUS_COLLECTION)
        except Exception as e:
            logger.debug("status_collection_load_deferred", extra={"error": str(e)[:200]})
        _status_initialized = True
        return

    schema = CollectionSchema(
        fields=[
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema(name="status", dtype=DataType.VARCHAR, max_length=20),
            FieldSchema(name="resolved_at", dtype=DataType.INT64),
            FieldSchema(name="resolved_by", dtype=DataType.VARCHAR, max_length=128),
            FieldSchema(name="resolution_note", dtype=DataType.VARCHAR, max_length=1024),
            FieldSchema(name="updated_at", dtype=DataType.INT64),
        ],
        description="Synesis knowledge gap lifecycle status",
    )
    client.create_collection(collection_name=STATUS_COLLECTION, schema=schema)
    logger.info("milvus_collection_created", extra={"collection": STATUS_COLLECTION})
    try:
        client.load_collection(collection_name=STATUS_COLLECTION)
    except Exception as e:
        logger.debug("initial_status_load_deferred", extra={"error": str(e)[:200]})
    _status_initialized = True


def get_gap_status(chunk_id: str) -> dict | None:
    """Get the lifecycle status of a knowledge gap."""
    try:
        _ensure_status_collection()
        client = _get_client()
        results = client.query(
            collection_name=STATUS_COLLECTION,
            filter=f'chunk_id == "{chunk_id}"',
            output_fields=["chunk_id", "status", "resolved_at", "resolved_by", "resolution_note", "updated_at"],
            limit=1,
        )
        return results[0] if results else None
    except Exception:
        logger.warning("get_gap_status_failed", exc_info=True)
        return None


def update_gap_status(
    chunk_id: str,
    status: GapStatus,
    resolved_by: str = "",
    resolution_note: str = "",
) -> bool:
    """Update the lifecycle status of a knowledge gap."""
    try:
        _ensure_status_collection()
        client = _get_client()
        now = int(time.time())
        entity = {
            "chunk_id": chunk_id[:64],
            "status": status,
            "resolved_at": now if status == "resolved" else 0,
            "resolved_by": (resolved_by or "")[:128],
            "resolution_note": (resolution_note or "")[:1024],
            "updated_at": now,
        }
        client.upsert(collection_name=STATUS_COLLECTION, data=[entity])
        resolved_at = float(now) if status == "resolved" else 0.0
        _update_gap_status_pg(chunk_id, status, resolved_by, resolution_note, resolved_at)
        logger.info(
            "gap_status_updated",
            extra={"chunk_id": chunk_id[:12], "status": status, "by": resolved_by[:30]},
        )
        return True
    except Exception:
        logger.warning("update_gap_status_failed", exc_info=True)
        return False


def _update_gap_status_pg(
    chunk_id: str,
    status: GapStatus,
    resolved_by: str = "",
    resolution_note: str = "",
    resolved_at: float = 0.0,
) -> None:
    """Update knowledge gap status in Postgres (best-effort)."""
    import os

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return
    try:
        import psycopg2

        dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
        conn = psycopg2.connect(dsn)
        cur = conn.cursor()
        cur.execute(
            """UPDATE knowledge_gaps
               SET status = %s, resolved_at = %s, resolved_by = %s, resolution_note = %s, updated_at = NOW()
               WHERE gap_id = %s""",
            (status, resolved_at, (resolved_by or "")[:128], (resolution_note or "")[:8192], chunk_id[:64]),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.debug("update_gap_status_pg_failed", extra={"error": str(e)[:200]})


def _delete_gap_pg(chunk_id: str) -> None:
    """Delete knowledge gap from Postgres (best-effort)."""
    import os

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return
    try:
        import psycopg2

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute("DELETE FROM knowledge_gaps WHERE gap_id = %s", (chunk_id[:64],))
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.debug("delete_gap_pg_failed", extra={"error": str(e)[:200]})


def delete_gap(chunk_id: str) -> bool:
    """Purge a knowledge gap and its status record."""
    try:
        client = _get_client()
        _ensure_collection()
        client.delete(collection_name=COLLECTION, filter=f'chunk_id == "{chunk_id}"')
        _ensure_status_collection()
        client.delete(collection_name=STATUS_COLLECTION, filter=f'chunk_id == "{chunk_id}"')
        _delete_gap_pg(chunk_id)
        logger.info("gap_purged", extra={"chunk_id": chunk_id[:12]})
        return True
    except Exception:
        logger.warning("delete_gap_failed", exc_info=True)
        return False


def list_gap_statuses(chunk_ids: list[str]) -> dict[str, dict]:
    """Batch-fetch gap statuses for a list of chunk_ids."""
    if not chunk_ids:
        return {}
    try:
        _ensure_status_collection()
        client = _get_client()
        id_list = ",".join(f'"{cid[:64]}"' for cid in chunk_ids[:200])
        results = client.query(
            collection_name=STATUS_COLLECTION,
            filter=f"chunk_id in [{id_list}]",
            output_fields=["chunk_id", "status", "resolved_at", "resolved_by", "resolution_note", "updated_at"],
            limit=200,
        )
        return {r["chunk_id"]: r for r in results}
    except Exception:
        logger.warning("list_gap_statuses_failed", exc_info=True)
        return {}
