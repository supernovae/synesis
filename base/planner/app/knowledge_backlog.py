"""Knowledge backlog — logs RAG retrieval gaps for Safety-II and knowledge base improvement.

When Context Curator finds max RAG score < threshold, publishes the query to Milvus
so admins can discover "what we don't know" and prioritize SOP authoring.
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import httpx
from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from .config import settings
from .url_utils import ensure_url_protocol

logger = logging.getLogger("synesis.knowledge_backlog")

COLLECTION = "synesis_knowledge_backlog"
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
            logger.debug(f"Load of '{COLLECTION}' deferred: {e}")
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
    logger.info(f"Created Milvus collection '{COLLECTION}'")
    try:
        client.load_collection(collection_name=COLLECTION)
    except Exception as e:
        logger.debug(f"Initial load of '{COLLECTION}' deferred: {e}")
    _initialized = True


def _embed(text: str) -> list[float] | None:
    """Embed text via the shared embedder service."""
    if not settings.embedder_url or not str(settings.embedder_url).strip():
        return None
    base = ensure_url_protocol(settings.embedder_url)
    if not base.startswith(("http://", "https://")):
        return None
    try:
        resp = httpx.post(
            f"{base.rstrip('/')}/embeddings",
            json={"input": [text], "model": settings.embedder_model},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]
    except Exception:
        return None


async def publish_knowledge_gap(
    query: str,
    task_description: str = "",
    collections_queried: list[str] | None = None,
    max_score: float = 0.0,
    platform_context: str = "generic",
    target_language: str = "python",
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
        logger.info(
            "knowledge_backlog_published",
            extra={"chunk_id": chunk_id[:12], "platform_context": platform_context, "max_score": max_score},
        )
        return chunk_id

    except Exception as e:
        logger.warning(f"Failed to publish knowledge gap: {e}")
        return None
