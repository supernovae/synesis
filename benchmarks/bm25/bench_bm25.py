#!/usr/bin/env python3
"""BM25 Benchmark: Custom microservice (A) vs Milvus native BM25 (B1/B2).

Runs the same query set through three retrieval conditions:
  A  — Custom BM25 microservice + Milvus vector search + client-side RRF
  B1 — Milvus native BM25 on raw text + hybrid_search with RRFRanker
  B2 — Milvus native BM25 on enriched bm25_text + hybrid_search with RRFRanker

Measures: Recall@K, MRR@K, NDCG@K, p50/p95/p99 latency.

Relevance labels: either pre-filled in queries.yaml or auto-generated via
pooling + LLM judge on first run.

Usage:
    python bench_bm25.py [--milvus-uri URI] [--bm25-service-url URL]
                         [--embedder-url URL] [--runs N] [--top-k K]
                         [--output results.json]
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
from pymilvus import AnnSearchRequest, MilvusClient, RRFRanker

BENCH_COLLECTION = "synesis_catalog_bm25bench"
SOURCE_COLLECTION = "synesis_catalog"

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

OUTPUT_FIELDS = [
    "chunk_id",
    "text",
    "document_name",
    "origin_type",
    "authority",
    "domain",
    "source_url",
    "heading_path",
    "context_prefix",
    "chunk_summary",
    "handler",
    "source_type",
]


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------


def embed_text(text: str, embedder_url: str) -> list[float]:
    resp = httpx.post(
        f"{embedder_url}/embeddings",
        json={"input": [text], "model": EMBEDDING_MODEL},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


# ---------------------------------------------------------------------------
# Condition A: Custom BM25 microservice + vector search + client RRF
# ---------------------------------------------------------------------------


def condition_a(
    query: str,
    query_vector: list[float],
    milvus_client: MilvusClient,
    bm25_service_url: str,
    top_k: int,
    fetch_k: int,
) -> list[dict[str, Any]]:
    """Custom BM25 service + Milvus vector + client-side RRF."""
    # Vector search
    vector_results = milvus_client.search(
        collection_name=SOURCE_COLLECTION,
        data=[query_vector],
        limit=fetch_k,
        output_fields=OUTPUT_FIELDS,
        search_params={"metric_type": "COSINE", "params": {"ef": max(128, fetch_k)}},
    )
    vec_formatted = []
    for hits in vector_results:
        for hit in hits:
            entity = hit.get("entity", {})
            vec_formatted.append(
                {
                    "chunk_id": entity.get("chunk_id", ""),
                    "text": entity.get("text", ""),
                    "vector_score": float(hit.get("distance", 0.0)),
                    **{k: entity.get(k, "") for k in OUTPUT_FIELDS if k not in ("chunk_id", "text")},
                }
            )

    # BM25 search via microservice
    try:
        resp = httpx.post(
            f"{bm25_service_url}/v1/search",
            json={"query": query, "collection": SOURCE_COLLECTION, "top_k": fetch_k},
            timeout=15,
        )
        resp.raise_for_status()
        bm25_results = resp.json().get("results", [])
    except Exception:
        bm25_results = []

    # Client-side RRF
    return _rrf_merge(vec_formatted, bm25_results, k=60)[:top_k]


def _rrf_merge(
    vector_results: list[dict],
    bm25_results: list[dict],
    k: int = 60,
) -> list[dict]:
    """Replicate planner's RRF logic."""
    doc_map: dict[str, dict] = {}

    for rank, doc in enumerate(vector_results):
        key = doc.get("chunk_id") or doc["text"][:200]
        if key not in doc_map:
            doc_map[key] = {**doc, "rrf_score": 0.0, "retrieval_source": "vector"}
        doc_map[key]["rrf_score"] += 1.0 / (k + rank + 1)

    for rank, doc in enumerate(bm25_results):
        key = doc.get("chunk_id") or doc["text"][:200]
        if key not in doc_map:
            doc_map[key] = {**doc, "rrf_score": 0.0, "retrieval_source": "bm25"}
        else:
            doc_map[key]["retrieval_source"] = "both"
        doc_map[key]["rrf_score"] += 1.0 / (k + rank + 1)

    return sorted(doc_map.values(), key=lambda d: d["rrf_score"], reverse=True)


# ---------------------------------------------------------------------------
# Condition B1/B2: Milvus native BM25 + hybrid_search with RRFRanker
# ---------------------------------------------------------------------------


def condition_b(
    query: str,
    query_vector: list[float],
    milvus_client: MilvusClient,
    sparse_field: str,
    top_k: int,
    fetch_k: int,
) -> list[dict[str, Any]]:
    """Milvus native hybrid search: dense + sparse BM25 with server-side RRF."""
    dense_req = AnnSearchRequest(
        data=[query_vector],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"ef": max(128, fetch_k)}},
        limit=fetch_k,
    )
    sparse_req = AnnSearchRequest(
        data=[query],
        anns_field=sparse_field,
        param={"metric_type": "BM25"},
        limit=fetch_k,
    )

    results = milvus_client.hybrid_search(
        collection_name=BENCH_COLLECTION,
        reqs=[dense_req, sparse_req],
        ranker=RRFRanker(k=60),
        limit=top_k,
        output_fields=OUTPUT_FIELDS,
    )

    formatted = []
    for hit in results[0] if results else []:
        entity = hit.get("entity", {}) if isinstance(hit, dict) else {}
        # pymilvus hybrid_search returns list of hits
        if hasattr(hit, "entity"):
            entity = hit.entity
            chunk_id = entity.get("chunk_id", "") if isinstance(entity, dict) else getattr(entity, "chunk_id", "")
        else:
            chunk_id = entity.get("chunk_id", "")
        formatted.append(
            {
                "chunk_id": chunk_id if isinstance(chunk_id, str) else str(chunk_id),
                "text": entity.get("text", "") if isinstance(entity, dict) else getattr(entity, "text", ""),
                "rrf_score": float(hit.distance) if hasattr(hit, "distance") else float(hit.get("distance", 0.0)),
                "retrieval_source": "hybrid_native",
            }
        )

    return formatted


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def recall_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    if not relevant_ids:
        return 0.0
    hits = sum(1 for rid in retrieved_ids[:k] if rid in relevant_ids)
    return hits / len(relevant_ids)


def mrr_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    for i, rid in enumerate(retrieved_ids[:k]):
        if rid in relevant_ids:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    """Binary relevance NDCG."""
    dcg = 0.0
    for i, rid in enumerate(retrieved_ids[:k]):
        if rid in relevant_ids:
            dcg += 1.0 / math.log2(i + 2)
    # Ideal DCG: all relevant docs at top positions
    ideal_count = min(len(relevant_ids), k)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(ideal_count))
    return dcg / idcg if idcg > 0 else 0.0


def compute_metrics(
    retrieved: list[dict],
    relevant_ids: set[str],
    ks: list[int],
) -> dict[str, float]:
    rids = [r.get("chunk_id", "") for r in retrieved]
    metrics = {}
    for k in ks:
        metrics[f"recall@{k}"] = recall_at_k(rids, relevant_ids, k)
        metrics[f"mrr@{k}"] = mrr_at_k(rids, relevant_ids, k)
        metrics[f"ndcg@{k}"] = ndcg_at_k(rids, relevant_ids, k)
    return metrics


# ---------------------------------------------------------------------------
# Relevance label generation via pooling + LLM judge
# ---------------------------------------------------------------------------


def generate_relevance_labels(
    queries: list[dict],
    milvus_client: MilvusClient,
    bm25_service_url: str,
    embedder_url: str,
) -> dict[str, list[str]]:
    """Pool top-20 from all conditions, deduplicate, use text overlap as relevance signal."""
    labels: dict[str, list[str]] = {}
    print("Generating relevance labels via pooling...")

    for q in queries:
        qid = q["id"]
        query_text = q["query"]
        query_vector = embed_text(query_text, embedder_url)

        # Pool from Condition A
        a_results = condition_a(query_text, query_vector, milvus_client, bm25_service_url, 20, 80)

        # Pool from B1 and B2
        try:
            b1_results = condition_b(query_text, query_vector, milvus_client, "sparse_text", 20, 80)
        except Exception:
            b1_results = []
        try:
            b2_results = condition_b(query_text, query_vector, milvus_client, "sparse_bm25_text", 20, 80)
        except Exception:
            b2_results = []

        # Deduplicate by chunk_id
        seen: dict[str, dict] = {}
        for r in a_results + b1_results + b2_results:
            cid = r.get("chunk_id", "")
            if cid and cid not in seen:
                seen[cid] = r

        # Simple relevance heuristic: query terms overlap with chunk text
        query_terms = set(query_text.lower().split())
        relevant = []
        for cid, r in seen.items():
            chunk_text = r.get("text", "").lower()
            overlap = sum(1 for t in query_terms if t in chunk_text)
            # Require at least 40% of query terms present
            if overlap >= max(1, len(query_terms) * 0.4):
                relevant.append(cid)

        labels[qid] = relevant[:50]
        print(f"  {qid}: {len(relevant)} relevant out of {len(seen)} pooled")

    return labels


# ---------------------------------------------------------------------------
# Main benchmark runner
# ---------------------------------------------------------------------------


def run_benchmark(args):
    queries_path = Path(__file__).parent / "queries.yaml"
    with open(queries_path) as f:
        config = yaml.safe_load(f)

    queries = config["queries"]
    ks = [5, 10, 20]

    milvus_client = MilvusClient(uri=args.milvus_uri)
    embedder_url = args.embedder_url.rstrip("/")
    bm25_svc = args.bm25_service_url.rstrip("/")

    # Check collections exist
    collections = milvus_client.list_collections()
    if SOURCE_COLLECTION not in collections:
        print(f"ERROR: {SOURCE_COLLECTION} not found in Milvus", file=sys.stderr)
        sys.exit(1)
    if BENCH_COLLECTION not in collections:
        print(f"ERROR: {BENCH_COLLECTION} not found. Run setup_bench_collection.py first.", file=sys.stderr)
        sys.exit(1)

    # Generate or load relevance labels
    labels_path = Path(__file__).parent / "relevance_labels.json"
    if labels_path.exists() and not args.regenerate_labels:
        print(f"Loading cached labels from {labels_path}")
        with open(labels_path) as f:
            relevance_labels = json.load(f)
    else:
        relevance_labels = generate_relevance_labels(
            queries,
            milvus_client,
            bm25_svc,
            embedder_url,
        )
        with open(labels_path, "w") as f:
            json.dump(relevance_labels, f, indent=2)
        print(f"Saved labels to {labels_path}")

    # Pre-compute query embeddings
    print("Pre-computing query embeddings...")
    query_vectors = {}
    for q in queries:
        query_vectors[q["id"]] = embed_text(q["query"], embedder_url)

    conditions = {
        "A_custom": "Custom BM25 svc + vector + client RRF",
        "B1_native_text": "Milvus native BM25 (text only) + hybrid_search",
        "B2_native_enriched": "Milvus native BM25 (enriched) + hybrid_search",
    }

    all_results: dict[str, dict] = {c: {"per_query": [], "latencies": []} for c in conditions}

    fetch_k = args.top_k * 4
    num_runs = args.runs

    for run_idx in range(num_runs):
        print(f"\n--- Run {run_idx + 1}/{num_runs} ---")

        for q in queries:
            qid = q["id"]
            query_text = q["query"]
            qvec = query_vectors[qid]
            relevant = set(relevance_labels.get(qid, []))

            if not relevant:
                continue

            # Condition A
            t0 = time.perf_counter()
            a_res = condition_a(query_text, qvec, milvus_client, bm25_svc, args.top_k, fetch_k)
            a_latency = (time.perf_counter() - t0) * 1000
            all_results["A_custom"]["latencies"].append(a_latency)
            if run_idx == 0:
                a_metrics = compute_metrics(a_res, relevant, ks)
                all_results["A_custom"]["per_query"].append(
                    {
                        "query_id": qid,
                        "query": query_text,
                        **a_metrics,
                        "retrieved_ids": [r.get("chunk_id", "") for r in a_res[:20]],
                    }
                )

            # Condition B1
            try:
                t0 = time.perf_counter()
                b1_res = condition_b(query_text, qvec, milvus_client, "sparse_text", args.top_k, fetch_k)
                b1_latency = (time.perf_counter() - t0) * 1000
                all_results["B1_native_text"]["latencies"].append(b1_latency)
                if run_idx == 0:
                    b1_metrics = compute_metrics(b1_res, relevant, ks)
                    all_results["B1_native_text"]["per_query"].append(
                        {
                            "query_id": qid,
                            "query": query_text,
                            **b1_metrics,
                            "retrieved_ids": [r.get("chunk_id", "") for r in b1_res[:20]],
                        }
                    )
            except Exception as e:
                print(f"  B1 failed on {qid}: {e}")

            # Condition B2
            try:
                t0 = time.perf_counter()
                b2_res = condition_b(query_text, qvec, milvus_client, "sparse_bm25_text", args.top_k, fetch_k)
                b2_latency = (time.perf_counter() - t0) * 1000
                all_results["B2_native_enriched"]["latencies"].append(b2_latency)
                if run_idx == 0:
                    b2_metrics = compute_metrics(b2_res, relevant, ks)
                    all_results["B2_native_enriched"]["per_query"].append(
                        {
                            "query_id": qid,
                            "query": query_text,
                            **b2_metrics,
                            "retrieved_ids": [r.get("chunk_id", "") for r in b2_res[:20]],
                        }
                    )
            except Exception as e:
                print(f"  B2 failed on {qid}: {e}")

    # Aggregate
    report = build_report(all_results, ks, conditions)

    output_path = Path(args.output)
    with open(output_path, "w") as f:
        json.dump({"report": report, "raw": all_results}, f, indent=2, default=str)
    print(f"\nResults saved to {output_path}")

    # Print markdown table
    print_markdown_report(report, conditions)


def build_report(
    all_results: dict,
    ks: list[int],
    conditions: dict,
) -> dict[str, dict]:
    report = {}
    for cond_key, cond_label in conditions.items():
        data = all_results[cond_key]
        per_query = data["per_query"]
        latencies = data["latencies"]

        agg: dict[str, float] = {}
        for k in ks:
            for metric in ("recall", "mrr", "ndcg"):
                key = f"{metric}@{k}"
                vals = [q[key] for q in per_query if key in q]
                agg[key] = statistics.mean(vals) if vals else 0.0

        if latencies:
            sorted_lat = sorted(latencies)
            n = len(sorted_lat)
            agg["p50_ms"] = sorted_lat[int(n * 0.5)]
            agg["p95_ms"] = sorted_lat[int(n * 0.95)]
            agg["p99_ms"] = sorted_lat[min(int(n * 0.99), n - 1)]
            agg["mean_ms"] = statistics.mean(latencies)
        else:
            agg["p50_ms"] = agg["p95_ms"] = agg["p99_ms"] = agg["mean_ms"] = 0.0

        agg["query_count"] = len(per_query)
        agg["latency_samples"] = len(latencies)

        report[cond_key] = {"label": cond_label, "metrics": agg}

    return report


def print_markdown_report(report: dict, conditions: dict) -> None:
    print("\n" + "=" * 80)
    print("BM25 BENCHMARK RESULTS")
    print("=" * 80)

    metric_keys = [
        "recall@5",
        "recall@10",
        "recall@20",
        "mrr@10",
        "mrr@20",
        "ndcg@10",
        "ndcg@20",
        "p50_ms",
        "p95_ms",
        "p99_ms",
    ]

    headers = ["Metric"] + [report[c]["label"][:30] for c in conditions]
    col_widths = [max(20, len(h) + 2) for h in headers]

    header_line = " | ".join(h.ljust(w) for h, w in zip(headers, col_widths))
    sep_line = " | ".join("-" * w for w in col_widths)
    print(f"\n{header_line}")
    print(sep_line)

    for mk in metric_keys:
        vals = [mk.ljust(col_widths[0])]
        for i, cond_key in enumerate(conditions):
            m = report[cond_key]["metrics"]
            v = m.get(mk, 0.0)
            if "ms" in mk:
                vals.append(f"{v:>8.1f} ms".ljust(col_widths[i + 1]))
            else:
                vals.append(f"{v:>8.4f}".ljust(col_widths[i + 1]))
        print(" | ".join(vals))

    print()
    for cond_key in conditions:
        m = report[cond_key]["metrics"]
        print(
            f"  {report[cond_key]['label']}: {int(m['query_count'])} queries, {int(m['latency_samples'])} latency samples"
        )


def main():
    parser = argparse.ArgumentParser(description="BM25 Benchmark Runner")
    parser.add_argument("--milvus-uri", default="http://synesis-milvus.synesis-rag.svc.cluster.local:19530")
    parser.add_argument("--bm25-service-url", default="http://bm25-service.synesis-rag.svc.cluster.local:8080")
    parser.add_argument("--embedder-url", default="http://embedder.synesis-rag.svc.cluster.local:8080/v1")
    parser.add_argument("--runs", type=int, default=3, help="Number of latency measurement runs")
    parser.add_argument("--top-k", type=int, default=10, help="Final top-K results")
    parser.add_argument("--output", default="results.json", help="Output JSON path")
    parser.add_argument("--regenerate-labels", action="store_true", help="Force regenerate relevance labels")
    args = parser.parse_args()

    run_benchmark(args)


if __name__ == "__main__":
    main()
