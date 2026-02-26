"""Synesis RAG Ingestion Pipeline.

Reads a language pack manifest, fetches/loads documents, chunks them
using a section-aware strategy, embeds via the embedder service,
and upserts into Milvus.

Usage:
    python -m app.ingest --pack /data/language-packs/bash
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import sys
from pathlib import Path

import httpx
import yaml
from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from .chunker import chunk_document

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("synesis.ingest")

MILVUS_URI = "http://synesis-milvus.synesis-rag.svc.cluster.local:19530"
EMBEDDER_URL = "http://embedder.synesis-rag.svc.cluster.local:8080/v1"
EMBEDDING_DIM = 384  # all-MiniLM-L6-v2


def load_manifest(pack_path: Path) -> dict:
    manifest_file = pack_path / "manifest.yaml"
    if not manifest_file.exists():
        raise FileNotFoundError(f"No manifest.yaml in {pack_path}")
    with open(manifest_file) as f:
        return yaml.safe_load(f)


def load_sources(pack_path: Path) -> list[dict]:
    sources_file = pack_path / "sources.yaml"
    if not sources_file.exists():
        return []
    with open(sources_file) as f:
        data = yaml.safe_load(f)
    return data.get("sources", [])


def fetch_document(source: dict, pack_path: Path) -> str:
    """Fetch document content from URL or local file."""
    if "path" in source:
        doc_path = pack_path / source["path"]
        if doc_path.exists():
            return doc_path.read_text()
        logger.warning(f"Local file not found: {doc_path}")
        return ""

    if "url" in source:
        try:
            resp = httpx.get(source["url"], timeout=30, follow_redirects=True)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            logger.warning(f"Failed to fetch {source['url']}: {e}")
            return ""

    return ""


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Batch embed texts via the embedder service."""
    if not texts:
        return []

    all_embeddings = []
    batch_size = 32

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        resp = httpx.post(
            f"{EMBEDDER_URL}/embeddings",
            json={"input": batch, "model": "all-MiniLM-L6-v2"},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        batch_embeddings = [item["embedding"] for item in data["data"]]
        all_embeddings.extend(batch_embeddings)

    return all_embeddings


def ensure_collection(client: MilvusClient, collection_name: str):
    """Create the Milvus collection if it doesn't exist."""
    if collection_name in client.list_collections():
        logger.info(f"Collection '{collection_name}' already exists")
        return

    schema = CollectionSchema(
        fields=[
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
            FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="source_section", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="language", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        ],
        description=f"Synesis RAG collection for {collection_name}",
    )

    client.create_collection(
        collection_name=collection_name,
        schema=schema,
    )

    client.create_index(
        collection_name=collection_name,
        field_name="embedding",
        index_params={"index_type": "IVF_FLAT", "metric_type": "COSINE", "params": {"nlist": 128}},
    )

    logger.info(f"Created collection '{collection_name}'")


def run_ingestion(pack_path: Path):
    manifest = load_manifest(pack_path)
    collection_name = manifest["collection"]
    language = manifest["language"]
    chunk_size = manifest.get("chunk_size", 512)
    chunk_overlap = manifest.get("chunk_overlap", 64)

    logger.info(f"Ingesting language pack: {manifest['name']} v{manifest['version']}")
    logger.info(f"Collection: {collection_name}, Language: {language}")

    sources = load_sources(pack_path)
    if not sources:
        logger.error("No sources defined in sources.yaml")
        sys.exit(1)

    client = MilvusClient(uri=MILVUS_URI)
    ensure_collection(client, collection_name)

    total_chunks = 0

    for source in sources:
        source_name = source.get("name", source.get("url", source.get("path", "unknown")))
        logger.info(f"Processing source: {source_name}")

        content = fetch_document(source, pack_path)
        if not content:
            logger.warning(f"Skipping empty source: {source_name}")
            continue

        chunks = chunk_document(
            content,
            chunk_size=chunk_size,
            overlap=chunk_overlap,
            doc_type=source.get("type", "markdown"),
        )

        if not chunks:
            continue

        texts = [c["text"] for c in chunks]
        embeddings = embed_texts(texts)

        entities = []
        for chunk, embedding in zip(chunks, embeddings):
            chunk_id = hashlib.sha256(
                f"{source_name}:{chunk.get('section', '')}:{chunk['text'][:100]}".encode()
            ).hexdigest()[:64]

            entities.append(
                {
                    "chunk_id": chunk_id,
                    "text": chunk["text"][:8192],
                    "source": source_name[:512],
                    "source_section": chunk.get("section", "")[:256],
                    "language": language[:32],
                    "embedding": embedding,
                }
            )

        if entities:
            client.upsert(collection_name=collection_name, data=entities)
            total_chunks += len(entities)
            logger.info(f"  Upserted {len(entities)} chunks from {source_name}")

    logger.info(f"Ingestion complete: {total_chunks} total chunks in '{collection_name}'")


def main():
    parser = argparse.ArgumentParser(description="Synesis RAG Ingestion")
    parser.add_argument("--pack", required=True, help="Path to language pack directory")
    args = parser.parse_args()

    pack_path = Path(args.pack)
    if not pack_path.is_dir():
        logger.error(f"Language pack directory not found: {pack_path}")
        sys.exit(1)

    run_ingestion(pack_path)


if __name__ == "__main__":
    main()
