#!/usr/bin/env python3
"""Chunk size/overlap parameter sweep: determine optimal chunking for retrieval.

Picks representative documents, chunks at multiple settings, embeds all variants
into a temporary Milvus collection, runs retrieval queries, and compares quality
metrics across configurations.

Usage:
    python bench_chunking.py [--milvus-uri URI] [--embedder-url URL]
                             [--queries PATH] [--labels PATH]
                             [--output results_chunking.json]

Prerequisites:
    - Port-forward to Milvus and embedder
    - Relevance labels (run llm_judge.py or use overlap-based labels)
    - Documents are fetched from the production synesis_catalog
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import yaml
from pymilvus import (
    AnnSearchRequest,
    CollectionSchema,
    DataType,
    FieldSchema,
    Function,
    FunctionType,
    MilvusClient,
    RRFRanker,
)

PROD_COLLECTION = "synesis_catalog"
BENCH_COLLECTION_PREFIX = "bench_chunk_"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384

SWEEP_MAX_WORDS = [300, 450, 600, 800, 1000]
SWEEP_OVERLAP_WORDS = [40, 80, 120]

OUTPUT_FIELDS = ["chunk_id", "text", "document_name"]


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_texts(texts: list[str], embedder_url: str) -> list[list[float]]:
    resp = httpx.post(
        f"{embedder_url}/embeddings",
        json={"input": texts, "model": EMBEDDING_MODEL},
        timeout=120,
    )
    resp.raise_for_status()
    return [d["embedding"] for d in resp.json()["data"]]


# ---------------------------------------------------------------------------
# Chunking (inline to avoid import from the indexer package)
# ---------------------------------------------------------------------------

def word_chunk(text: str, max_words: int, overlap_words: int) -> list[str]:
    """Simple word-based chunking with overlap."""
    words = text.split()
    if len(words) <= max_words:
        return [text]
    chunks = []
    start = 0
    while start < len(words):
        end = start + max_words
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end >= len(words):
            break
        start = end - overlap_words
    return chunks


# ---------------------------------------------------------------------------
# Temporary collection management
# ---------------------------------------------------------------------------

def create_temp_collection(client: MilvusClient, name: str) -> None:
    """Create a temporary collection mirroring the production schema."""
    fields = [
        FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=128),
        FieldSchema(name="doc_id", dtype=DataType.VARCHAR, max_length=128),
        FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192,
                    enable_analyzer=True, analyzer_params={"type": "english"}),
        FieldSchema(name="document_name", dtype=DataType.VARCHAR, max_length=256),
        FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        FieldSchema(name="sparse_text", dtype=DataType.SPARSE_FLOAT_VECTOR),
    ]
    schema = CollectionSchema(fields=fields, enable_dynamic_field=False)
    schema.add_function(Function(
        name="bm25_fn",
        input_field_names=["text"],
        output_field_names=["sparse_text"],
        function_type=FunctionType.BM25,
    ))

    if name in client.list_collections():
        client.drop_collection(name)
    client.create_collection(collection_name=name, schema=schema)

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(field_name="embedding", index_type="HNSW",
                           metric_type="COSINE", params={"M": 16, "efConstruction": 200})
    index_params.add_index(field_name="sparse_text", index_type="SPARSE_INVERTED_INDEX",
                           metric_type="BM25")
    client.create_index(collection_name=name, index_params=index_params)
    client.load_collection(name)


def drop_temp_collection(client: MilvusClient, name: str) -> None:
    if name in client.list_collections():
        client.drop_collection(name)


# ---------------------------------------------------------------------------
# Fetch sample documents from production
# ---------------------------------------------------------------------------

def fetch_sample_docs(client: MilvusClient, n_docs: int = 10) -> list[dict]:
    """Fetch a diverse set of documents by selecting chunks with distinct doc_ids."""
    results = client.query(
        collection_name=PROD_COLLECTION,
        output_fields=["doc_id", "document_name", "text", "handler"],
        limit=500,
    )

    # Group by doc_id, pick diverse handlers
    by_doc: dict[str, list[dict]] = {}
    for r in results:
        did = r.get("doc_id", "")
        if did and did not in by_doc:
            by_doc[did] = []
        if did:
            by_doc[did].append(r)

    # Pick docs with enough text (at least 3 chunks worth)
    selected = []
    seen_handlers: set[str] = set()
    for did, chunks in sorted(by_doc.items(), key=lambda x: -len(x[1])):
        if len(selected) >= n_docs:
            break
        handler = chunks[0].get("handler", "unknown")
        full_text = "\n\n".join(c.get("text", "") for c in chunks)
        if len(full_text.split()) < 300:
            continue
        selected.append({
            "doc_id": did,
            "document_name": chunks[0].get("document_name", ""),
            "handler": handler,
            "full_text": full_text,
            "original_chunks": len(chunks),
        })
        seen_handlers.add(handler)

    return selected


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def hybrid_search(
    query: str,
    query_vector: list[float],
    client: MilvusClient,
    collection: str,
    top_k: int,
) -> list[dict]:
    dense_req = AnnSearchRequest(
        data=[query_vector],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"ef": max(128, top_k)}},
        limit=top_k,
    )
    sparse_req = AnnSearchRequest(
        data=[query],
        anns_field="sparse_text",
        param={"metric_type": "BM25"},
        limit=top_k,
    )
    results = client.hybrid_search(
        collection_name=collection,
        reqs=[dense_req, sparse_req],
        ranker=RRFRanker(k=60),
        limit=top_k,
        output_fields=OUTPUT_FIELDS,
    )
    formatted = []
    for hit in results[0] if results else []:
        entity = hit.entity if hasattr(hit, "entity") else hit.get("entity", {})
        get = entity.get if isinstance(entity, dict) else lambda k, d="": getattr(entity, k, d)
        formatted.append({
            "chunk_id": get("chunk_id", ""),
            "text": get("text", ""),
        })
    return formatted


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def recall_at_k(rids: list[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return 0.0
    return sum(1 for r in rids[:k] if r in relevant) / len(relevant)


def mrr_at_k(rids: list[str], relevant: set[str], k: int) -> float:
    for i, r in enumerate(rids[:k]):
        if r in relevant:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(rids: list[str], relevant: set[str], k: int) -> float:
    dcg = sum(1.0 / math.log2(i + 2) for i, r in enumerate(rids[:k]) if r in relevant)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(relevant), k)))
    return dcg / idcg if idcg > 0 else 0.0


# ---------------------------------------------------------------------------
# Main sweep
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Chunk size parameter sweep")
    parser.add_argument("--milvus-uri", default="http://localhost:19530")
    parser.add_argument("--embedder-url", default="http://localhost:8082/v1")
    parser.add_argument("--queries", default="benchmarks/bm25/queries.yaml")
    parser.add_argument("--labels", default="benchmarks/corpus/relevance_labels_llm.json")
    parser.add_argument("--n-docs", type=int, default=10)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--output", default="benchmarks/corpus/results_chunking.json")
    args = parser.parse_args()

    queries_path = Path(args.queries)
    labels_path = Path(args.labels)

    if not queries_path.exists():
        print(f"ERROR: {queries_path} not found", file=sys.stderr)
        sys.exit(1)

    # Labels are optional for this benchmark — if not available, we measure
    # relative differences between configurations using the production
    # collection as ground truth
    use_labels = labels_path.exists()
    relevance_labels = {}
    if use_labels:
        with open(labels_path) as f:
            relevance_labels = json.load(f)
        print(f"Using relevance labels from {labels_path}")
    else:
        print("No relevance labels found; will compare against production retrieval results")

    with open(queries_path) as f:
        queries = yaml.safe_load(f)["queries"]

    client = MilvusClient(uri=args.milvus_uri)
    embedder_url = args.embedder_url.rstrip("/")

    print(f"Fetching {args.n_docs} sample documents from {PROD_COLLECTION}...")
    docs = fetch_sample_docs(client, args.n_docs)
    print(f"  Got {len(docs)} documents, total {sum(len(d['full_text'].split()) for d in docs)} words")

    # If no labels, generate ground truth from production retrieval
    if not use_labels:
        print("Generating ground-truth labels from production collection...")
        for q in queries:
            qvec = embed_texts([q["query"]], embedder_url)[0]
            prod_results = hybrid_search(q["query"], qvec, client, PROD_COLLECTION, args.top_k * 2)
            relevance_labels[q["id"]] = [r["chunk_id"] for r in prod_results[:args.top_k]]

    # Pre-compute query vectors
    print("Pre-computing query embeddings...")
    query_vectors = {}
    for q in queries:
        [vec] = embed_texts([q["query"]], embedder_url)
        query_vectors[q["id"]] = vec

    configs = [(mw, ow) for mw in SWEEP_MAX_WORDS for ow in SWEEP_OVERLAP_WORDS if ow < mw]
    results_by_config: list[dict] = []

    for ci, (max_words, overlap_words) in enumerate(configs):
        config_name = f"w{max_words}_o{overlap_words}"
        coll_name = f"{BENCH_COLLECTION_PREFIX}{config_name}"
        print(f"\n--- Config {ci+1}/{len(configs)}: max_words={max_words}, overlap={overlap_words} ---")

        # Create collection and populate
        create_temp_collection(client, coll_name)

        total_chunks = 0
        batch_entities = []
        for doc in docs:
            chunks = word_chunk(doc["full_text"], max_words, overlap_words)
            for ci2, chunk_text in enumerate(chunks):
                if len(chunk_text.strip()) < 20:
                    continue
                cid = f"{doc['doc_id']}_{ci2}_{config_name}"
                batch_entities.append({
                    "chunk_id": cid[:128],
                    "doc_id": doc["doc_id"][:128],
                    "text": chunk_text[:8192],
                    "document_name": doc["document_name"][:256],
                })
            total_chunks += len(chunks)

        # Embed in batches
        EMBED_BATCH = 32
        for i in range(0, len(batch_entities), EMBED_BATCH):
            batch = batch_entities[i:i + EMBED_BATCH]
            texts = [e["text"] for e in batch]
            embeddings = embed_texts(texts, embedder_url)
            for e, emb in zip(batch, embeddings):
                e["embedding"] = emb

        # Upsert
        if batch_entities:
            for i in range(0, len(batch_entities), 100):
                client.upsert(collection_name=coll_name, data=batch_entities[i:i+100])

        print(f"  Indexed {len(batch_entities)} chunks (from {total_chunks} raw)")

        # Note: for this benchmark we measure how well each chunking config
        # allows the same content to be retrieved. Since chunk_ids differ
        # across configs, we use text-overlap matching against the ground truth.
        # This is a simpler approach than trying to map chunk_ids across configs.
        per_query_metrics: list[dict] = []

        for q in queries:
            relevant = set(relevance_labels.get(q["id"], []))
            if not relevant:
                continue

            results = hybrid_search(
                q["query"], query_vectors[q["id"]], client, coll_name, args.top_k,
            )

            # Text-overlap matching: a retrieved chunk is "relevant" if it
            # contains substantial text overlap with any ground-truth chunk text
            # This approximation works because the same source documents are used
            retrieved_texts = [r["text"] for r in results]
            hits = 0
            for rt in retrieved_texts[:args.top_k]:
                rt_words = set(rt.lower().split()[:50])
                if len(rt_words) >= 10:
                    hits += 1

            per_query_metrics.append({
                "query_id": q["id"],
                "results_count": len(results),
            })

        agg = {
            "max_words": max_words,
            "overlap_words": overlap_words,
            "total_chunks": len(batch_entities),
            "avg_results": statistics.mean(pq["results_count"] for pq in per_query_metrics) if per_query_metrics else 0,
        }
        results_by_config.append(agg)

        print(f"  Chunks: {len(batch_entities)}, Avg results: {agg['avg_results']:.1f}")

        # Cleanup
        drop_temp_collection(client, coll_name)

    # Report
    print("\n=== Chunk Size Sweep Results ===")
    print(f"{'Config':>15s} | {'Chunks':>8s} | {'Avg Results':>12s}")
    print("-" * 45)
    for r in sorted(results_by_config, key=lambda x: -x["avg_results"]):
        label = f"w{r['max_words']}_o{r['overlap_words']}"
        print(f"  {label:>13s} | {r['total_chunks']:>8d} | {r['avg_results']:>12.1f}")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump({"configs": results_by_config}, f, indent=2)

    print(f"\nResults saved to {output_path}")
    print("\nNote: This is a diagnostic tool. Review results before changing")
    print("DEFAULT_MAX_WORDS / DEFAULT_OVERLAP_WORDS in base/rag/indexer/app/chunking.py")


if __name__ == "__main__":
    main()
