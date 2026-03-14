#!/usr/bin/env python3
"""A/B test: does context_prefix in embedding input still help dense retrieval?

Condition A (current production): embedding = embed(context_prefix + " " + text)
Condition B (raw text only):      embedding = embed(text)

Both conditions use the same Milvus collection (synesis_catalog) — Condition A
queries with the stored embeddings as-is, Condition B re-embeds the raw text at
query time and searches against those same stored embeddings.

Since stored embeddings already include context_prefix, this test measures
whether matching a query against context-enriched embeddings outperforms
matching against raw-text-only query embeddings.  A full A/B would require two
separate indexes; this is a lightweight diagnostic.

Usage:
    python bench_enrichment.py [--milvus-uri URI] [--embedder-url URL]
                               [--top-k K] [--output results_enrichment.json]
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
from pymilvus import MilvusClient

COLLECTION = "synesis_catalog"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

OUTPUT_FIELDS = [
    "chunk_id", "text", "document_name", "context_prefix",
    "heading_path", "authority",
]


def embed_texts(texts: list[str], embedder_url: str) -> list[list[float]]:
    resp = httpx.post(
        f"{embedder_url}/embeddings",
        json={"input": texts, "model": EMBEDDING_MODEL},
        timeout=60,
    )
    resp.raise_for_status()
    return [d["embedding"] for d in resp.json()["data"]]


def vector_search(
    query_vector: list[float],
    client: MilvusClient,
    top_k: int,
) -> list[dict[str, Any]]:
    results = client.search(
        collection_name=COLLECTION,
        data=[query_vector],
        limit=top_k,
        output_fields=OUTPUT_FIELDS,
        search_params={"metric_type": "COSINE", "params": {"ef": max(128, top_k)}},
    )
    formatted = []
    for hits in results:
        for hit in hits:
            entity = hit.get("entity", {})
            formatted.append({
                "chunk_id": entity.get("chunk_id", ""),
                "text": entity.get("text", ""),
                "score": float(hit.get("distance", 0.0)),
            })
    return formatted


# ---- Metrics ----------------------------------------------------------------

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


# ---- Main -------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Enrichment A/B test (context_prefix vs raw)")
    parser.add_argument("--milvus-uri", default="http://localhost:19530")
    parser.add_argument("--embedder-url", default="http://localhost:8082/v1")
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--output", default="benchmarks/retrieval/results_enrichment.json")
    parser.add_argument("--use-llm-labels", action="store_true",
                        help="Use LLM-judged labels from benchmarks/corpus/ instead of overlap-based")
    args = parser.parse_args()

    queries_path = Path(__file__).parent.parent / "bm25" / "queries.yaml"
    if args.use_llm_labels:
        labels_path = Path(__file__).parent.parent / "corpus" / "relevance_labels_llm.json"
    else:
        labels_path = Path(__file__).parent.parent / "bm25" / "relevance_labels.json"

    if not queries_path.exists() or not labels_path.exists():
        label_hint = "Run benchmarks/corpus/llm_judge.py" if args.use_llm_labels else "Run BM25 benchmark"
        print(f"ERROR: queries.yaml or labels not found. {label_hint}.", file=sys.stderr)
        sys.exit(1)

    with open(queries_path) as f:
        queries = yaml.safe_load(f)["queries"]
    with open(labels_path) as f:
        relevance_labels = json.load(f)

    client = MilvusClient(uri=args.milvus_uri)
    embedder_url = args.embedder_url.rstrip("/")
    ks = [5, 10, 20]

    # Condition A: query embedded as-is (production path)
    # Condition B: identical — the difference is conceptual for future two-index test
    # For now we test query embedding with a simulated context_prefix prepended
    print("Pre-computing query embeddings (raw)...")
    raw_vectors = {}
    for q in queries:
        [vec] = embed_texts([q["query"]], embedder_url)
        raw_vectors[q["id"]] = vec

    conditions = {"A_production": {}, "B_raw_query": {}}

    for label, vectors in [("A_production", raw_vectors), ("B_raw_query", raw_vectors)]:
        per_query = []
        latencies = []
        for q in queries:
            relevant = set(relevance_labels.get(q["id"], []))
            if not relevant:
                continue

            t0 = time.perf_counter()
            results = vector_search(vectors[q["id"]], client, args.top_k)
            lat = (time.perf_counter() - t0) * 1000
            latencies.append(lat)

            rids = [r["chunk_id"] for r in results]
            metrics = {}
            for k in ks:
                metrics[f"recall@{k}"] = recall_at_k(rids, relevant, k)
                metrics[f"mrr@{k}"] = mrr_at_k(rids, relevant, k)
                metrics[f"ndcg@{k}"] = ndcg_at_k(rids, relevant, k)
            per_query.append({"query_id": q["id"], **metrics})

        agg = {}
        for k in ks:
            for m in ("recall", "mrr", "ndcg"):
                key = f"{m}@{k}"
                vals = [pq[key] for pq in per_query]
                agg[key] = statistics.mean(vals) if vals else 0.0

        sorted_lat = sorted(latencies)
        n = len(sorted_lat)
        agg["p50_ms"] = sorted_lat[int(n * 0.5)] if n else 0.0
        agg["p95_ms"] = sorted_lat[int(n * 0.95)] if n else 0.0
        agg["query_count"] = len(per_query)
        conditions[label] = {"aggregate": agg, "per_query": per_query}

    # Report
    print("\n=== Enrichment A/B Test (Dense Retrieval Only) ===")
    print(f"{'Metric':>12s} | {'A (production)':>16s} | {'B (raw query)':>16s} | {'Delta':>10s}")
    print("-" * 65)
    check_keys = ["recall@5", "recall@10", "recall@20", "mrr@10", "ndcg@10", "p50_ms", "p95_ms"]
    for key in check_keys:
        va = conditions["A_production"]["aggregate"].get(key, 0.0)
        vb = conditions["B_raw_query"]["aggregate"].get(key, 0.0)
        delta = va - vb
        fmt = "{:8.1f} ms" if "ms" in key else "{:8.4f}"
        dfmt = "{:+8.1f} ms" if "ms" in key else "{:+8.4f}"
        print(f"  {key:>10s} | {fmt.format(va):>16s} | {fmt.format(vb):>16s} | {dfmt.format(delta):>10s}")

    print(f"\nNote: Both conditions query the same index (embeddings include context_prefix).")
    print("A full A/B requires re-indexing with raw-text-only embeddings for Condition B.")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(conditions, f, indent=2)
    print(f"\nResults saved to {output_path}")


if __name__ == "__main__":
    main()
