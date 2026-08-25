# RAG retrieval evaluation

This is the canonical evaluation contract for the graph-native RAG stack. The
active backend is NornicDB; Milvus scripts under `benchmarks/bm25/` and
`benchmarks/retrieval/` are retained only as historical migration experiments
and are not release or pull-request gates.

## Active quality lanes

| Lane | Production surface | Assertion | Trigger |
|---|---|---|---|
| Retrieval golden suite | Planner `POST /v1/knowledge/search` → NornicDB | minimum hits plus expected source/text evidence | Relevant PRs when `SYNESIS_VALIDATION_ENABLED=true`, manual, release |
| Corpus audit | NornicDB `content_graph` and `embeddings` index | per-domain hit rate, MRR, source diversity, inventory, dead weight | Weekly workflow and in-cluster CronJob |
| SynPack evals | Installed pack graph | symbols, examples, anti-patterns, warnings, provenance | Pack qualification/promotion |
| Planner prompt suite | End-to-end planner response | routing, grounding, citations, latency, policy | Offline PR lane plus optional live lane |

The retrieval golden suite is source-anchored rather than score-baselined. A
zero-query or self-generated score file is not accepted as evidence of quality.
The retired Milvus seed baseline was removed because its zero values made the
old comparator false-green.

## Run the production retrieval suite

Port-forward the planner and use the internal service token—not a user PAT:

```bash
oc port-forward svc/synesis-planner-ts 8080:8080 -n synesis-planner
export SYNESIS_INTERNAL_SERVICE_TOKEN=...

python scripts/rag_retrieval_eval.py \
  --url http://localhost:8080 \
  --suite tests/prompts/go_retrieval_eval.yaml \
  --top-k 8 \
  --save-json retrieval-eval-results.json \
  --verbose
```

A case must declare a non-empty query and should pin all of the following:

- a stable case name and domain/language filter;
- a minimum hit count;
- at least one acceptable authoritative source name or URL fragment;
- at least one expected text fragment.

Use multiple acceptable fragments where source titles can vary. Avoid asserting
rank-specific chunk IDs unless the corpus artifact itself is immutable; content
rechunking legitimately changes IDs.

## Run the corpus audit

```bash
oc port-forward svc/synesis-nornicdb 7687:7687 -n synesis-rag
export SYNESIS_NORNIC_USER=neo4j
export SYNESIS_NORNIC_PASSWORD=...

python benchmarks/corpus/audit_corpus.py \
  --nornic-uri bolt://localhost:7687 \
  --nornic-database nornic \
  --nornic-vector-index embeddings \
  --output benchmarks/corpus/corpus_audit_report.json
```

The audit searches the same NornicDB vector index used by planner retrieval and
only counts global/open content by default. `--org-id` and `--tenant-ids` add
open content in those scopes; restricted/private content is intentionally not
included in this offline lane.

## Change and promotion rules

1. Add or update a golden case whenever retrieval behavior, graph schema,
   embedding profile, pack contents, filters, or reranking changes.
2. Run the production retrieval suite before and after the change and retain
   the JSON artifacts.
3. Treat query-set changes as reviewed evaluation changes, not a way to make a
   regression disappear.
4. Run the corpus audit after reindexing. Investigate new empty/weak domains,
   material MRR loss, or a large increase in dead weight.
5. For protected corpora, run a separate principal-scoped authorization suite;
   never weaken the audit predicate to expose restricted rows.

## Current gaps

- The checked-in golden suite is Go-heavy. Expand it with the Python,
  Terraform, Rust, TypeScript, platform, temporal/versioned, and graph-expansion
  cases already described in `base/rag/pack-evals/`.
- Add repeated-run consistency and fault-injection measurements around the
  planner endpoint (timeouts, partial upstream results, and schema changes).
- Persist run metadata with the corpus version, graph schema version, embedding
  profile, and deployed commit so comparisons are reproducible.
