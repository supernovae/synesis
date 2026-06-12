# Synesis Content Packs

Synesis packs are portable graph-aware knowledge bundles for NornicDB-backed
RAG. They are useful to humans because they keep source inventory, versioning,
and summaries together; they are useful to agents because they include graph
nodes, relationships, embeddings, temporal metadata, and enrichment hints.

## Pack Format

A pack is a ZIP archive containing:

- `manifest.json` — pack identity, source version, graph schema version,
  embedding model/profile, checksums, build metadata, and language/domain.
- `sources.lock.json` — source repositories, tags, URLs, checksums, and fetch
  settings.
- `nodes/*.jsonl` — typed graph nodes for NornicDB-native import.
- `edges/*.jsonl` — typed deterministic or validated relationships.
- `vectors/chunks.f32` and `vectors/index.json` — dense chunk embeddings.
- `enrichment/enrichment.jsonl` — source-grounded enrichment payloads.
- `quality/report.json` — pack validation and utility metrics.

SynPack v2 is the only supported content-pack format. Importers reject legacy
flat packs that do not include `nodes/chunks.jsonl` and vector sidecars.

Required node fields:

- `id`
- `pack`
- `pack_version`
- `source_version`
- `kind`
- `text`
- `source_url`
- `path`
- `language`
- `content_type`
- `retrieval_terms`
- `query_aliases`
- `task_intents`

Common temporal fields:

- `commit`
- `branch`
- `valid_from`
- `valid_to`
- `source_release`
- `upstream_commit`
- `upstream_tag`
- `deprecated`
- `deprecation_status`
- `replacement_api`

Common symbol fields:

- `symbol_fqn`
- `symbol_name`
- `symbol_kind`
- `package_name`

Supported edge types:

- `CONTAINS`
- `DEFINES`
- `CALLS`
- `IMPORTS`
- `REFERENCES`
- `OVERRIDES`
- `IMPLEMENTS`
- `DOCUMENTS`
- `HAS_CONSTRAINT`
- `HAS_EXAMPLE`
- `HAS_PATTERN`
- `HAS_CONTEXT_CARD`
- `APPLIES_TO`
- `DEPRECATED_BY`
- `REPLACED_BY`
- `WARNS_ABOUT`
- `RELATED_TO`
- `VALID_IN`
- `DERIVED_FROM`
- `HAS_FIELD`
- `REQUIRES`
- `VALIDATED_BY`
- `MANAGED_BY`
- `OWNS`
- `CONFLICTS_WITH`

Typed node kinds:

- `Document`
- `Package`
- `Module`
- `Chunk`
- `Symbol`
- `Concept`
- `Pattern`
- `Constraint`
- `Example`
- `ContextCard`
- `PackCard`
- `ExternalRef`
- `EvalCase`
- `ResourceKind`
- `ApiGroupVersion`
- `SchemaProperty`
- `PlatformConstraint`
- `PlatformCommand`
- `ValidationRecipe`
- `RiskPattern`

First-class graph edges must not dangle. Unresolved imports, calls, or
out-of-pack symbols are represented as `ExternalRef` nodes so graph traversal
stays complete and debuggable.

## Retrieval Model

Packs are loaded into the NornicDB content graph. Retrieval uses:

1. pack resolution by library/language/package/symbol/version
2. exact symbol/package lookup
3. vector search over chunk/example/card/pattern nodes
4. bounded graph expansion over semantic edges
5. version/freshness filtering and warnings
6. answer-ready context bundles for planner, Yarn, and MCP callers

Runtime APIs:

- `POST /v1/knowledge/resolve-pack` returns installed pack candidates with
  source version, freshness/trust/quality, and node/example/card counts.
- `POST /v1/knowledge/bundle` returns context cards, examples,
  anti-patterns, related symbols, source chunks, and freshness warnings.
- `POST /v1/knowledge/search` accepts `mode=bundle|cards` for clients still
  using the older route name, but bundle retrieval is the preferred behavior.

## Enrichment

Deterministic extractors own authoritative relationships. Enrichment prompts
may emit summaries, lifecycle notes, usage patterns, safety contracts, and
candidate edges with confidence/source spans. Candidate edges are stored as
metadata unless validated by deterministic extraction.

SynPack v2 enrichment also asks for agent-ready fields that can be surfaced to
small models and MCP callers without shipping large markdown chunks:

- `task_intents`
- `query_aliases`
- `api_contract`
- `version_scope`
- `performance_notes`
- `anti_patterns`
- `canonical_examples`
- `anti_examples`
- `agent_query_hints`
- `verification_hints`
- `related_interfaces`
- `related_symbols`
- `agent_actions`
- `confidence`
- `evidence_spans`

The final pack materializer turns these into `Concept`, `Pattern`,
`Constraint`, `Example`, and `ContextCard` nodes plus relationship edges. This is the main
advantage over markdown-only retrieval systems: the pack can return dense
agent cards, safety contracts, navigation hints, and source-backed graph
neighbors from the same artifact.

`PackCard` is the versioned cross-domain card contract. It preserves the
existing `ContextCard` shape for callers, but adds pack-level topic, intent,
claims, constraints, evidence refs, freshness, provenance, and taxonomy domain
metadata. Bundle retrieval prefers `PackCard` nodes when present and falls back
to `ContextCard` or source-derived cards for older packs.

## Quality Gates

Finalized v2 packs include quality metrics in `quality/report.json` and
manifest summaries:

- node and edge counts by kind/type
- enrichment coverage and fallback count
- example, context-card, anti-pattern, and constraint counts
- unresolved edge count
- external reference count
- dangling edge count after materialization

All content packs load through the SynPack v2 bulk importer. The old slow Bolt
row-by-row path is no longer used for admin-managed content-pack installs.

DeepSeek V4 Pro is the default pack enrichment model. The builder sends
`X-DeepSeek-Think-Mode: Max`, uses `deepseek-v4-pro`, sets `reasoning_effort`
to `max`, and keeps `max_tokens` at least `8192`.

Custom OpenAI-compatible enrichment providers are supported with
`--enrichment-provider openai-compatible`, `--enrichment-url`, and
`--enrichment-token`. The URL may be a provider root, a `/v1` base URL, or a
full `/v1/chat/completions` endpoint. Tokens can also come from
`SYNESIS_INDEXER_ENRICHMENT_API_KEY` or `SYNESIS_INDEXER_ENRICHMENT_TOKEN`;
DeepSeek defaults continue to read `DEEPSEEK_TOKEN` or `DEEPSEEK_API_KEY`.

Chunks rescued for retrieval with `source_quality_score=0.0` are kept in the
pack but use deterministic fallback enrichment by default, avoiding LLM calls
for content the gate already judged as having no enrichment value. Pass
`--enrich-zero-quality` only when you explicitly want those chunks sent to the
enrichment provider.

## Staged Builds

Use `scripts/synpack-helper.py` for recoverable large builds. The helper can be
run from the repository root, stores each pack in `.work/synpacks/<pack-id>`
(already gitignored), runs the indexer from the correct directory, sets
`UV_CACHE_DIR`, and refuses to reuse a work directory whose staged manifest
belongs to another language or pack id.

### Supported Language/Domain Pack Values

`synpack-helper.py` currently supports the following explicit SynPack
parameters:

| `--language` value | Default pack id | Pack config | Coverage |
| --- | --- | --- | --- |
| `bash` | `bash-latest` | `base/rag/pack-configs/bash.yaml` | Bash, ShellCheck rules, Google shell style guide, Bash reference docs, defensive Bash patterns, Pure Bash Bible |
| `ecma` | `ecma-latest` | `base/rag/pack-configs/ecma.yaml` | JavaScript, TypeScript, TC39 proposals, TypeScript handbook, Node.js, Bun, Deno, MDN web platform docs |
| `go` | `go-latest` | `base/rag/pack-configs/go.yaml` | Go language/runtime docs and source package context from `golang/go` |
| `godot` | `godot-latest` | `base/rag/pack-configs/godot.yaml` | Godot engine docs, class reference, scene tree, shaders, proposals, and Godot docs |
| `python` | `python-latest` | `base/rag/pack-configs/python.yaml` | CPython stdlib/docs, PEPs, packaging, uv, pixi, typeshed, Flask/Werkzeug/Jinja, PyTorch/data-science docs where configured |
| `quarkus` | `quarkus-latest` | `base/rag/pack-configs/quarkus.yaml` | Quarkus guides, CLI, runtime source roots, extensions, and platform BOM context |
| `rust` | `rust-latest` | `base/rag/pack-configs/rust.yaml` | Rust std/core/alloc docs, error codes, Reference, Nomicon, async book, Book, Cargo book, Rust by Example, edition guide |
| `terraform` | `terraform-latest` | `base/rag/pack-configs/terraform.yaml` | Terraform docs, provider docs/schemas, OpenTofu docs, TFLint rulesets for AWS/Azure/GCP |

Use `ecma` for JavaScript and TypeScript packs:

```bash
./scripts/synpack-helper.py prepare --language ecma
./scripts/synpack-helper.py enrich --language ecma --request-limit 1000 \
  --enrichment-url https://api.deepseek.com/v1 \
  --enrichment-model deepseek-v4-pro \
  --enrichment-token-env DEEPSEEK_TOKEN
./scripts/synpack-helper.py finalize --language ecma \
  --embedder-url http://localhost:8082/v1
```

The helper also accepts comma-separated values and `all`:

```bash
./scripts/synpack-helper.py status --language python,go,ecma
./scripts/synpack-helper.py prepare --language all
```

`all` expands to:

```text
go,rust,quarkus,python,godot,terraform,ecma,bash
```

Platform SynPack configs also exist under `base/rag/pack-configs/platform/`:

- `devops-tooling`
- `gitops`
- `kubernetes`
- `observability`
- `openshift`

Those are platform pack configs, not accepted `synpack-helper.py --language`
values today. Build them through the lower-level SynPack path with
`--pack-config` while the helper remains focused on language/domain packs.

```bash
./scripts/synpack-helper.py prepare --language python

./scripts/synpack-helper.py enrich --language python \
  --enrichment-url https://api.deepseek.com/v1 \
  --enrichment-model deepseek-v4-pro \
  --enrichment-token-env DEEPSEEK_TOKEN \
  --request-limit 1000

./scripts/synpack-helper.py status --language python

./scripts/synpack-helper.py finalize --language python \
  --embedder-url http://localhost:8082/v1
```

For a full remaining enrichment run, pass `--confirm-spend` instead of
`--request-limit`. This is intentionally explicit because enrichment can spend
large token volumes. To generate deterministic fallback enrichments without
model calls, use `--skip-enrichment`.

Generate all supported language packs with the same safety rails:

```bash
./scripts/synpack-helper.py prepare --language all
./scripts/synpack-helper.py enrich --language all \
  --enrichment-url https://api.deepseek.com/v1 \
  --enrichment-model deepseek-v4-pro \
  --enrichment-token-env DEEPSEEK_TOKEN \
  --request-limit 1000
./scripts/synpack-helper.py finalize --language all \
  --embedder-url http://localhost:8082/v1
```

The lower-level staged indexer commands are still available when debugging:

```bash
python -m app.cli --mode synpack --synpack-command prepare-language \
  --language go --pack-id go-latest --work-dir .work/synpacks/go-latest

python -m app.cli --mode synpack --synpack-command enrich-language \
  --language go --pack-id go-latest --work-dir .work/synpacks/go-latest \
  --batch-size 250 --request-limit 7500 --enrichment-concurrency 6

python -m app.cli --mode synpack --synpack-command finalize-language \
  --language go --pack-id go-latest --work-dir .work/synpacks/go-latest \
  --output dist/synpacks/go-latest.synpack \
  --embedder-url http://localhost:8082/v1 \
  --embedder-batch-size 8 \
  --embedder-timeout 300
```

Use `--estimate-cost-only` after prepare/staging when you want a grounded cost
estimate from extracted chunks before spending enrichment tokens.

## Local Embedder

SynPack finalization needs a Text Embeddings Inference endpoint for dense
vectors. The Synesis RAG schema uses `BAAI/bge-m3`, so local embedding
containers should serve that same model.

CPU x86_64:

```bash
docker run --rm --name synesis-embedder \
  -p 8082:8080 \
  -v "$HOME/.cache/huggingface:/data" \
  -e HF_HOME=/data/hf \
  -e HUGGINGFACE_HUB_CACHE=/data \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.9 \
  --model-id=BAAI/bge-m3 \
  --port=8080 \
  --max-concurrent-requests=128 \
  --max-client-batch-size=32
```

CPU ARM64:

```bash
docker run --rm --name synesis-embedder \
  --platform linux/arm64 \
  -p 8082:8080 \
  -v "$HOME/.cache/huggingface:/data" \
  -e HF_HOME=/data/hf \
  -e HUGGINGFACE_HUB_CACHE=/data \
  ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9 \
  --model-id=BAAI/bge-m3 \
  --port=8080 \
  --max-concurrent-requests=128 \
  --max-client-batch-size=32
```

DGX Spark / Blackwell 12.1:

```bash
docker run --rm --name synesis-embedder \
  --gpus all \
  -p 8082:8080 \
  -v "$HOME/.cache/huggingface:/data" \
  -e HF_HOME=/data/hf \
  -e HUGGINGFACE_HUB_CACHE=/data \
  ghcr.io/huggingface/text-embeddings-inference:121-latest \
  --model-id=BAAI/bge-m3 \
  --port=8080 \
  --max-concurrent-requests=128 \
  --max-client-batch-size=32
```

Use `http://localhost:8082/v1` as the `--embedder-url` for local SynPack
finalization. `121-latest` is the currently published DGX Spark image tag in
the GitHub Container Registry; if Hugging Face publishes a versioned
`121-<version>` tag, prefer that for repeatable builds.

## Rust Pack

The Rust language pack uses the staged SynPack v2 workflow and is optimized for
graph-aware retrieval in NornicDB. It indexes official Rust sources from:

- `rust-lang/rust`: `std`, `core`, `alloc`, and rustc `E0xxx` error docs
- `rust-lang/reference`: language semantics and edition behavior
- `rust-lang/nomicon`: unsafe Rust, layout, aliasing, FFI, and soundness
- `rust-lang/async-book`: futures, pinning, wakeups, cancellation, and runtimes
- `rust-lang/book`: general Rust ownership, projects, and idioms
- `rust-lang/cargo`: Cargo workspaces, manifests, features, lockfiles, profiles, and commands
- `rust-lang/rust-by-example`: runnable examples mapped into retrieval examples
- `rust-lang/edition-guide`: edition migration and Rust 2024 behavior

The builder emits Rust-specific symbol FQNs such as `std::String`, typed
metadata for compiler diagnostics and edition rules, query aliases, task
intents, verification hints, examples, anti-patterns, and constraints so
NornicDB can materialize chunk, symbol, concept, pattern, constraint, example,
context-card, and edge sidecars.

## Language Pack V2 Coverage

All curated code-language prompts now target the same SynPack v2 enrichment
contract. Go, Rust, Python, Quarkus, Godot, Terraform/OpenTofu,
ECMA/JavaScript/TypeScript, and Bash/Shell prompts ask for graph-ready task intents, query
aliases, API contracts, version scope, performance notes, examples,
anti-patterns, verification hints, related symbols/interfaces, agent actions,
evidence spans, and context-card fields. During finalization these fields are
used to build NornicDB-native `Concept`, `Pattern`, `Constraint`, `Example`,
and `ContextCard` nodes plus typed relationship edges.

The Bash/Shell pack is optimized for safe script generation by small models. It
indexes ShellCheck rules as exact `SC####` symbols, style guidance, Bash
reference material, defensive scripting patterns, pure-Bash idioms, and script
function examples. Its prompts emphasize quoting, word splitting, arrays,
`"$@"`, `read -r`, `mktemp`, traps, strict-mode boundaries, command safety, and
the developer feedback loop: `bash -n`, `shellcheck -x`, `shfmt -d`, and
fixture or Bats/ShellSpec tests.

## Platform Packs

Platform packs are SynPack v2 builds for operational platforms rather than
programming languages. They use `platform_pack.py`, platform configs, and
platform prompts so language-pack extraction stays focused on code languages.

Current platform configs live under `base/rag/pack-configs/platform/`:

- `openshift.yaml` — OpenShift-first pack with Kubernetes as a base layer.
- `kubernetes.yaml` — upstream Kubernetes API and workflow foundation.
- `gitops.yaml`, `observability.yaml`, `devops-tooling.yaml` — scaffolds for
  future rich packs.

The OpenShift pack structurally parses OpenAPI/CRD-style schemas and emits
first-class NornicDB graph nodes:

- `ResourceKind`: `Pod`, `Deployment`, `Route`, `SecurityContextConstraints`
- `ApiGroupVersion`: `apps/v1`, `route.openshift.io/v1`,
  `rbac.authorization.k8s.io/v1`
- `SchemaProperty`: field paths with required/default/deprecated/sensitive
  markers
- `PlatformConstraint`: required fields, immutable selectors, deprecated
  fields, admission/security constraints
- `PlatformCommand`: `kubectl`, `oc`, `helm`, `kustomize`, `argocd`,
  `kubeconform`, `conftest`
- `ValidationRecipe`: dry-run, diff, RBAC, SCC, schema, and policy checks
- `RiskPattern`: privileged pods, hostPath, wildcard RBAC, unsafe SCC,
  route TLS mismatch, public exposure, destructive stateful changes

Direct OpenShift build:

```bash
python -m app.cli --mode synpack --synpack-command build-platform \
  --platform openshift \
  --pack-id openshift-latest \
  --output dist/synpacks/openshift-latest.synpack \
  --embedder-url http://localhost:8082/v1
```

Estimate enrichment cost without model or embedding calls:

```bash
python -m app.cli --mode synpack --synpack-command build-platform \
  --platform openshift \
  --pack-id openshift-latest \
  --estimate-cost-only
```

Recoverable staged OpenShift build:

```bash
python -m app.cli --mode synpack --synpack-command prepare-platform \
  --platform openshift \
  --pack-id openshift-latest \
  --work-dir .work/synpacks/openshift-latest

python -m app.cli --mode synpack --synpack-command enrich-platform \
  --work-dir .work/synpacks/openshift-latest \
  --batch-size 250 \
  --request-limit 7500 \
  --enrichment-concurrency 6

python -m app.cli --mode synpack --synpack-command finalize-platform \
  --work-dir .work/synpacks/openshift-latest \
  --output dist/synpacks/openshift-latest.synpack \
  --embedder-url http://localhost:8082/v1 \
  --embedder-batch-size 8 \
  --embedder-timeout 300
```

For offline development and tests, the default OpenShift config includes small
local fixture specs under `base/rag/indexer/fixtures/platform/`. For production
packs, replace or extend `openapi_specs`, `docs`, and `cli_docs` in the
platform config with pinned official Kubernetes/OpenShift API specs, docs, and
CLI references. Keep `source_version` pinned for reproducible builds. Pass
`--pack-config /path/to/openshift.yaml` when building from a custom config.

Useful platform-pack searches after loading:

```bash
python -m app.cli --mode synpack --synpack-command search \
  --query "OpenShift route TLS passthrough" \
  --pack-id openshift-latest \
  --nornic-uri bolt://localhost:7687

python -m app.cli --mode synpack --synpack-command search \
  --query "why is my deployment selector immutable" \
  --pack-id openshift-latest \
  --nornic-uri bolt://localhost:7687

python -m app.cli --mode synpack --synpack-command search \
  --query "service account can-i create pods" \
  --pack-id openshift-latest \
  --nornic-uri bolt://localhost:7687
```

```bash
python -m app.cli --mode synpack --synpack-command prepare-language \
  --language rust --pack-id rust-latest --work-dir .work/synpacks/rust-latest

python -m app.cli --mode synpack --synpack-command enrich-language \
  --language rust --pack-id rust-latest --work-dir .work/synpacks/rust-latest \
  --batch-size 250 --request-limit 7500 --enrichment-concurrency 6

python -m app.cli --mode synpack --synpack-command finalize-language \
  --language rust --pack-id rust-latest --work-dir .work/synpacks/rust-latest \
  --output dist/synpacks/rust-latest.synpack \
  --embedder-url http://localhost:8082/v1 \
  --embedder-batch-size 8 \
  --embedder-timeout 300
```

Example custom provider:

```bash
python -m app.cli --mode synpack --synpack-command enrich-language \
  --work-dir .work/synpacks/go-latest \
  --enrichment-provider openai-compatible \
  --enrichment-url https://provider.example/v1 \
  --enrichment-token "$SYNESIS_INDEXER_ENRICHMENT_TOKEN" \
  --enrichment-model deepseek/deepseek-v3.2
```

## Loading And Search

```bash
python -m app.cli --mode synpack --synpack-command load \
  --synpack dist/synpacks/go-latest.synpack \
  --nornic-uri bolt://localhost:7687

python -m app.cli --mode synpack --synpack-command search \
  --query "http server timeout" \
  --pack-id go-latest \
  --nornic-uri bolt://localhost:7687
```
