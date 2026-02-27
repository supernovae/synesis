"""Failure vector store -- learns from past code execution failures.

Stores failed code + error output as embeddings in a dedicated Milvus
collection. The worker can query similar past failures before generating
code to avoid repeating known mistakes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

import httpx
from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from .config import settings

logger = logging.getLogger("synesis.failure_store")

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
    logger.info(f"Created Milvus collection '{COLLECTION}'")
    _initialized = True


def _embed(text: str) -> list[float]:
    """Embed text via the shared embedder service."""
    resp = httpx.post(
        f"{settings.embedder_url}/embeddings",
        json={"input": [text], "model": settings.embedder_model},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def _failure_id(code: str, error_output: str) -> str:
    raw = f"{code[:2048]}:{error_output[:1024]}"
    return hashlib.sha256(raw.encode()).hexdigest()[:64]


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
        logger.info(f"Stored failure {fid}: {error_type} ({language})")
        return fid

    except Exception as e:
        logger.warning(f"Failed to store failure: {e}")
        return None


async def update_resolution(failure_id: str, resolution: str) -> None:
    """Update a failure entry with the code that eventually passed."""
    try:
        client = _get_client()
        results = client.get(collection_name=COLLECTION, ids=[failure_id])
        if results:
            entity = results[0]
            entity["resolution"] = resolution[:8192]
            client.upsert(collection_name=COLLECTION, data=[entity])
            logger.info(f"Updated resolution for failure {failure_id}")
    except Exception as e:
        logger.warning(f"Failed to update resolution: {e}")


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
        logger.warning(f"Failed to query failures: {e}")
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
        logger.warning(f"Failed to get failure stats: {e}")
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
        logger.warning(f"Failed to get paginated failures: {e}")
        return []
