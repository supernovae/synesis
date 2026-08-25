#!/usr/bin/env python3
"""Retrieval quality regression test using Milvus native hybrid search.

Runs the production retrieval path (dense + sparse BM25 via RRFRanker) against
a fixed query set and compares quality metrics to saved baselines.

Usage:
    python bench_hybrid.py [--milvus-uri URI] [--embedder-url URL]
                           [--runs N] [--top-k K] [--output results.json]
                           [--baseline baseline.json] [--tolerance 0.05]
                           [--update-baseline]
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
from baseline_policy import BenchmarkContractError, find_regressions, validate_snapshot
from pymilvus import AnnSearchRequest, MilvusClient, RRFRanker

COLLECTION = "synesis_catalog"
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


def embed_text(text: str, embedder_url: str) -> list[float]:
    resp = httpx.post(
        f"{embedder_url}/embeddings",
        json={"input": [text], "model": EMBEDDING_MODEL},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def build_scope_expr(org_id: str = "", tenant_ids: list[str] | None = None) -> str:
    """Build three-tier visibility scope filter for benchmarks."""
    clauses = ['visibility_scope == "global"']
    if org_id:
        safe_org = org_id.replace('"', "")[:64]
        clauses.append(f'(visibility_scope == "org" and org_id == "{safe_org}")')
        if tenant_ids:
            safe_tenants = [t.replace('"', "")[:64] for t in tenant_ids[:50]]
            tenant_list = ",".join(f'"{t}"' for t in safe_tenants)
            clauses.append(
                f'(visibility_scope == "tenant" and org_id == "{safe_org}" and tenant_id in [{tenant_list}])'
            )
    return f"({' or '.join(clauses)})"


def hybrid_search(
    query: str,
    query_vector: list[float],
    client: MilvusClient,
    top_k: int,
    rrf_k: int = 60,
    scope_filter: str = "",
) -> list[dict[str, Any]]:
    dense_req = AnnSearchRequest(
        data=[query_vector],
        anns_field="embedding",
        param={"metric_type": "COSINE", "params": {"ef": max(128, top_k)}},
        limit=top_k,
        expr=scope_filter if scope_filter else None,
    )
    sparse_req = AnnSearchRequest(
        data=[query],
        anns_field="sparse_text",
        param={"metric_type": "BM25"},
        limit=top_k,
        expr=scope_filter if scope_filter else None,
    )
    results = client.hybrid_search(
        collection_name=COLLECTION,
        reqs=[dense_req, sparse_req],
        ranker=RRFRanker(k=rrf_k),
        limit=top_k,
        output_fields=OUTPUT_FIELDS,
    )
    formatted = []
    for hit in results[0] if results else []:
        entity = hit.entity if hasattr(hit, "entity") else hit.get("entity", {})
        get = entity.get if isinstance(entity, dict) else lambda k, d="", _e=entity: getattr(_e, k, d)
        formatted.append(
            {
                "chunk_id": get("chunk_id", ""),
                "text": get("text", ""),
                "rrf_score": float(hit.distance) if hasattr(hit, "distance") else 0.0,
            }
        )
    return formatted


# ---- Metrics ----------------------------------------------------------------


def recall_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    if not relevant_ids:
        return 0.0
    return sum(1 for rid in retrieved_ids[:k] if rid in relevant_ids) / len(relevant_ids)


def mrr_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    for i, rid in enumerate(retrieved_ids[:k]):
        if rid in relevant_ids:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    dcg = sum(1.0 / math.log2(i + 2) for i, rid in enumerate(retrieved_ids[:k]) if rid in relevant_ids)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(len(relevant_ids), k)))
    return dcg / idcg if idcg > 0 else 0.0


# ---- Main -------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Hybrid retrieval regression benchmark")
    parser.add_argument("--milvus-uri", default="http://localhost:19530")
    parser.add_argument("--embedder-url", default="http://localhost:8082/v1")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--output", default="benchmarks/retrieval/results_hybrid.json")
    parser.add_argument("--baseline", default="benchmarks/retrieval/baseline.json")
    parser.add_argument(
        "--tolerance", type=float, default=0.05, help="Max allowed relative drop from baseline before failing"
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Explicitly promote the current valid result to the baseline after review",
    )
    parser.add_argument(
        "--use-llm-labels",
        action="store_true",
        help="Use LLM-judged labels from benchmarks/corpus/ instead of overlap-based",
    )
    parser.add_argument("--org-id", default="", help="Scope results to this org (multi-tenant filter)")
    parser.add_argument("--tenant-ids", default="", help="Comma-separated tenant IDs for scope filter")
    args = parser.parse_args()

    queries_path = Path(__file__).parent.parent / "bm25" / "queries.yaml"
    if args.use_llm_labels:
        labels_path = Path(__file__).parent.parent / "corpus" / "relevance_labels_llm.json"
    else:
        labels_path = Path(__file__).parent.parent / "bm25" / "relevance_labels.json"

    if not queries_path.exists():
        print(f"ERROR: {queries_path} not found", file=sys.stderr)
        sys.exit(1)
    if not labels_path.exists():
        label_source = "LLM judge (run benchmarks/corpus/llm_judge.py)" if args.use_llm_labels else "BM25 benchmark"
        print(f"ERROR: {labels_path} not found. Run {label_source} first.", file=sys.stderr)
        sys.exit(1)

    with open(queries_path) as f:
        queries = yaml.safe_load(f)["queries"]
    with open(labels_path) as f:
        relevance_labels = json.load(f)

    client = MilvusClient(uri=args.milvus_uri)
    embedder_url = args.embedder_url.rstrip("/")
    ks = [5, 10, 20]
    fetch_k = args.top_k * 4

    scope_filter = ""
    if args.org_id:
        tid_list = [t.strip() for t in args.tenant_ids.split(",") if t.strip()] if args.tenant_ids else None
        scope_filter = build_scope_expr(args.org_id, tid_list)
        print(f"Scope filter: {scope_filter}")

    print("Pre-computing query embeddings...")
    query_vectors = {q["id"]: embed_text(q["query"], embedder_url) for q in queries}

    per_query: list[dict] = []
    latencies: list[float] = []

    for run_idx in range(args.runs):
        print(f"--- Run {run_idx + 1}/{args.runs} ---")
        for q in queries:
            relevant = set(relevance_labels.get(q["id"], []))
            if not relevant:
                continue

            t0 = time.perf_counter()
            results = hybrid_search(q["query"], query_vectors[q["id"]], client, fetch_k, scope_filter=scope_filter)
            lat = (time.perf_counter() - t0) * 1000
            latencies.append(lat)

            if run_idx == 0:
                rids = [r["chunk_id"] for r in results]
                metrics = {}
                for k in ks:
                    metrics[f"recall@{k}"] = recall_at_k(rids, relevant, k)
                    metrics[f"mrr@{k}"] = mrr_at_k(rids, relevant, k)
                    metrics[f"ndcg@{k}"] = ndcg_at_k(rids, relevant, k)
                per_query.append({"query_id": q["id"], **metrics})

    agg: dict[str, float] = {}
    for k in ks:
        for m in ("recall", "mrr", "ndcg"):
            key = f"{m}@{k}"
            vals = [pq[key] for pq in per_query if key in pq]
            agg[key] = statistics.mean(vals) if vals else 0.0

    sorted_lat = sorted(latencies)
    n = len(sorted_lat)
    agg["p50_ms"] = sorted_lat[int(n * 0.5)] if n else 0.0
    agg["p95_ms"] = sorted_lat[int(n * 0.95)] if n else 0.0
    agg["p99_ms"] = sorted_lat[min(int(n * 0.99), n - 1)] if n else 0.0
    agg["query_count"] = len(per_query)

    # Print report
    print("\n=== Hybrid Retrieval Regression Test ===")
    for key, val in agg.items():
        if "ms" in key:
            print(f"  {key:>12s}: {val:8.1f} ms")
        elif key != "query_count":
            print(f"  {key:>12s}: {val:8.4f}")
    print(f"  {'queries':>12s}: {int(agg['query_count'])}")

    # Save results
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot = {"aggregate": agg, "per_query": per_query}
    with open(output_path, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"\nResults saved to {output_path}")

    # Baseline comparison
    baseline_path = Path(args.baseline)
    try:
        validate_snapshot(snapshot, "current results")
        if args.update_baseline:
            baseline_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = baseline_path.with_suffix(f"{baseline_path.suffix}.tmp")
            with open(temporary_path, "w") as f:
                json.dump(snapshot, f, indent=2)
                f.write("\n")
            temporary_path.replace(baseline_path)
            print(f"\nPromoted current results to {baseline_path}.")
            return

        if not baseline_path.exists():
            raise BenchmarkContractError(
                f"no baseline found at {baseline_path}; review the results, then rerun with --update-baseline"
            )
        with open(baseline_path) as f:
            baseline = json.load(f)
        regressions = find_regressions(snapshot, baseline, args.tolerance)
    except (BenchmarkContractError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"\nINVALID RETRIEVAL QUALITY GATE: {exc}", file=sys.stderr)
        sys.exit(2)

    if regressions:
        print("\nREGRESSIONS DETECTED:")
        for regression in regressions:
            print(f"  - {regression}")
        sys.exit(1)
    print("\nAll metrics within tolerance of baseline.")


if __name__ == "__main__":
    main()
