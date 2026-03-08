# RAG Stack (OpenShift AI 3)

Synesis RAG uses a **simple Milvus standalone deployment** (no Milvus Operator). This matches the approach used by RHOAI 3's Llama Stack documentation.

## Install

```bash
./scripts/install-rag-stack.sh         # Apply manifests only
./scripts/install-rag-stack.sh --wait  # Apply and wait for etcd, Milvus, embedder
```

The full `./scripts/deploy.sh dev` also installs the RAG stack as part of the overlay.

## Components

| Component | Purpose |
|-----------|---------|
| **milvus-standalone.yaml** | etcd + Milvus standalone Deployments, Service `synesis-milvus` on port 19530 |
| **embedder/** | TEI (sentence-transformers/all-MiniLM-L6-v2) for indexer and planner |
| **indexer/** | Unified config-driven indexer with handler plugins — all sources write to `synesis_catalog` |

## Optional: LlamaStackDistribution

If you have **Llama Stack Operator** enabled in OpenShift AI 3, you can optionally add the full Llama Stack RAG (OpenAI-compatible APIs). See `llamastack-distribution.yaml` for the CR and secret setup instructions.

The LlamaStackDistribution connects to the same Milvus (`synesis-milvus`) and can use your deployed vLLM models. It is **not required** for Synesis — our planner and indexer work with Milvus + embedder directly.

## Provenance and Authority

Every chunk in `synesis_catalog` carries provenance metadata:

| Field | Description | Example |
|-------|-------------|---------|
| `authority` | Trust tier (partition key): canonical, vetted, community, external | `canonical` (internal ADRs) |
| `origin_type` | Source category: internal, external, curated | `internal` |
| `source_url` | URL for citation | `https://github.com/org/repo` |
| `document_name` | Source document name for citation | `vLLM Deployment Guide` |
| `heading_path` | Document structure breadcrumb | `Architecture > Retrieval > BM25` |

Authority tiers influence retrieval ranking: canonical > vetted > community > external. The planner and section workers cite sources with document_name and source_url in responses when available.

## Enrichment Fields

The unified indexer populates enrichment fields for improved retrieval quality:

| Field | Purpose |
|-------|---------|
| `context_prefix` | Contextual sentence prepended before embedding (Contextual Retrieval pattern) |
| `chunk_summary` | 1-2 sentence neutral description (optional, LLM-generated) |
| `heading_path` | Document structure breadcrumb for context in retrieval and display |
| `keywords` | KeyBERT-extracted keywords for enhanced BM25 matching |

## Indexer Idempotency

The indexer uses **content-hash chunk IDs** (`chunk_id_hash`) and `existing_chunk_ids()` to skip re-embedding unchanged content. On re-run:

- **Same source data** → existing chunks skipped, only new/changed chunks embedded and upserted
- **Upsert by primary key** → same chunk_id overwrites in place (no duplicates)
- Use `--force` to re-embed everything (e.g., after embedding model change)

## Collection Loading

Milvus requires collections to be **loaded** before search/query. The indexer calls `load_collection` when it creates or ensures a collection. If Milvus restarts, collections may be unloaded. The planner and failure store will attempt to load on first "collection not loaded" error and retry. Missing or empty collections return `[]` gracefully — some collections take time to build.
