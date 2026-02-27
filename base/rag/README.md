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
| **embedder/** | TEI (sentence-transformers/all-MiniLM-L6-v2) for indexers and planner |
| **indexers/** | Code, apispec, architecture, license indexers populate Milvus |

## Optional: LlamaStackDistribution

If you have **Llama Stack Operator** enabled in OpenShift AI 3, you can optionally add the full Llama Stack RAG (OpenAI-compatible APIs). See `llamastack-distribution.yaml` for the CR and secret setup instructions.

The LlamaStackDistribution connects to the same Milvus (`synesis-milvus`) and can use your deployed vLLM models. It is **not required** for Synesis — our planner and indexers work with Milvus + embedder directly.

## Indexer Idempotency

Indexers use **content-hash chunk IDs** (`chunk_id_hash` in indexer_base.py) and `existing_chunk_ids()` to skip re-embedding unchanged content. On re-run:

- **Same source data** → existing chunks skipped, only new/changed chunks embedded and upserted
- **Upsert by primary key** → same chunk_id overwrites in place (no duplicates)
- Use `--force` to re-embed everything (e.g. after embedding model change)

## Collection Loading

Milvus requires collections to be **loaded** before search/query. Indexers call `load_collection` when they create or ensure a collection. If Milvus restarts, collections may be unloaded. The planner and failure store will attempt to load on first "collection not loaded" error and retry. Missing or empty collections return `[]` gracefully — some collections take time to build.
