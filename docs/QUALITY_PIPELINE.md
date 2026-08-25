# Synesis Quality Pipeline

End-to-end corpus quality management: audit, benchmark, curate, ingest, and
verify against the current NornicDB-backed RAG stack.

## Architecture

```mermaid
flowchart LR
  A[Corpus audit] --> G[Gap analysis]
  G --> C[Curator proposals]
  C --> I[Admin ingestion queue]
  I --> X[Indexer]
  X --> N[NornicDB content_graph]
  N --> V[Retrieval benchmark]
  V --> A
```

Admin UI mapping: [ADMIN_QUALITY_UI.md](ADMIN_QUALITY_UI.md).

## Components

| Tool | Location | Purpose | Output |
|------|----------|---------|--------|
| **Corpus Audit** | `benchmarks/corpus/audit_corpus.py` | Per-domain coverage scoring, dead-weight detection, gap analysis | `corpus_audit_report.json` |
| **Retrieval Golden Suite** | `scripts/rag_retrieval_eval.py` | Production planner → NornicDB source/text assertions | `retrieval-eval-results.json` |
| **Curator Agent** | `tools/curator/curator_agent.py` | Discover ingestion item proposals for weak domains via SearXNG + LLM review | `proposed_ingestion_items.yaml` |
| **Admin Quality UI** | `base/admin/app/routers/rag.py`, `feedback.py`, React SPA | Dashboards, gaps, curator, benchmarks | `/rag/quality`, `/feedback/*` |
| **Quality CronJob** | `base/quality-runner/` | Scheduled audit, admin import, optional curator | persisted quality snapshots |

The Milvus utilities in `benchmarks/bm25/` and `benchmarks/retrieval/` are
historical migration experiments. They are useful only when reproducing the
former backend comparison and are not connected to CI, release gates, or the
current production retrieval path.

## Feedback Loop

1. **Audit** — Score taxonomy domains against the current content graph.
2. **Identify gaps** — Weak and empty domains surface in Admin quality views.
3. **Curate** — Generate proposed high-quality sources.
4. **Review** — Approve or reject proposals in Admin.
5. **Ingest** — Queue-driven indexer chunks, enriches, embeds, scans, and writes NornicDB graph nodes/edges.
6. **Verify** — Re-run audit and retrieval benchmarks to confirm improvements.

## Local Prerequisites

Use port-forwarding when running tools outside the cluster:

```bash
oc port-forward svc/synesis-nornicdb 7687:7687 -n synesis-rag
oc port-forward svc/synesis-planner-ts 8080:8080 -n synesis-planner
oc port-forward svc/searxng 8888:8080 -n synesis-search
```

## Running Locally

`scripts/quality-check.sh` defaults `UV_CACHE_DIR` and `UV_TOOL_DIR` to a
temporary directory when they are unset, so sandboxed runs do not depend on a
writable user-level uv cache. Override those variables if you need a persistent
cache.

```bash
make bench-corpus-audit
make bench-corpus-audit-llm
make bench-retrieval
```

Retrieval tooling should target:

- `SYNESIS_NORNIC_URI=bolt://localhost:7687`
- `SYNESIS_NORNIC_DATABASE=nornic`
- `SYNESIS_NORNIC_VECTOR_INDEX=embeddings`
- `SYNESIS_INTERNAL_SERVICE_TOKEN=...` for `make bench-retrieval`

## CI / Scheduled Runs

The quality pipeline can run as a scheduled or manual workflow:

```bash
gh workflow run quality-pipeline.yml -f audit=true -f curator=true
gh run list --workflow=quality-pipeline.yml --limit 3
```

Requirements: a self-hosted runner with network access to NornicDB, repository
variables `SYNESIS_NORNIC_URI`, `SYNESIS_NORNIC_DATABASE`, and
`SYNESIS_NORNIC_VECTOR_INDEX` when defaults do not apply, and validation
environment secrets `SYNESIS_NORNIC_USER` / `SYNESIS_NORNIC_PASSWORD` when
authentication is enabled. The in-cluster CronJob is the preferred scheduled
deployment because it reads NornicDB credentials from the Kubernetes Secret.
CI and the quality-runner image install the committed, hash-verified
`benchmarks/corpus/requirements.lock` and `tools/curator/requirements.lock`;
refresh them through `./scripts/lock-deps.sh`, not by editing locks directly.

## Troubleshooting

- Verify NornicDB rollout and Bolt connectivity.
- Confirm the `embeddings` vector index exists.
- Confirm the indexer has populated `content_graph`.
- Confirm `SYNESIS_RAG_AUTHZ_MODE` is `audit` unless `rag_doc:*` OpenFGA grants are populated for protected rows.
- Confirm NornicDB's configured runtime profile can embed text queries and that
  planner/indexer agree on the BGE-M3 embedding profile.

See also: [RAG](RAG.md), [INDEXERS.md](INDEXERS.md), [ADMIN_QUALITY_UI.md](ADMIN_QUALITY_UI.md).
