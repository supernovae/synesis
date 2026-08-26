#!/usr/bin/env python3
"""Quality and latency regression benchmark for NornicDB native hybrid search.

The benchmark exercises the same HTTP search API used by the planner. Query
embedding, BM25, RRF fusion, and optional reranking therefore stay owned by
NornicDB instead of being reimplemented in the benchmark client.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import yaml
from baseline_policy import BenchmarkContractError, find_regressions, validate_snapshot


def recall_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    if not relevant_ids:
        return 0.0
    return sum(1 for result_id in retrieved_ids[:k] if result_id in relevant_ids) / len(relevant_ids)


def mrr_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    for rank, result_id in enumerate(retrieved_ids[:k], start=1):
        if result_id in relevant_ids:
            return 1.0 / rank
    return 0.0


def ndcg_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    dcg = sum(
        1.0 / math.log2(rank + 1)
        for rank, result_id in enumerate(retrieved_ids[:k], start=1)
        if result_id in relevant_ids
    )
    ideal = sum(1.0 / math.log2(rank + 1) for rank in range(1, min(len(relevant_ids), k) + 1))
    return dcg / ideal if ideal else 0.0


def native_search(
    client: httpx.Client,
    *,
    database: str,
    query: str,
    top_k: int,
) -> tuple[list[dict[str, Any]], str]:
    response = client.post(
        "/nornicdb/search",
        json={
            "database": database,
            "query": query,
            "labels": ["ContentNode"],
            "limit": top_k,
            "filters": {"kind": ["Chunk"]},
        },
    )
    response.raise_for_status()
    payload = response.json()
    rows: list[dict[str, Any]] = []
    for result in payload if isinstance(payload, list) else []:
        node = result.get("node") if isinstance(result.get("node"), dict) else {}
        properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
        result_id = str(properties.get("chunk_id") or properties.get("id") or node.get("id") or "")
        if result_id:
            rows.append(
                {
                    "id": result_id,
                    "score": float(result.get("score") or 0.0),
                    "rrf_score": float(result.get("rrf_score") or 0.0),
                    "vector_rank": int(result.get("vector_rank") or 0),
                    "bm25_rank": int(result.get("bm25_rank") or 0),
                }
            )
    methods = {
        "rrf_hybrid"
        if row["vector_rank"] and row["bm25_rank"]
        else "vector_only"
        if row["vector_rank"]
        else "bm25_only"
        for row in rows
    }
    if any(row["rrf_score"] and abs(row["score"] - row["rrf_score"]) > 1e-9 for row in rows):
        methods = {f"{method}+rerank" for method in methods}
    return rows, "+".join(sorted(methods)) or "empty"


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(int(len(ordered) * quantile), len(ordered) - 1)]


def main() -> None:
    parser = argparse.ArgumentParser(description="NornicDB native retrieval regression benchmark")
    parser.add_argument("--nornic-url", default=os.getenv("SYNESIS_NORNIC_HTTP_URL", "http://localhost:7474"))
    parser.add_argument("--database", default=os.getenv("SYNESIS_NORNIC_DATABASE", "nornic"))
    parser.add_argument("--user", default=os.getenv("SYNESIS_NORNIC_USER", "neo4j"))
    parser.add_argument("--password", default=os.getenv("SYNESIS_NORNIC_PASSWORD", ""))
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--output", default="benchmarks/retrieval/results_hybrid.json")
    parser.add_argument("--baseline", default="benchmarks/retrieval/baseline.json")
    parser.add_argument("--tolerance", type=float, default=0.05)
    parser.add_argument("--update-baseline", action="store_true")
    parser.add_argument("--use-llm-labels", action="store_true")
    args = parser.parse_args()

    queries_path = Path(__file__).parent.parent / "bm25" / "queries.yaml"
    labels_path = (
        Path(__file__).parent.parent / "corpus" / "relevance_labels_llm.json"
        if args.use_llm_labels
        else Path(__file__).parent.parent / "bm25" / "relevance_labels.json"
    )
    if not queries_path.exists() or not labels_path.exists():
        print(f"ERROR: benchmark inputs missing: {queries_path}, {labels_path}", file=sys.stderr)
        raise SystemExit(1)

    queries = (yaml.safe_load(queries_path.read_text(encoding="utf-8")) or {}).get("queries") or []
    relevance_labels = json.loads(labels_path.read_text(encoding="utf-8"))
    auth = httpx.BasicAuth(args.user, args.password) if args.password else None
    per_query: list[dict[str, Any]] = []
    latencies: list[float] = []
    search_methods: set[str] = set()

    with httpx.Client(base_url=args.nornic_url.rstrip("/"), auth=auth, timeout=30.0) as client:
        for run_index in range(max(args.runs, 1)):
            print(f"Run {run_index + 1}/{max(args.runs, 1)}")
            for query_case in queries:
                relevant = set(relevance_labels.get(query_case["id"], []))
                if not relevant:
                    continue
                started = time.perf_counter()
                results, search_method = native_search(
                    client,
                    database=args.database,
                    query=query_case["query"],
                    top_k=max(args.top_k, 20),
                )
                latencies.append((time.perf_counter() - started) * 1000)
                search_methods.add(search_method)
                if run_index:
                    continue
                result_ids = [row["id"] for row in results]
                metrics: dict[str, float] = {}
                for k in (5, 10, 20):
                    metrics[f"recall@{k}"] = recall_at_k(result_ids, relevant, k)
                    metrics[f"mrr@{k}"] = mrr_at_k(result_ids, relevant, k)
                    metrics[f"ndcg@{k}"] = ndcg_at_k(result_ids, relevant, k)
                per_query.append({"query_id": query_case["id"], **metrics})

    aggregate: dict[str, float | int] = {}
    for k in (5, 10, 20):
        for metric in ("recall", "mrr", "ndcg"):
            key = f"{metric}@{k}"
            aggregate[key] = statistics.mean(float(row[key]) for row in per_query) if per_query else 0.0
    aggregate.update(
        {
            "p50_ms": percentile(latencies, 0.50),
            "p95_ms": percentile(latencies, 0.95),
            "p99_ms": percentile(latencies, 0.99),
            "query_count": len(per_query),
        }
    )
    snapshot = {
        "backend": "nornicdb-native-search",
        "search_methods": sorted(search_methods),
        "aggregate": aggregate,
        "per_query": per_query,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")

    baseline_path = Path(args.baseline)
    try:
        validate_snapshot(snapshot, "current results")
        if args.update_baseline:
            baseline_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = baseline_path.with_suffix(f"{baseline_path.suffix}.tmp")
            temporary_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
            temporary_path.replace(baseline_path)
            print(f"Promoted reviewed results to {baseline_path}")
            return
        if not baseline_path.exists():
            raise BenchmarkContractError(
                f"no baseline at {baseline_path}; review results and rerun with --update-baseline"
            )
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        regressions = find_regressions(snapshot, baseline, args.tolerance)
    except (BenchmarkContractError, json.JSONDecodeError, KeyError, TypeError) as exc:
        print(f"INVALID RETRIEVAL QUALITY GATE: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    if regressions:
        print("REGRESSIONS DETECTED:", file=sys.stderr)
        for regression in regressions:
            print(f"  - {regression}", file=sys.stderr)
        raise SystemExit(1)
    print("All retrieval metrics remain within the reviewed tolerance.")


if __name__ == "__main__":
    main()
