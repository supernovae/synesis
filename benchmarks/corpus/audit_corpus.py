#!/usr/bin/env python3
"""Corpus quality audit: per-domain coverage scoring and dead-weight detection.

For each taxonomy domain, generates representative queries, probes the
canonical NornicDB vector index, and scores coverage. Identifies domains with
gaps and documents that never surface in top-K results (dead weight).

Usage:
    python audit_corpus.py [--nornic-uri URI] [--nornic-database DB]
                           [--taxonomy PATH] [--top-k K] [--domains D1,D2]
                           [--llm-url URL] [--model MODEL]
                           [--output corpus_audit_report.json]
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import httpx
import yaml
from neo4j import GraphDatabase

COLLECTION = "content_graph"
DEFAULT_VECTOR_INDEX = "embeddings"


# ---------------------------------------------------------------------------
# Search helpers
# ---------------------------------------------------------------------------


def vector_search(
    query: str,
    client: Any,
    top_k: int,
    *,
    database: str,
    vector_index: str,
    org_id: str = "",
    tenant_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    formatted = []
    with client.session(database=database) as session:
        rows = session.run(
            """
            CALL db.index.vector.queryNodes($index_name, $candidate_limit, $query)
            YIELD node, score
            WHERE coalesce(node.acl_mode, "open") IN ["open", ""]
              AND (
                coalesce(node.visibility_scope, "global") = "global"
                OR (
                  $org_id <> ""
                  AND (
                  (node.visibility_scope = "org" AND node.org_id = $org_id)
                  OR (
                    node.visibility_scope = "tenant"
                    AND node.org_id = $org_id
                    AND node.tenant_id IN $tenant_ids
                  )
                )
              )
              )
            RETURN node, score
            ORDER BY score DESC
            LIMIT $limit
            """,
            query=query,
            index_name=vector_index,
            candidate_limit=max(top_k * 4, top_k),
            limit=top_k,
            org_id=org_id,
            tenant_ids=tenant_ids or [],
        )
        results = list(rows)
    for hit in results:
        entity = dict(hit["node"])
        get = entity.get
        formatted.append(
            {
                "chunk_id": get("chunk_id", ""),
                "doc_id": get("doc_id", ""),
                "text": get("text", ""),
                "document_name": get("document_name", ""),
                "domain": get("domain", ""),
                "authority": get("authority", ""),
                "source_url": get("source_url", ""),
                "handler": get("handler", ""),
                "rrf_score": float(hit["score"] or 0.0),
            }
        )
    return formatted


# ---------------------------------------------------------------------------
# Query generation from taxonomy config
# ---------------------------------------------------------------------------


def generate_queries_from_taxonomy(
    domain_key: str,
    domain_config: dict,
    llm_url: str | None = None,
    model: str = "synesis-general",
) -> list[str]:
    """Generate representative queries for a domain using taxonomy metadata."""
    queries = []

    path = domain_config.get("path", domain_key)
    hints = domain_config.get("query_expansion_hints", [])
    elements = domain_config.get("required_elements", [])

    # Template-based queries from hints
    for hint in hints[:4]:
        queries.append(f"How does {hint} work?")
    for hint in hints[4:6]:
        queries.append(f"What are best practices for {hint}?")

    # From required_elements
    for elem in elements[:3]:
        queries.append(f"Explain {elem.lower()} in {path.split('>')[-1].strip().lower()}")

    # Fallback: generic queries from domain name
    if not queries:
        readable = path.split(">")[-1].strip()
        queries = [
            f"What is {readable}?",
            f"How do I get started with {readable}?",
            f"What are best practices for {readable}?",
            f"Common mistakes in {readable}",
            f"Advanced topics in {readable}",
        ]

    # Optional LLM-generated queries for richer coverage
    if llm_url and len(queries) < 8:
        try:
            resp = httpx.post(
                f"{llm_url}/chat/completions",
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "user",
                            "content": (
                                f"Generate 5 diverse search queries that someone studying "
                                f"'{path}' would ask. One per line, no numbering."
                            ),
                        }
                    ],
                    "max_tokens": 200,
                    "temperature": 0.7,
                },
                timeout=30,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            for line in content.splitlines():
                line = line.strip().lstrip("0123456789.-) ")
                if len(line) > 10:
                    queries.append(line)
        except Exception as e:
            print(f"    LLM query generation failed for {domain_key}: {e}", file=sys.stderr)

    return queries[:10]


# ---------------------------------------------------------------------------
# Corpus inventory
# ---------------------------------------------------------------------------


def get_corpus_inventory(
    client: Any,
    domain: str = "",
    *,
    database: str,
    org_id: str = "",
    tenant_ids: list[str] | None = None,
) -> list[dict]:
    """Fetch all chunk metadata for a domain (or all domains)."""
    all_chunks = []
    offset = 0
    batch = 1000

    while True:
        with client.session(database=database) as session:
            rows = session.run(
                """
                MATCH (n:ContentNode)
                WHERE ($domain = "" OR n.domain = $domain)
                  AND coalesce(n.acl_mode, "open") IN ["open", ""]
                  AND (
                    coalesce(n.visibility_scope, "global") = "global"
                    OR (
                      $org_id <> ""
                      AND (
                        (n.visibility_scope = "org" AND n.org_id = $org_id)
                        OR (
                          n.visibility_scope = "tenant"
                          AND n.org_id = $org_id
                          AND n.tenant_id IN $tenant_ids
                        )
                      )
                    )
                  )
                RETURN n
                SKIP $offset
                LIMIT $limit
                """,
                domain=domain,
                offset=offset,
                limit=batch,
                org_id=org_id,
                tenant_ids=tenant_ids or [],
            )
            results = [dict(row["n"]) for row in rows]
        if not results:
            break
        all_chunks.extend(results)
        if len(results) < batch:
            break
        offset += batch

    return all_chunks


# ---------------------------------------------------------------------------
# Audit logic
# ---------------------------------------------------------------------------


def audit_domain(
    domain_key: str,
    domain_config: dict,
    client: Any,
    top_k: int,
    llm_url: str | None,
    model: str,
    *,
    database: str,
    vector_index: str,
    org_id: str = "",
    tenant_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Run the full audit for a single domain."""
    queries = generate_queries_from_taxonomy(domain_key, domain_config, llm_url, model)

    # Retrieve all chunks in this domain for inventory
    inventory = get_corpus_inventory(
        client,
        domain_key,
        database=database,
        org_id=org_id,
        tenant_ids=tenant_ids,
    )
    all_chunk_ids = {c.get("chunk_id", "") for c in inventory if c.get("chunk_id")}
    all_doc_ids = {c.get("doc_id", "") for c in inventory if c.get("doc_id")}

    doc_sources: dict[str, set[str]] = defaultdict(set)
    for c in inventory:
        did = c.get("doc_id", "")
        if did:
            doc_sources[did].add(c.get("document_name", ""))

    authority_dist: dict[str, int] = defaultdict(int)
    for c in inventory:
        authority_dist[c.get("authority", "unknown")] += 1

    handler_dist: dict[str, int] = defaultdict(int)
    for c in inventory:
        handler_dist[c.get("handler", "unknown")] += 1

    # Probe retrieval
    retrieved_chunk_ids: set[str] = set()
    retrieved_doc_ids: set[str] = set()
    retrieved_sources: set[str] = set()
    hit_count = 0
    mrr_scores: list[float] = []

    for q in queries:
        try:
            results = vector_search(
                q,
                client,
                top_k,
                database=database,
                vector_index=vector_index,
                org_id=org_id,
                tenant_ids=tenant_ids,
            )
        except Exception as e:
            print(f"    Search failed for '{q[:50]}': {e}", file=sys.stderr)
            mrr_scores.append(0.0)
            continue

        # Filter to domain-relevant results
        domain_results = [r for r in results if r["domain"] == domain_key]
        if domain_results:
            hit_count += 1

        for i, r in enumerate(domain_results):
            retrieved_chunk_ids.add(r["chunk_id"])
            retrieved_doc_ids.add(r["doc_id"])
            retrieved_sources.add(r["document_name"])

        # MRR: position of first domain-relevant result in the full result list
        mrr = 0.0
        for i, r in enumerate(results):
            if r["domain"] == domain_key:
                mrr = 1.0 / (i + 1)
                break
        mrr_scores.append(mrr)

    # Dead-weight: documents with 0 chunks retrieved
    dead_docs = all_doc_ids - retrieved_doc_ids
    dead_chunks = all_chunk_ids - retrieved_chunk_ids

    return {
        "domain": domain_key,
        "path": domain_config.get("path", domain_key),
        "inventory": {
            "total_chunks": len(all_chunk_ids),
            "total_documents": len(all_doc_ids),
            "authority_distribution": dict(authority_dist),
            "handler_distribution": dict(handler_dist),
        },
        "coverage": {
            "queries_tested": len(queries),
            "hit_rate": hit_count / len(queries) if queries else 0.0,
            "mean_mrr": statistics.mean(mrr_scores) if mrr_scores else 0.0,
            "source_diversity": len(retrieved_sources),
            "chunks_retrieved": len(retrieved_chunk_ids),
            "documents_retrieved": len(retrieved_doc_ids),
        },
        "dead_weight": {
            "unretrieved_documents": len(dead_docs),
            "unretrieved_chunks": len(dead_chunks),
            "unretrieved_doc_ids": sorted(dead_docs)[:20],
        },
        "sample_queries": queries[:5],
    }


def classify_domain(scorecard: dict) -> str:
    """Classify domain health: strong, adequate, weak, empty."""
    inv = scorecard["inventory"]["total_chunks"]
    if inv == 0:
        return "empty"
    cov = scorecard["coverage"]
    if cov["hit_rate"] >= 0.7 and cov["source_diversity"] >= 3:
        return "strong"
    if cov["hit_rate"] >= 0.4:
        return "adequate"
    return "weak"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Corpus quality audit")
    parser.add_argument("--nornic-uri", default="bolt://localhost:7687")
    parser.add_argument("--nornic-user", default=os.getenv("SYNESIS_NORNIC_USER", "neo4j"))
    parser.add_argument("--nornic-password", default=os.getenv("SYNESIS_NORNIC_PASSWORD", ""))
    parser.add_argument("--nornic-database", default=os.getenv("SYNESIS_NORNIC_DATABASE", "nornic"))
    parser.add_argument(
        "--nornic-vector-index",
        default=os.getenv("SYNESIS_NORNIC_VECTOR_INDEX", DEFAULT_VECTOR_INDEX),
    )
    parser.add_argument("--llm-url", default=None, help="Optional: LLM URL for richer query generation")
    parser.add_argument("--model", default="synesis-general")
    parser.add_argument("--taxonomy", default="base/planner-ts/config/taxonomy_prompt_config.yaml")
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--domains", default="", help="Comma-separated list of domains to audit (empty = all)")
    parser.add_argument("--output", default="benchmarks/corpus/corpus_audit_report.json")
    parser.add_argument("--org-id", default="", help="Scope results to this org (multi-tenant filter)")
    parser.add_argument("--tenant-ids", default="", help="Comma-separated tenant IDs for scope filter")
    args = parser.parse_args()

    taxonomy_path = Path(args.taxonomy)
    if not taxonomy_path.exists():
        print(f"ERROR: {taxonomy_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(taxonomy_path) as f:
        taxonomy = yaml.safe_load(f)

    target_domains = (
        [d.strip() for d in args.domains.split(",") if d.strip()] if args.domains else list(taxonomy.keys())
    )

    auth = (args.nornic_user, args.nornic_password) if args.nornic_password else None
    client = GraphDatabase.driver(args.nornic_uri, auth=auth)
    org_id = args.org_id.strip()[:64]
    tenant_ids = [tenant.strip()[:64] for tenant in args.tenant_ids.split(",") if tenant.strip()][:50]
    if org_id:
        print(f"Scope: global/open + org={org_id} + {len(tenant_ids)} tenant(s)")

    print(f"Auditing {len(target_domains)} domains against {COLLECTION}...")
    t0 = time.time()

    scorecards: list[dict] = []
    summary = {"strong": 0, "adequate": 0, "weak": 0, "empty": 0}

    try:
        client.verify_connectivity()
        for i, domain_key in enumerate(target_domains):
            domain_config = taxonomy.get(domain_key, {})
            if not isinstance(domain_config, dict) or "path" not in domain_config:
                continue

            print(f"\n[{i + 1}/{len(target_domains)}] {domain_key} ({domain_config.get('path', '')})")

            scorecard = audit_domain(
                domain_key,
                domain_config,
                client,
                args.top_k,
                args.llm_url,
                args.model,
                database=args.nornic_database,
                vector_index=args.nornic_vector_index,
                org_id=org_id,
                tenant_ids=tenant_ids,
            )
            health = classify_domain(scorecard)
            scorecard["health"] = health
            summary[health] += 1
            scorecards.append(scorecard)

            cov = scorecard["coverage"]
            inv = scorecard["inventory"]
            print(
                f"  {health.upper()}: {inv['total_chunks']} chunks, "
                f"hit_rate={cov['hit_rate']:.0%}, mrr={cov['mean_mrr']:.3f}, "
                f"diversity={cov['source_diversity']}"
            )
    finally:
        client.close()

    elapsed = time.time() - t0

    # Sort: weak first, then adequate, then strong, then empty
    priority = {"weak": 0, "adequate": 1, "strong": 2, "empty": 3}
    scorecards.sort(key=lambda s: (priority.get(s["health"], 99), -s["coverage"]["hit_rate"]))

    report = {
        "summary": summary,
        "elapsed_seconds": round(elapsed, 1),
        "collection": COLLECTION,
        "domains_audited": len(scorecards),
        "weak_domains": [s["domain"] for s in scorecards if s["health"] == "weak"],
        "empty_domains": [s["domain"] for s in scorecards if s["health"] == "empty"],
        "scorecards": scorecards,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n=== Corpus Audit Summary ({elapsed:.0f}s) ===")
    for health, count in summary.items():
        print(f"  {health:>10s}: {count}")
    print(f"\n  Weak domains: {', '.join(report['weak_domains'][:10]) or 'none'}")
    print(f"  Empty domains: {', '.join(report['empty_domains'][:10]) or 'none'}")
    print(f"\n  Report saved to: {output_path}")


if __name__ == "__main__":
    main()
