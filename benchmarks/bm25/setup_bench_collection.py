#!/usr/bin/env python3
"""Create the BM25 benchmark collection and populate it from synesis_catalog.

This script:
1. Creates synesis_catalog_bm25bench with the original dense vector field PLUS
   a native BM25 Function on a new `bm25_text` field (enriched) and the
   original `text` field (raw).
2. Copies all entities from synesis_catalog, computing the `bm25_text`
   enriched field (same concatenation as the custom BM25 service).

Usage:
    python setup_bench_collection.py [--milvus-uri URI] [--drop]
"""

from __future__ import annotations

import argparse
import sys
import time

from pymilvus import (
    CollectionSchema,
    DataType,
    FieldSchema,
    Function,
    FunctionType,
    MilvusClient,
)

BENCH_COLLECTION = "synesis_catalog_bm25bench"
SOURCE_COLLECTION = "synesis_catalog"
EMBEDDING_DIM = 384

SOURCE_OUTPUT_FIELDS = [
    "chunk_id",
    "doc_id",
    "chunk_index",
    "text",
    "context_prefix",
    "chunk_summary",
    "heading_path",
    "section",
    "document_name",
    "source_type",
    "handler",
    "domain",
    "tags",
    "keywords",
    "origin_type",
    "authority",
    "source_url",
    "embedding",
]


def enriched_text(row: dict) -> str:
    """Replicate the custom BM25 service enrichment concatenation."""
    parts = []
    for field in ("heading_path", "chunk_summary", "document_name", "keywords", "tags"):
        val = row.get(field, "")
        if val:
            parts.append(val)
    parts.append(row.get("text", ""))
    return " ".join(parts)


def create_bench_collection(client: MilvusClient, drop: bool = False) -> None:
    if BENCH_COLLECTION in client.list_collections():
        if drop:
            print(f"Dropping existing {BENCH_COLLECTION}...")
            client.drop_collection(collection_name=BENCH_COLLECTION)
        else:
            print(f"{BENCH_COLLECTION} already exists. Use --drop to recreate.")
            return

    schema = CollectionSchema(
        fields=[
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
            FieldSchema(name="chunk_index", dtype=DataType.INT64),
            FieldSchema(
                name="text",
                dtype=DataType.VARCHAR,
                max_length=8192,
                enable_analyzer=True,
                analyzer_params={"type": "english"},
            ),
            FieldSchema(name="context_prefix", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="chunk_summary", dtype=DataType.VARCHAR, max_length=1024),
            FieldSchema(name="heading_path", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="section", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="source_type", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="handler", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="domain", dtype=DataType.VARCHAR, max_length=64),
            FieldSchema(name="tags", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="keywords", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="origin_type", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="authority", dtype=DataType.VARCHAR, max_length=32, is_partition_key=True),
            FieldSchema(name="source_url", dtype=DataType.VARCHAR, max_length=512),
            # Dense vector (same as production)
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
            # Enriched text for native BM25 Condition B2
            FieldSchema(
                name="bm25_text",
                dtype=DataType.VARCHAR,
                max_length=16384,
                enable_analyzer=True,
                analyzer_params={"type": "english"},
            ),
            # Sparse fields auto-populated by BM25 Functions
            FieldSchema(name="sparse_text", dtype=DataType.SPARSE_FLOAT_VECTOR),
            FieldSchema(name="sparse_bm25_text", dtype=DataType.SPARSE_FLOAT_VECTOR),
        ],
        description="BM25 benchmark collection — native BM25 vs custom",
        enable_dynamic_field=False,
    )

    # B1: BM25 on raw text field
    schema.add_function(
        Function(
            name="bm25_text_fn",
            input_field_names=["text"],
            output_field_names=["sparse_text"],
            function_type=FunctionType.BM25,
        )
    )

    # B2: BM25 on enriched bm25_text field
    schema.add_function(
        Function(
            name="bm25_enriched_fn",
            input_field_names=["bm25_text"],
            output_field_names=["sparse_bm25_text"],
            function_type=FunctionType.BM25,
        )
    )

    client.create_collection(collection_name=BENCH_COLLECTION, schema=schema)

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(
        field_name="embedding",
        index_type="HNSW",
        metric_type="COSINE",
        params={"M": 16, "efConstruction": 200},
    )
    index_params.add_index(
        field_name="sparse_text",
        index_type="SPARSE_INVERTED_INDEX",
        metric_type="BM25",
    )
    index_params.add_index(
        field_name="sparse_bm25_text",
        index_type="SPARSE_INVERTED_INDEX",
        metric_type="BM25",
    )
    client.create_index(collection_name=BENCH_COLLECTION, index_params=index_params)
    client.load_collection(collection_name=BENCH_COLLECTION)
    print(f"Created and loaded {BENCH_COLLECTION}")


def populate_from_source(client: MilvusClient) -> int:
    """Copy all entities from synesis_catalog into the benchmark collection."""
    if SOURCE_COLLECTION not in client.list_collections():
        print(f"Source collection {SOURCE_COLLECTION} not found!", file=sys.stderr)
        return 0

    total = 0
    batch_size = 200
    t0 = time.time()

    try:
        iterator = client.query_iterator(
            collection_name=SOURCE_COLLECTION,
            filter="",
            output_fields=SOURCE_OUTPUT_FIELDS,
            batch_size=batch_size,
        )
    except (AttributeError, Exception):
        print("query_iterator not available, falling back to offset pagination")
        iterator = None

    if iterator is not None:
        while True:
            batch = iterator.next()
            if not batch:
                break
            entities = []
            for row in batch:
                entity = {k: row.get(k, "") for k in SOURCE_OUTPUT_FIELDS}
                entity["bm25_text"] = enriched_text(row)[:16384]
                entities.append(entity)
            client.insert(collection_name=BENCH_COLLECTION, data=entities)
            total += len(entities)
            if total % 1000 == 0:
                print(f"  ... {total} entities copied")
        iterator.close()
    else:
        offset = 0
        while True:
            results = client.query(
                collection_name=SOURCE_COLLECTION,
                filter="",
                output_fields=SOURCE_OUTPUT_FIELDS,
                limit=batch_size,
                offset=offset,
            )
            if not results:
                break
            entities = []
            for row in results:
                entity = {k: row.get(k, "") for k in SOURCE_OUTPUT_FIELDS}
                entity["bm25_text"] = enriched_text(row)[:16384]
                entities.append(entity)
            client.insert(collection_name=BENCH_COLLECTION, data=entities)
            total += len(entities)
            if total % 1000 == 0:
                print(f"  ... {total} entities copied")
            if len(results) < batch_size:
                break
            offset += batch_size

    elapsed = time.time() - t0
    print(f"Copied {total} entities in {elapsed:.1f}s")
    return total


def main():
    parser = argparse.ArgumentParser(description="Set up BM25 benchmark collection")
    parser.add_argument("--milvus-uri", default="http://synesis-milvus.synesis-rag.svc.cluster.local:19530")
    parser.add_argument("--drop", action="store_true", help="Drop and recreate if exists")
    args = parser.parse_args()

    client = MilvusClient(uri=args.milvus_uri)
    create_bench_collection(client, drop=args.drop)

    desc = client.describe_collection(collection_name=BENCH_COLLECTION)
    field_names = [f["name"] for f in desc.get("fields", [])]
    print(f"Fields: {field_names}")

    count = populate_from_source(client)
    print(f"\nBenchmark collection ready: {BENCH_COLLECTION} ({count} entities)")
    print("You can now run: python bench_bm25.py")


if __name__ == "__main__":
    main()
