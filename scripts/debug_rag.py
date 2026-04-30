#!/usr/bin/env python3
"""Debug NornicDB-backed Synesis RAG."""

from __future__ import annotations

import os
import sys


def main() -> int:
    uri = os.environ.get("SYNESIS_NORNIC_URI", "bolt://localhost:7687")
    user = os.environ.get("SYNESIS_NORNIC_USER", "neo4j")
    password = os.environ.get("SYNESIS_NORNIC_PASSWORD", "synesis-nornicdb")
    database = os.environ.get("SYNESIS_NORNIC_DATABASE", "nornic")
    query = os.environ.get("QUERY", "deployment configuration")

    try:
        from neo4j import GraphDatabase
    except ImportError:
        print("neo4j not installed. pip install neo4j", file=sys.stderr)
        return 1

    print(f"Connecting to NornicDB at {uri} ...")
    try:
        driver = GraphDatabase.driver(uri, auth=(user, password))
        with driver.session(database=database) as session:
            counts = session.run(
                """
                MATCH (n:ContentNode)
                OPTIONAL MATCH (:ContentNode)-[r]->(:ContentNode)
                RETURN count(DISTINCT n) AS nodes, count(r) AS edges, count(DISTINCT n.pack) AS packs
                """
            ).single()
            print(f"nodes={counts['nodes']} edges={counts['edges']} packs={counts['packs']}")

            print("\nSample nodes:")
            for row in session.run(
                """
                MATCH (n:ContentNode)
                RETURN n.id AS id, n.pack AS pack, n.kind AS kind, n.document_name AS document, left(n.text, 100) AS text
                LIMIT 5
                """
            ):
                print(f"  {row['id']} pack={row['pack']} kind={row['kind']} doc={row['document']} text={row['text']!r}")

            print(f"\nVector query: {query!r}")
            try:
                for row in session.run(
                    """
                    CALL db.index.vector.queryNodes('embeddings', 5, $search_query)
                    YIELD node, score
                    RETURN node.id AS id, node.pack AS pack, node.document_name AS document, score
                    ORDER BY score DESC
                    LIMIT 5
                    """,
                    search_query=query,
                ):
                    print(f"  score={row['score']} id={row['id']} pack={row['pack']} doc={row['document']}")
            except Exception as exc:
                print(f"Vector string query skipped: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"NornicDB debug query failed: {exc}", file=sys.stderr)
        print("Tip: oc port-forward -n synesis-rag svc/synesis-nornicdb 7687:7687", file=sys.stderr)
        return 1
    finally:
        try:
            driver.close()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
