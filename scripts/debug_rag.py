#!/usr/bin/env python3
"""Debug script for Synesis RAG: inspect catalog and run sample searches.

Use this to verify the indexer has written data and retrieval returns results.
Run with port-forward from your machine, or inside the cluster (e.g. oc run).

  # From your machine (port-forward Milvus first):
  oc port-forward -n synesis-rag svc/synesis-milvus 19530:19530 &
  MILVUS_HOST=127.0.0.1 MILVUS_PORT=19530 python scripts/debug_rag.py

  # Optional: port-forward embedder for vector search
  oc port-forward -n synesis-rag svc/embedder 8080:8080 &
  EMBEDDER_URL=http://127.0.0.1:8080/v1 python scripts/debug_rag.py --vector

  # Inside cluster (e.g. debug pod):
  python scripts/debug_rag.py

Environment:
  MILVUS_HOST   Default: synesis-milvus.synesis-rag.svc.cluster.local (or 127.0.0.1 for port-forward)
  MILVUS_PORT   Default: 19530
  EMBEDDER_URL  Optional; if set and --vector, run one vector search (otherwise BM25-only)
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    host = os.environ.get("MILVUS_HOST", "synesis-milvus.synesis-rag.svc.cluster.local")
    port = int(os.environ.get("MILVUS_PORT", "19530"))
    uri = f"http://{host}:{port}"
    do_vector = "--vector" in sys.argv

    try:
        from pymilvus import MilvusClient
    except ImportError:
        print("pymilvus not installed. pip install pymilvus", file=sys.stderr)
        return 1

    print(f"Connecting to Milvus at {uri} ...")
    try:
        client = MilvusClient(uri=uri, timeout=10)
    except Exception as e:
        print(f"Connection failed: {e}", file=sys.stderr)
        print("Tip: oc port-forward -n synesis-rag svc/synesis-milvus 19530:19530", file=sys.stderr)
        return 1

    coll_name = "synesis_catalog"
    collections = client.list_collections()
    if coll_name not in collections:
        print(f"Collection '{coll_name}' not found. Available: {collections}")
        return 1

    print(f"\n=== Collection: {coll_name} ===")
    desc = client.describe_collection(collection_name=coll_name)
    fields = {f.get("name") for f in desc.get("fields", [])}
    print(f"Fields: {sorted(fields)}")

    try:
        client.load_collection(collection_name=coll_name)
        print("Collection loaded.")
    except Exception as e:
        print(f"Load collection failed (query/search may fail): {e}")

    # Row count
    try:
        # Milvus describe_collection may include num_entities
        n = desc.get("num_entities")
        if n is None:
            it = client.query_iterator(
                collection_name=coll_name,
                filter="",
                output_fields=["chunk_id"],
                batch_size=5000,
                limit=50_000,
            )
            n = 0
            while True:
                rows = it.next()
                if not rows:
                    break
                n += len(rows)
            it.close()
            if n >= 50_000:
                print(f"Total chunks (approx): {n}+ (capped at 50k)")
            else:
                print(f"Total chunks: {n}")
        else:
            print(f"Total chunks: {n}")
    except Exception as e:
        print(f"Could not get row count: {e}")
        n = -1

    if n == 0:
        print("\nNo data in collection. Run the indexer (e.g. docs CronJob) to populate.")
        return 0

    # Sample a few rows
    print("\n=== Sample chunks (first 5) ===")
    try:
        it = client.query_iterator(
            collection_name=coll_name,
            filter="",
            output_fields=["chunk_id", "document_name", "handler", "authority", "domain", "text"],
            batch_size=5,
            limit=5,
        )
        rows = it.next()
        it.close()
        for i, r in enumerate(rows or []):
            text = (r.get("text") or "")[:120].replace("\n", " ")
            print(
                f"  [{i + 1}] doc={r.get('document_name', '')!r} handler={r.get('handler')} authority={r.get('authority')} domain={r.get('domain')}"
            )
            print(f"       text={text!r}...")
    except Exception as e:
        print(f"Sample query failed: {e}")

    # BM25 searches (no embedder needed)
    print("\n=== BM25 sample searches ===")
    test_queries = [
        "deployment configuration",
        "API reference",
        "getting started",
        "architecture",
    ]
    for q in test_queries:
        try:
            out = client.search(
                collection_name=coll_name,
                data=[q],
                anns_field="sparse_text",
                search_params={"metric_type": "BM25"},
                limit=3,
                output_fields=["text", "document_name", "authority", "source_url"],
            )
            hits = out[0] if out else []
            print(f"  Query: {q!r} -> {len(hits)} hits")
            for h in hits[:2]:
                ent = h.get("entity", {})
                snip = (ent.get("text") or "")[:80].replace("\n", " ")
                print(f"    - {ent.get('document_name')} | {snip!r}...")
        except Exception as e:
            print(f"  Query {q!r} failed: {e}")

    # Optional: one vector search (requires embedder)
    if do_vector and os.environ.get("EMBEDDER_URL"):
        print("\n=== Vector search (one query) ===")
        embedder_url = os.environ.get("EMBEDDER_URL", "").rstrip("/")
        try:
            import httpx

            r = httpx.post(
                f"{embedder_url}/embeddings",
                json={"input": ["deployment configuration"], "model": "sentence-transformers/all-MiniLM-L6-v2"},
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            vec = data.get("data", [{}])[0].get("embedding")
            if not vec:
                print("  No embedding in response")
            else:
                out = client.search(
                    collection_name=coll_name,
                    data=[vec],
                    anns_field="embedding",
                    search_params={"metric_type": "COSINE", "params": {"ef": 64}},
                    limit=3,
                    output_fields=["text", "document_name", "authority"],
                )
                hits = out[0] if out else []
                print(f"  Query 'deployment configuration' (vector) -> {len(hits)} hits")
                for h in hits[:2]:
                    ent = h.get("entity", {})
                    print(f"    - {ent.get('document_name')} score={h.get('distance', 0):.4f}")
        except Exception as e:
            print(f"  Vector search failed: {e}")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
