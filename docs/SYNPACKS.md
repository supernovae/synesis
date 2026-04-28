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
Pack manifests also include `embedding_profile` and `corpus_version` so a future
embedder change can be treated as a corpus rebuild boundary without changing the
portable pack format.

SynPacks are English-first by default. Pack configs declare `doc_language: en`
and `supported_doc_languages: [en]`; non-English builds must opt in through the
pack config and use a pack id ending in the locale suffix, such as
`godot-latest-ja`. The enrichment prompt records the source document language
and preserves official API names, identifiers, package names, and error strings
without translation.

Structured files are chunked by natural document boundaries before embedding:
YAML and Helm/Kubernetes manifests split by YAML document/resource and then
top-level keys; Terraform/OpenTofu HCL splits by top-level `resource`, `data`,
`module`, `variable`, `output`, `locals`, `terraform`, and `provider` blocks;
JSON/TOML/XML split by top-level elements. Oversized structured sections are
line-split with overlap rather than truncated.

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

Build a Godot pack:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language godot \
  --pack-id godot-latest \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/godot-latest.synpack
```

`build-godot` is a convenience alias for the Godot config. The Godot builder
resolves the latest stable `X.Y-stable` or `X.Y.Z-stable` tag from
`github.com/godotengine/godot`, extracts `doc/classes` XML, shader/rendering
source hints, `godot-docs`, and `godot-proposals`.

Build a Terraform pack:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language terraform \
  --pack-id terraform-latest \
  --provider-schema ./provider-schemas/providers.json \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/terraform-latest.synpack
```

`build-terraform` is a convenience alias for the Terraform config. The Terraform
builder resolves the latest stable `vX.Y.Z` tag from `github.com/hashicorp/terraform`,
extracts Terraform/OpenTofu docs, AWS/Azure/GCP provider docs, TFLint rules, and
local `terraform providers schema -json` output. The builder never runs
`terraform apply`, `destroy`, `import`, or cloud inventory commands.

Build an Ecma/JS/TS pack:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language ecma \
  --pack-id ecma-latest \
  --enrichment-url http://localhost:8000 \
  --output dist/synpacks/ecma-latest.synpack
```

`build-ecma` is a convenience alias for the unified JavaScript/TypeScript pack.
The Ecma builder uses `tc39/proposals` as the primary source and can include
TypeScript Handbook, Node, Bun, Deno, and MDN Web Platform auxiliary docs. It
tracks Temporal, runtime compatibility, native TypeScript/type stripping,
module systems, async APIs, bundle impact, and package-risk guidance. The
builder indexes docs only; it never runs package managers or installs
dependencies.

All language-pack builders accept `--latest-tag` or `--source-version`. For local smoke tests, use
`--max-chunks 25`; for offline/debug builds, use `--skip-enrichment` and
`--source-dir <checkout>`.

### DeepSeek enrichment

SynPack enrichment now defaults to DeepSeek V4 Pro (`deepseek-v4-pro`) with
thinking enabled and `reasoning_effort=max`. The builder sends
`X-DeepSeek-Think-Mode: Max`, uses `max_tokens>=8192`, and reads the bearer token
from `DEEPSEEK_TOKEN` with `DEEPSEEK_API_KEY` as a fallback.

```bash
export DEEPSEEK_TOKEN=...
python -m app.cli --mode synpack --synpack-command build-language \
  --language terraform \
  --pack-id terraform-latest \
  --doc-language en \
  --enrichment-url https://api.deepseek.com \
  --enrichment-concurrency 6 \
  --enrichment-max-tokens 8192 \
  --output dist/synpacks/terraform-latest.synpack
```

Concurrency is capped at 8 requests in flight. The enrichment request keeps a
stable system prompt and language prompt prefix before the chunk text so
DeepSeek context caching can reuse shared prompt prefixes when the service
persists them. Manifest `enrichment.usage` records returned token usage and
cache hit/miss counts when the API reports them.

Run a grounded token-budget preflight before spending model tokens:

```bash
python -m app.cli --mode synpack --synpack-command build-language \
  --language terraform \
  --pack-id terraform-latest \
  --source-dir ./terraform \
  --estimate-cost-only \
  --enrichment-input-price-per-mtok 0 \
  --enrichment-output-price-per-mtok 0
```

The preflight extracts the same chunks and prompt templates, estimates prompt
tokens with a conservative character-based estimator, adds the configured
completion budget and max-thinking budget, and exits before LLM calls,
embedding, or pack writing. The reported completion and thinking values are
worst-case per-request budgets multiplied by prepared chunks, not expected
usage. Large local clone sizes are normal for packs with auxiliary repos; only
prepared chunks that survive extraction and quality gating are included in the
prompt-token estimate.

Validate and load:

```bash
python -m app.cli --mode synpack --synpack-command validate --synpack dist/synpacks/go-latest.synpack
python -m app.cli --mode synpack --synpack-command load --synpack dist/synpacks/go-latest.synpack --replace
```

List and search installed packs:

```bash
python -m app.cli --mode synpack --synpack-command list
python -m app.cli --mode synpack --synpack-command search --pack-id python-latest --query "repo_map asyncio TaskGroup cancellation"
python -m app.cli --mode synpack --synpack-command search --pack-id godot-latest --query "Button pressed signal scene tree lifecycle"
python -m app.cli --mode synpack --synpack-command search --pack-id terraform-latest --query "aws_db_instance replacement import drift risk"
python -m app.cli --mode synpack --synpack-command search --pack-id ecma-latest --query "Temporal PlainDate add months runtime compatibility"
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
Godot-specific details such as `node_compatibility`, `signal_list`,
`signal_contract`, `gdscript_idiom`, `thread_safety`, `performance_note`,
`scene_tree_impact`, `lifecycle_order`, `physics_rendering_boundary`, and
`legacy_3x_warning` are preserved in the same field.
Terraform-specific details such as `core_safety`, `destroy_triggers`,
`force_new_confidence`, `permission_requirements`, `cross_resource_links`,
`drift_risk`, `provisioner_safe`, `import_id_format`, `state_sensitivity`,
`approval_policy`, and `plan_guardrail` are preserved in the same field.
Ecma/JS/TS-specific details such as `runtime_compatibility`, `runtime_env`,
`ts_safety`, `ts_contract`, `async_flavor`, `bundle_impact`, `module_system`,
`type_stripping_status`, `permission_model`, `dependency_advice`,
`timezone_dependency`, `dst_awareness`, `runtime_status`,
`legacy_date_replacement`, and Temporal calendar safety notes are preserved in
the same field.

Terraform also includes a read-only MCP risk analyzer,
`synesis_terraform_plan_analyze`, for JSON produced by `terraform show -json
tfplan`. It flags delete/replacement actions and returns an approval-ready
hard-gate bundle; it does not execute Terraform or mutate state.

Ecma also includes read-only MCP steering helpers:
`synesis_ecma_environment_check` detects package manager, runtime, module
system, TypeScript strictness, and recommended EcmaPack filters from local
configuration content; `synesis_ecma_package_risk_analyze` flags lifecycle
scripts and legacy/heavy dependency additions before a package change. Neither
tool runs npm, pnpm, yarn, bun, deno, or mutates files.

## Migration Notes

Schema v16 changes the Milvus partition key from `authority` to `pack_id` and
migrates the dense vector dimension from 384 to 1024. The indexer recreates the
catalog on schema drift; existing queue/staged ingestion will repopulate global
content with `pack_id="global"`.

Schema v17 adds agentic enrichment columns for SynPack retrieval.
