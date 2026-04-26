# Synesis Doc Packs

Synesis Doc Packs (`.synpack`) are versioned, model-aware documentation bundles
for curated language and framework context. They complement the global RAG
corpus: normal external ingestion still lands in `pack_id="global"`, while
managed packs load into dedicated `pack_id` partitions in `synesis_catalog`.

## Format

A `.synpack` is a ZIP file containing:

- `manifest.json` — pack identity, source version, schema, embedding model, and checksums.
- `metadata.jsonl` — one catalog row per chunk. Rows may include embeddings inline.
- `vectors.npy` — optional dense vectors matching `metadata.jsonl` row order.
- `sources.lock.json` — fetched source inventory.
- optional `cleaned/`, `graph.jsonl`, and `embedder.onnx`.

The v1 pack baseline is `BAAI/bge-m3` with 1024-dimensional embeddings. BGE-M3
is the primary SynPack model because it supports long technical documents and
gives Synesis a path toward dense, sparse, and multi-vector retrieval.

## CLI

Build a Go pack from the bootstrap corpus:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language go \
  --pack-id go-latest \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/go-latest.synpack
```

`build-go` remains a convenience alias for the Go config.

Build a Rust pack:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language rust \
  --pack-id rust-latest \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/rust-latest.synpack
```

`build-rust` is a convenience alias for the Rust config. The Go builder resolves
the latest stable `goX.Y.Z` tag from `github.com/golang/go`; the Rust builder
resolves the latest stable `X.Y.Z` tag from `github.com/rust-lang/rust`.

Build a Quarkus pack:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language quarkus \
  --pack-id quarkus-latest \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/quarkus-latest.synpack
```

`build-quarkus` is a convenience alias for the Quarkus config. The Quarkus
builder resolves the latest stable `X.Y.Z` or `X.Y.Z.Final` tag from
`github.com/quarkusio/quarkus`.

Build a Python pack:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language python \
  --pack-id python-latest \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/python-latest.synpack
```

`build-python` is a convenience alias for the Python config. The Python builder
resolves the latest stable `vX.Y.Z` tag from `github.com/python/cpython`.
All language-pack builders accept `--latest-tag` or `--source-version`. For local smoke tests, use
`--max-chunks 25`; for offline/debug builds, use `--skip-enrichment` and
`--source-dir <checkout>`.

Validate and load:

```bash
python -m app.cli --mode synpack --synpack-command validate --synpack dist/synpacks/go-latest.synpack
python -m app.cli --mode synpack --synpack-command load --synpack dist/synpacks/go-latest.synpack --replace
```

List and search installed packs:

```bash
python -m app.cli --mode synpack --synpack-command list
python -m app.cli --mode synpack --synpack-command search --pack-id python-latest --query "repo_map asyncio TaskGroup cancellation"
```

## Retrieval

Planner and MCP knowledge search now accept pack filters:

- `pack_id` or `pack_ids`
- `pack_version`
- `package_name`
- `symbol_kind`
- `symbol_fqn`
- `perf_tier`

Example:

```json
{
  "query": "HTTP rate limiting example",
  "pack_id": "go-latest",
  "package_name": "net/http",
  "symbol_kind": "example"
}
```

Schema v17 adds universal agentic enrichment fields to pack rows and retrieval
results: `agent_hook`, `perf_tier`, `safety_contract`, `lifecycle_model`, and
`agent_enrichment_json`. Go-specific details such as memory semantics,
concurrency contracts, zero-value behavior, related interfaces, and hidden
warnings are preserved inside `agent_enrichment_json`. Rust-specific details
such as `async_contract`, `edition_scope`, borrow/lifetime constraints,
Send/Sync requirements, panic risk, unsafe/FFI contracts, drop semantics, and
compiler error context are also preserved inside `agent_enrichment_json`.
Quarkus-specific details such as `build_time_config`, `event_loop_safety`,
`reactive_flavor`, `native_image_note`, `dev_services`, `extension_dependency`,
CLI `command_intent`, `common_flags`, and `agent_advice` are preserved in the
same field.
Python-specific details such as `thread_model`, `typing_strategy`,
`async_contract`, `dependency_footprint`, `modern_idiom`, `environment_hint`,
`subinterpreter_safety`, `free_threading_risk`, and repo-map topology fields are
preserved in the same field.

## Migration Notes

Schema v16 changes the Milvus partition key from `authority` to `pack_id` and
migrates the dense vector dimension from 384 to 1024. The indexer recreates the
catalog on schema drift; existing queue/staged ingestion will repopulate global
content with `pack_id="global"`.

Schema v17 adds agentic enrichment columns for SynPack retrieval.
