# Semantic RAG ingestion (v9) — plan and design bar

This document is the canonical design reference for **Milvus v9**, the **semantic gatekeeper**, ingestion economics, and MCP-friendly metadata. It extends the expert-reviewed plan; implementation status lives in code (`SCHEMA_VERSION` in [`base/rag/indexer/app/schema.py`](../../base/rag/indexer/app/schema.py)) and [`docs/INDEXERS.md`](../INDEXERS.md).

## Implementation status (as of this doc)

| Area | Status |
|------|--------|
| Milvus **v9** schema, `catalog_entity`, admin/planner alignment | **Shipped** |
| Semantic **gatekeeper** (optional LLM, per-document) | **Shipped** (`gatekeeper.py`, env vars in INDEXERS) |
| **preprocess-service** (jusText `clean_html`, **simhash** batch) | **Shipped** — [`base/rag/preprocess-service/`](../../base/rag/preprocess-service/) |
| **spam-service** (DistilBERT batch scores) | **Shipped** — [`base/rag/spam-service/`](../../base/rag/spam-service/) |
| Indexer HTTP clients + `pipeline.py` wiring | **Shipped** |
| **Kustomize** | In [`base/rag/kustomization.yaml`](../../base/rag/kustomization.yaml), pulled by [`base/core/kustomization.yaml`](../../base/core/kustomization.yaml) → `overlays/api` and `overlays/model` via `./scripts/deploy.sh` |
| **CI images** | [`build-images.yml`](../../.github/workflows/build-images.yml), [`release.yml`](../../.github/workflows/release.yml), [`build-images.sh`](../../scripts/build-images.sh) |
| **deploy.sh** | Waits for `preprocess-service` and `spam-service` rollouts in `synesis-rag` |
| Indexer **CronJob** | **Separate** overlay — [`overlays/jobs/`](../../overlays/jobs/) / `deploy-indexer.sh` (not the same resource list as `base/rag/` services) |
| **BERTopic** batch / `topic_id` backfill | **Not implemented** — schema placeholders + ops note only (see INDEXERS) |
| Future: **pipeline batching** refactor | Intentionally deferred; microservices expose batch endpoints for later coalescing |

## Goals

- **Integrity**: Provenance, explicit `index_decision`, consistent scalars for filters.
- **Economics**: Cheap steps before LLM; **hierarchical gatekeeper** (document-level labels inherited by chunks) by default.
- **Retrieval**: Rich metadata for hybrid search + **MCP / agent filters** (`language`, `artifact_kind`, `content_type`, scores, `index_decision`).

## Pipeline order (implemented in `pipeline.py`)

1. Fetch (handlers).
2. Optional **HTML main-text** extraction (`preprocess-service` **clean_html**) for `html_document` when env enabled.
3. Structure-aware chunking (handlers + `chunking.py`).
4. Chunk quality gate (`content_gate.py`).
5. **Semantic gatekeeper** (optional LLM): structured JSON, per-document when enabled.
6. Optional **simhash** + **spam** batches (`preprocess-service`, `spam-service`) → Milvus scalars.
7. Enrich (template context; optional Tier-2 LLM in non-queue paths) → **TEI embed** → injection scan → **Milvus upsert**.

**Query-time keyword distillation** uses **keyword-service** in the planner, not inside the indexer pipeline.

## Milvus v9 fields

See [`docs/INDEXERS.md`](../INDEXERS.md) for the authoritative field list and ops notes.

## Configuration (indexer)

| Env | Purpose |
|-----|---------|
| `SYNESIS_INDEXER_GATEKEEPER_ENABLE` | `true` / `false` |
| `SYNESIS_INDEXER_GATEKEEPER_URL` | OpenAI-compatible base (e.g. `http://litellm-proxy...:4000/v1`) |
| `SYNESIS_INDEXER_GATEKEEPER_MODEL` | Model id |
| `SYNESIS_INDEXER_GATEKEEPER_API_KEY` | Optional Bearer token |
| `SYNESIS_INDEXER_GATEKEEPER_TIMEOUT` | Seconds (default 120) |
| `SYNESIS_INDEXER_GATEKEEPER_SKIP_AUTHORITY` | Comma list (e.g. `canonical,vetted`) to skip LLM for trusted authority |

## Cost model (summary)

- Avoid **per-chunk** gatekeeper at scale; use **per-document** excerpts + inheritance.
- Trusted `authority` values can skip gatekeeper entirely.
- See [`docs/RAG_INGESTION_COST.md`](../RAG_INGESTION_COST.md) for rough token math and levers.

## Roadmap (microservices)

### CPU and when to split services

- **Preprocess (jusText/BoilerPy3 + simhash)** runs comfortably on **CPU only**. No GPU is required. Work is deterministic text/HTML processing plus integer hashing; scale with **replicas** and CPU requests/limits.
- **Spam (DistilBERT-classifier style)** is also **CPU-viable** for typical ingestion rates. Throughput is lower than a tiny sklearn model but fine for batch/document scoring; use GPU only if you need very high QPS or large batches with tight latency SLOs. **Keep spam as its own deployment** (separate image, Torch/transformers lifecycle, independent HPA).
- **BERTopic / UMAP** is **not** recommended on the online ingestion hot path: it is heavy, benefits from batching, and model refreshes imply **reprocessing**. Treat it as an **optional offline or CronJob backfill** (see below).

### One preprocess service vs three

- **Default: one `preprocess-service`** (single FastAPI app, multiple routes: e.g. `/v1/clean`, `/v1/simhash`, or one `/v1/preprocess` that returns both). Same consumer (indexer), same namespace, one rollout, one HPA — simplest ops.
- **Split into multiple deployments** only if you later see **different scaling bottlenecks or SLOs** (e.g. simhash-only fleet for dedupe storms). That is unlikely before volume is large.

### Namespace, scaling, and image pattern

- Deploy in **`synesis-rag`** alongside [`keyword-service`](../../base/rag/keyword-service/deployment.yaml), embedder, indexer CronJobs, Milvus — same DNS pattern (`*.synesis-rag.svc.cluster.local`) already used by the planner and indexer.
- **Pattern**: copy the **keyword-service** layout — `synesis-base-api` Dockerfile, `uvicorn`, `/health`, small `requirements.txt`, `deployment.yaml` + `service.yaml` in `base/rag/<name>/`.
- **Autoscaling**: HPA on CPU (and optionally memory) is appropriate for preprocess and spam-on-CPU. Set sensible `requests` so the scheduler can pack pods; scale `maxReplicas` when ingestion queues grow.
- **Models baked into the image**: for Hugging Face weights (spam, or any future HF-based step), use a **build-time** download with `HF_TOKEN` (BuildKit secret or CI) so pods **start cold without Hub latency** and autoscaling stays responsive. Document the model revision in the image tag or label.

### Lock-down (platform-only consumers)

- Keep Services **ClusterIP** (no public Route/Ingress for these APIs).
- **`NetworkPolicy`** is applied on `preprocess-service` and `spam-service` (ingress from `app.kubernetes.io/name: synesis-indexer` only). Extend the same pattern if additional internal RAG APIs are added.
- Optional: **mTLS or shared internal token** header checked in middleware if defense-in-depth beyond network policy is required.

### BERTopic — optional batch / backfill (deferred implementation)

- **Why run at all**: assign **stable `topic_id` / topic labels** for analytics, admin browsing, Milvus **metadata filters**, drift detection after corpus changes, or **re-embedding strategy** experiments — not required for basic retrieval.
- **Why not online**: cost, RAM, nondeterminism across small batches, and **version skew** when the topic model changes → expect **periodic backfill** jobs rather than synchronous ingestion.
- **Implementation sketch**: CronJob or Job in `synesis-rag`, read chunks from Milvus (or export), run offline BERTopic/UMAP, **batch upsert** `topic_id` / `topic_keywords`. No Job manifest in this repo yet.
- **Documentation**: Ops expectations and field placeholders are described in [`INDEXERS.md`](../INDEXERS.md) (§ optional topic modeling).

### Done criteria (roadmap)

- [x] `preprocess-service` image + manifests in `base/rag/`, indexer HTTP client + env wiring, docs in [`INDEXERS.md`](../INDEXERS.md).
- [x] `spam-service` image + manifests, indexer integration, NetworkPolicy + ClusterIP verified.
- [x] (Optional) BERTopic: **documented** in INDEXERS + this plan; **implementation** intentionally deferred (no CronJob in tree).

**Roadmap items (summary)**

- **Preprocess**: boilerplate (jusText/BoilerPy3) + simhash — `base/rag/preprocess-service/` (or similar), **one service** by default.
- **Spam**: DistilBERT — `base/rag/spam-service/` (Torch allowed there per ML boundary), **separate** from preprocess.
- **Topics**: Bertopic **batch / backfill only** — optional; not on hot path.
