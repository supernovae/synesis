"""Failure vector store -- learns from past code execution failures.

Stores failed code + error output as embeddings in a dedicated Milvus
collection. The worker can query similar past failures before generating
code to avoid repeating known mistakes.

``record_error()`` is a lightweight Postgres-only helper used by the
planner to persist graph/retrieval/model errors without touching Milvus.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from typing import Any

from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from .config import settings

logger = logging.getLogger("synesis.failure_store")

# ---------------------------------------------------------------------------
# Lightweight Postgres-only error recording (no Milvus dependency)
# ---------------------------------------------------------------------------

_error_pg_conn = None
_error_pg_lock = threading.Lock()

_ERROR_INSERT_SQL = """\
INSERT INTO failures (failure_id, code, error_output, exit_code, error_type,
                      language, task_description, resolution, timestamp)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (failure_id) DO UPDATE SET
    error_output = EXCLUDED.error_output,
    task_description = EXCLUDED.task_description,
    timestamp = EXCLUDED.timestamp
"""


def _get_error_pg():
    """Lazy-init synchronous Postgres connection for error writes."""
    global _error_pg_conn
    if _error_pg_conn is not None:
        try:
            _error_pg_conn.cursor().execute("SELECT 1")
            return _error_pg_conn
        except Exception:
            _error_pg_conn = None

    db_url = os.environ.get("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return None
    try:
        import psycopg2

        dsn = db_url.replace("postgresql+asyncpg://", "postgresql://")
        _error_pg_conn = psycopg2.connect(dsn)
        _error_pg_conn.autocommit = True
        return _error_pg_conn
    except Exception:
        logger.debug("record_error_pg_connect_failed", exc_info=True)
        return None


def _persist_error(
    error_type: str,
    error_output: str,
    task_description: str = "",
    code: str = "",
    language: str = "",
    exit_code: int = 1,
    trace_id: str = "",
) -> None:
    """Write error to admin Postgres failures table (synchronous, best-effort)."""
    with _error_pg_lock:
        conn = _get_error_pg()
        if conn is None:
            return
        try:
            desc_for_hash = task_description or error_type
            fid = _failure_id(code or desc_for_hash, error_output)
            if trace_id:
                fid = f"{fid[:48]}_{trace_id[:15]}"
            with conn.cursor() as cur:
                cur.execute(
                    _ERROR_INSERT_SQL,
                    (
                        fid[:64],
                        code[:8192],
                        error_output[:4096],
                        exit_code,
                        error_type[:128],
                        language[:32],
                        task_description[:2048],
                        "",
                        int(time.time()),
                    ),
                )
        except Exception:
            logger.debug("persist_error_pg_failed", exc_info=True)


def record_error(
    error_type: str,
    error_output: str,
    task_description: str = "",
    code: str = "",
    language: str = "",
    exit_code: int = 1,
    trace_id: str = "",
) -> None:
    """Record an operational error to Postgres (non-blocking, daemon thread).

    Unlike ``store_failure()``, this does NOT require Milvus and is suitable
    for graph crashes, retrieval timeouts, model failures, and critic errors.
    """
    threading.Thread(
        target=_persist_error,
        args=(error_type, error_output, task_description, code, language, exit_code, trace_id),
        daemon=True,
    ).start()

COLLECTION = "failures_v1"
EMBEDDING_DIM = 384

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
            FieldSchema(name="failure_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema(name="code", dtype=DataType.VARCHAR, max_length=8192),
            FieldSchema(name="error_output", dtype=DataType.VARCHAR, max_length=4096),
            FieldSchema(name="exit_code", dtype=DataType.INT64),
            FieldSchema(name="error_type", dtype=DataType.VARCHAR, max_length=128),
            FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="task_description", dtype=DataType.VARCHAR, max_length=2048),
            FieldSchema(name="resolution", dtype=DataType.VARCHAR, max_length=8192),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
            FieldSchema(name="timestamp", dtype=DataType.INT64),
        ],
        description="Synesis failure knowledge base",
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


def _failure_id(code: str, error_output: str) -> str:
    raw = f"{code[:2048]}:{error_output[:1024]}"
    return hashlib.sha256(raw.encode()).hexdigest()[:64]


def compute_failure_id(code: str, execution_result: dict[str, Any]) -> str:
    """Compute failure_id for deduplication. Matches store_failure logic."""
    error_output = ""
    if isinstance(execution_result.get("lint"), dict):
        lint_out = execution_result["lint"].get("output", "")
        if lint_out and not execution_result["lint"].get("passed", True):
            error_output += f"LINT: {lint_out}\n"
    if isinstance(execution_result.get("security"), dict):
        sec_out = execution_result["security"].get("output", "")
        if sec_out and not execution_result["security"].get("passed", True):
            error_output += f"SECURITY: {json.dumps(sec_out)[:1024]}\n"
    if isinstance(execution_result.get("execution"), dict):
        exec_out = execution_result["execution"].get("output", "")
        if exec_out:
            error_output += f"RUNTIME: {exec_out}\n"
    return _failure_id(code, error_output)


def _classify_error(execution_result: dict[str, Any]) -> str:
    """Classify the error type from structured sandbox output."""
    lint = execution_result.get("lint", {})
    security = execution_result.get("security", {})

    if isinstance(lint, dict) and not lint.get("passed", True):
        return "lint"
    if isinstance(security, dict) and not security.get("passed", True):
        return "security"
    if execution_result.get("exit_code", 0) == 124:
        return "timeout"
    return "runtime"


async def store_failure(
    code: str,
    execution_result_json: str,
    task_description: str,
    language: str,
    resolution: str = "",
) -> str | None:
    """Store a failure in the vector store. Returns failure_id or None on error."""
    try:
        _ensure_collection()

        result = json.loads(execution_result_json) if isinstance(execution_result_json, str) else execution_result_json
        error_output = ""
        if isinstance(result.get("lint"), dict):
            lint_out = result["lint"].get("output", "")
            if lint_out and not result["lint"].get("passed", True):
                error_output += f"LINT: {lint_out}\n"
        if isinstance(result.get("security"), dict):
            sec_out = result["security"].get("output", "")
            if sec_out and not result["security"].get("passed", True):
                error_output += f"SECURITY: {json.dumps(sec_out)[:1024]}\n"
        if isinstance(result.get("execution"), dict):
            exec_out = result["execution"].get("output", "")
            if exec_out:
                error_output += f"RUNTIME: {exec_out}\n"

        error_type = _classify_error(result)
        exit_code = result.get("exit_code", 1)
        fid = _failure_id(code, error_output)

        embed_text = f"{code[:2048]}\n\nERROR: {error_output[:1024]}"
        embedding = _embed(embed_text)
        if embedding is None:
            return None

        entity = {
            "failure_id": fid,
            "code": code[:8192],
            "error_output": error_output[:4096],
            "exit_code": exit_code,
            "error_type": error_type[:128],
            "language": language[:32],
            "task_description": task_description[:2048],
            "resolution": resolution[:8192],
            "embedding": embedding,
            "timestamp": int(time.time()),
        }

        client = _get_client()
        client.upsert(collection_name=COLLECTION, data=[entity])
        _persist_failure_pg(entity)
        logger.info("failure_stored", extra={"failure_id": fid, "error_type": error_type, "language": language})
        return fid

    except Exception as e:
        logger.warning("store_failure_failed", extra={"error": str(e)[:200]})
        return None


def _persist_failure_pg(entity: dict) -> None:
    """Write failure to admin Postgres (best-effort)."""
    import os

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return
    try:
        import psycopg2

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO failures (failure_id, code, error_output, exit_code, error_type, language, task_description, resolution, timestamp)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (failure_id) DO UPDATE SET resolution = EXCLUDED.resolution""",
            (
                entity["failure_id"],
                entity.get("code", "")[:8192],
                entity.get("error_output", "")[:4096],
                entity.get("exit_code", 1),
                entity.get("error_type", ""),
                entity.get("language", ""),
                entity.get("task_description", "")[:2048],
                entity.get("resolution", "")[:8192],
                entity.get("timestamp", 0),
            ),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.debug("persist_failure_pg_failed", extra={"error": str(e)[:200]})


def _update_resolution_pg(failure_id: str, resolution: str) -> None:
    """Update resolution in Postgres when Milvus doesn't have the entity."""
    import os

    db_url = os.getenv("SYNESIS_TRACE_DATABASE_URL", "")
    if not db_url:
        return
    try:
        import psycopg2

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute(
            "UPDATE failures SET resolution = %s WHERE failure_id = %s",
            (resolution[:8192], failure_id),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.debug("update_resolution_pg_failed", extra={"error": str(e)[:200]})


async def update_resolution(failure_id: str, resolution: str) -> None:
    """Update a failure entry with the code that eventually passed."""
    try:
        client = _get_client()
        results = client.get(collection_name=COLLECTION, ids=[failure_id])
        if results:
            entity = results[0]
            entity["resolution"] = resolution[:8192]
            client.upsert(collection_name=COLLECTION, data=[entity])
            _persist_failure_pg(entity)
            logger.info("resolution_updated", extra={"failure_id": failure_id})
        else:
            _update_resolution_pg(failure_id, resolution)
    except Exception as e:
        logger.warning("update_resolution_failed", extra={"error": str(e)[:200]})


async def query_similar_failures(
    code: str = "",
    task_description: str = "",
    language: str = "",
    top_k: int = 3,
) -> list[dict[str, Any]]:
    """Find similar past failures. Returns list of failure dicts."""
    try:
        _ensure_collection()
        query_text = f"{task_description[:512]}\n{code[:1024]}"
        embedding = _embed(query_text)
        if embedding is None:
            return []

        client = _get_client()

        filter_expr = ""
        if language:
            filter_expr = f'language == "{language}"'

        results = client.search(
            collection_name=COLLECTION,
            data=[embedding],
            limit=top_k,
            output_fields=[
                "failure_id",
                "code",
                "error_output",
                "exit_code",
                "error_type",
                "language",
                "task_description",
                "resolution",
            ],
            filter=filter_expr if filter_expr else None,
        )

        failures = []
        for hits in results:
            for hit in hits:
                entity = hit.get("entity", hit)
                failures.append(
                    {
                        "failure_id": entity.get("failure_id", ""),
                        "code": entity.get("code", ""),
                        "error_output": entity.get("error_output", ""),
                        "exit_code": entity.get("exit_code", 0),
                        "error_type": entity.get("error_type", ""),
                        "language": entity.get("language", ""),
                        "task_description": entity.get("task_description", ""),
                        "resolution": entity.get("resolution", ""),
                        "similarity": hit.get("distance", 0.0),
                    }
                )
        return failures

    except Exception as e:
        logger.warning("query_failures_failed", extra={"error": str(e)[:200]})
        return []


async def get_failure_stats() -> dict[str, Any]:
    """Get aggregate statistics for the admin dashboard."""
    try:
        _ensure_collection()
        client = _get_client()
        stats = client.get_collection_stats(collection_name=COLLECTION)
        row_count = stats.get("row_count", 0)

        all_failures = client.query(
            collection_name=COLLECTION,
            filter="",
            output_fields=["error_type", "language", "resolution", "timestamp"],
            limit=10000,
        )

        by_language: dict[str, int] = {}
        by_error_type: dict[str, int] = {}
        resolved_count = 0

        for f in all_failures:
            lang = f.get("language", "unknown")
            etype = f.get("error_type", "unknown")
            by_language[lang] = by_language.get(lang, 0) + 1
            by_error_type[etype] = by_error_type.get(etype, 0) + 1
            if f.get("resolution"):
                resolved_count += 1

        return {
            "total_failures": row_count,
            "resolved": resolved_count,
            "unresolved": row_count - resolved_count,
            "by_language": by_language,
            "by_error_type": by_error_type,
        }

    except Exception as e:
        logger.warning("get_failure_stats_failed", extra={"error": str(e)[:200]})
        return {"total_failures": 0, "error": str(e)}


async def get_failures_paginated(
    offset: int = 0,
    limit: int = 20,
    language: str = "",
    error_type: str = "",
) -> list[dict[str, Any]]:
    """Get paginated list of failures for the admin service."""
    try:
        _ensure_collection()
        client = _get_client()

        filter_parts = []
        if language:
            filter_parts.append(f'language == "{language}"')
        if error_type:
            filter_parts.append(f'error_type == "{error_type}"')
        filter_expr = " and ".join(filter_parts) if filter_parts else ""

        results = client.query(
            collection_name=COLLECTION,
            filter=filter_expr if filter_expr else "",
            output_fields=[
                "failure_id",
                "code",
                "error_output",
                "exit_code",
                "error_type",
                "language",
                "task_description",
                "resolution",
                "timestamp",
            ],
            limit=limit,
            offset=offset,
        )

        return results

    except Exception as e:
        logger.warning("get_paginated_failures_failed", extra={"error": str(e)[:200]})
        return []
