# Semantic RAG ingestion (v9) — plan and design bar

This document is the canonical design reference for **Milvus v9**, the **semantic gatekeeper**, ingestion economics, and MCP-friendly metadata. It extends the expert-reviewed plan; implementation status lives in code (`SCHEMA_VERSION` in [`base/rag/indexer/app/schema.py`](../INDEXERS.md)) and [`docs/INDEXERS.md`](../INDEXERS.md).

## Goals

- **Integrity**: Provenance, explicit `index_decision`, consistent scalars for filters.
- **Economics**: Cheap steps before LLM; **hierarchical gatekeeper** (document-level labels inherited by chunks) by default.
- **Retrieval**: Rich metadata for hybrid search + **MCP / agent filters** (`language`, `artifact_kind`, `content_type`, scores, `index_decision`).

## Pipeline order (target)

1. Fetch + deterministic HTML cleanup (future preprocess service).
2. Near-duplicate control (simhash; future preprocess service).
3. Structure-aware chunking (handlers + `chunking.py`).
4. Chunk quality gate (`content_gate.py`).
5. **Semantic gatekeeper** (optional LLM, OpenAI-compatible): structured JSON, per-document when enabled.
6. Keyword-service + TEI embed + Milvus upsert.
7. Offline analytics (Bertopic, spam microservice) — not on the hot path initially.

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

### BERTopic — optional batch / backfill (todo)

- **Why run at all**: assign **stable `topic_id` / topic labels** for analytics, admin browsing, Milvus **metadata filters**, drift detection after corpus changes, or **re-embedding strategy** experiments — not required for basic retrieval.
- **Why not online**: cost, RAM, nondeterminism across small batches, and **version skew** when the topic model changes → expect **periodic backfill** jobs rather than synchronous ingestion.
- **Implementation sketch**: CronJob or Jobs queue in `synesis-rag`, read chunks/docs from Milvus or object store, write topic fields back (batch upsert). Flag in plan/roadmap until implemented.

### Done criteria (mark roadmap items finished)

- [x] `preprocess-service` image + manifests in `base/rag/`, indexer HTTP client + env wiring, docs in [`INDEXERS.md`](../INDEXERS.md).
- [x] `spam-service` image + manifests, indexer integration, NetworkPolicy + ClusterIP verified.
- [ ] (Optional) BERTopic batch job documented and linked from [`INDEXERS.md`](../INDEXERS.md); schema backfill path defined.

**Roadmap items (summary)**

- **Preprocess**: boilerplate (jusText/BoilerPy3) + simhash — `base/rag/preprocess-service/` (or similar), **one service** by default.
- **Spam**: DistilBERT — `base/rag/spam-service/` (Torch allowed there per ML boundary), **separate** from preprocess.
- **Topics**: Bertopic **batch / backfill only** — optional; not on hot path.
