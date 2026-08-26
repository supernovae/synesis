#!/usr/bin/env python3
"""LLM-as-judge relevance labeling for retrieval benchmarks.

Replaces the naive 40%-overlap heuristic with actual LLM relevance judgments.
For each (query, candidate_chunk) pair, asks an LLM to rate relevance 0-3.
Results are cached to avoid re-judging on subsequent runs.

Usage:
    python llm_judge.py [--nornic-url URL] [--llm-url URL]
                        [--model MODEL] [--pool-k K] [--threshold 2]
                        [--output relevance_labels_llm.json]
                        [--judgments-cache judgments_cache.json]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx
import yaml

DEFAULT_JUDGE_MODEL = "synesis-general"

JUDGE_PROMPT = """\
Rate how relevant this document chunk is to the search query.

Scale:
  0 = irrelevant — unrelated topic
  1 = marginally relevant — related topic but does not answer the query
  2 = relevant — partially answers the query or provides useful context
  3 = highly relevant — directly and substantively answers the query

Query: {query}

Document chunk:
{chunk_text}

Respond with ONLY a single digit (0, 1, 2, or 3)."""


# ---------------------------------------------------------------------------
# Native search helper
# ---------------------------------------------------------------------------


def hybrid_search(
    query: str,
    client: httpx.Client,
    database: str,
    top_k: int,
) -> list[dict[str, Any]]:
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
    formatted: list[dict[str, Any]] = []
    payload = response.json()
    for result in payload if isinstance(payload, list) else []:
        node = result.get("node") if isinstance(result.get("node"), dict) else {}
        properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
        formatted.append(
            {
                "chunk_id": str(properties.get("chunk_id") or properties.get("id") or node.get("id") or ""),
                "text": str(properties.get("text") or properties.get("content") or ""),
                "document_name": str(properties.get("document_name") or ""),
                "domain": str(properties.get("domain") or ""),
                "authority": str(properties.get("authority") or ""),
                "source_url": str(properties.get("source_url") or ""),
            }
        )
    return formatted


# ---------------------------------------------------------------------------
# LLM judge
# ---------------------------------------------------------------------------


def judge_relevance(
    query: str,
    chunk_text: str,
    llm_url: str,
    model: str,
) -> int:
    """Ask the LLM to rate relevance 0-3. Returns the integer score."""
    prompt = JUDGE_PROMPT.format(query=query, chunk_text=chunk_text[:1500])
    try:
        resp = httpx.post(
            f"{llm_url}/chat/completions",
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 4,
                "temperature": 0.0,
            },
            timeout=30,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()
        for ch in content:
            if ch in "0123":
                return int(ch)
        return 0
    except Exception as e:
        print(f"    Judge call failed: {e}", file=sys.stderr)
        return 0


def load_cache(cache_path: Path) -> dict[str, int]:
    """Load cached judgments as {query_id::chunk_id: score}."""
    if cache_path.exists():
        with open(cache_path) as f:
            return json.load(f)
    return {}


def save_cache(cache: dict[str, int], cache_path: Path) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w") as f:
        json.dump(cache, f, indent=2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="LLM-as-judge relevance labeling")
    parser.add_argument("--nornic-url", default=os.getenv("SYNESIS_NORNIC_HTTP_URL", "http://localhost:7474"))
    parser.add_argument("--database", default=os.getenv("SYNESIS_NORNIC_DATABASE", "nornic"))
    parser.add_argument("--user", default=os.getenv("SYNESIS_NORNIC_USER", "neo4j"))
    parser.add_argument("--password", default=os.getenv("SYNESIS_NORNIC_PASSWORD", ""))
    parser.add_argument("--llm-url", default="http://localhost:8080/v1", help="OpenAI-compatible endpoint")
    parser.add_argument("--model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--pool-k", type=int, default=30, help="Top-K results to pool per query for judging")
    parser.add_argument("--threshold", type=int, default=2, help="Min LLM score to count as relevant (0-3)")
    parser.add_argument("--queries", default="benchmarks/bm25/queries.yaml")
    parser.add_argument("--output", default="benchmarks/corpus/relevance_labels_llm.json")
    parser.add_argument("--judgments-cache", default="benchmarks/corpus/judgments_cache.json")
    args = parser.parse_args()

    queries_path = Path(args.queries)
    if not queries_path.exists():
        print(f"ERROR: {queries_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(queries_path) as f:
        queries = yaml.safe_load(f)["queries"]

    auth = httpx.BasicAuth(args.user, args.password) if args.password else None
    client = httpx.Client(base_url=args.nornic_url.rstrip("/"), auth=auth, timeout=30.0)
    cache_path = Path(args.judgments_cache)
    cache = load_cache(cache_path)

    print(f"Loaded {len(cache)} cached judgments")
    print(f"Processing {len(queries)} queries, pooling top-{args.pool_k} per query...")

    labels: dict[str, list[str]] = {}
    total_judged = 0
    total_cached = 0
    total_relevant = 0

    for qi, q in enumerate(queries):
        qid = q["id"]
        query_text = q["query"]
        print(f"\n[{qi + 1}/{len(queries)}] {qid}: {query_text}")

        candidates = hybrid_search(query_text, client, args.database, args.pool_k)

        # Deduplicate
        seen: dict[str, dict] = {}
        for c in candidates:
            cid = c.get("chunk_id", "")
            if cid and cid not in seen:
                seen[cid] = c

        relevant = []
        for cid, chunk in seen.items():
            cache_key = f"{qid}::{cid}"
            if cache_key in cache:
                score = cache[cache_key]
                total_cached += 1
            else:
                score = judge_relevance(query_text, chunk["text"], args.llm_url, args.model)
                cache[cache_key] = score
                total_judged += 1
                # Periodic cache save
                if total_judged % 50 == 0:
                    save_cache(cache, cache_path)

            if score >= args.threshold:
                relevant.append(cid)
                total_relevant += 1

        labels[qid] = relevant
        print(f"  {len(relevant)} relevant / {len(seen)} candidates ({total_cached} cached, {total_judged} judged)")

    # Final save
    save_cache(cache, cache_path)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(labels, f, indent=2)

    print("\n=== LLM Judge Summary ===")
    print(f"  Queries:          {len(queries)}")
    print(f"  Total judged:     {total_judged} (new)")
    print(f"  From cache:       {total_cached}")
    print(f"  Total relevant:   {total_relevant}")
    print(f"  Labels saved to:  {output_path}")
    print(f"  Cache saved to:   {cache_path}")
    client.close()


if __name__ == "__main__":
    main()
