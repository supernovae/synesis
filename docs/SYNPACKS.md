# Synesis Content Packs

Synesis packs are portable graph-aware knowledge bundles for NornicDB-backed
RAG. They are useful to humans because they keep source inventory, versioning,
and summaries together; they are useful to agents because they include graph
nodes, relationships, embeddings, temporal metadata, and enrichment hints.

## Pack Format

A pack is a ZIP archive containing:

- `manifest.json` — pack identity, source version, graph schema version,
  embedding model/profile, checksums, build metadata, and language/domain.
- `nodes.jsonl` — one graph node per line.
- `edges.jsonl` — deterministic or validated graph relationships.
- `sources.lock.json` — source repositories, tags, URLs, checksums, and fetch
  settings.
- optional `vectors.npy` — dense embeddings matching `nodes.jsonl` order.
- optional `graph.stats.json` and `enrichment.jsonl`.

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

Common temporal fields:

- `commit`
- `branch`
- `valid_from`
- `valid_to`

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
- `VALID_IN`
- `DERIVED_FROM`

## Retrieval Model

Packs are loaded into the NornicDB content graph. Retrieval uses:

1. vector seed search over file/chunk/symbol nodes
2. graph expansion over semantic edges
3. temporal/version filtering
4. reranking and authority boosts
5. structured context returned to planner/MCP callers

## Enrichment

Deterministic extractors own authoritative relationships. Enrichment prompts
may emit summaries, lifecycle notes, usage patterns, safety contracts, and
candidate edges with confidence/source spans. Candidate edges are stored as
metadata unless validated by deterministic extraction.

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

Use staged commands for recoverable large builds:

```bash
python -m app.cli --mode synpack --synpack-command prepare-language \
  --language go --pack-id go-latest --work-dir /tmp/synesis-packs/go-latest

python -m app.cli --mode synpack --synpack-command enrich-language \
  --language go --pack-id go-latest --work-dir /tmp/synesis-packs/go-latest \
  --batch-size 250 --request-limit 7500 --enrichment-concurrency 6

python -m app.cli --mode synpack --synpack-command finalize-language \
  --language go --pack-id go-latest --work-dir /tmp/synesis-packs/go-latest \
  --output dist/synpacks/go-latest.synpack
```

Use `--estimate-cost-only` after prepare/staging when you want a grounded cost
estimate from extracted chunks before spending enrichment tokens.

Example custom provider:

```bash
python -m app.cli --mode synpack --synpack-command enrich-language \
  --work-dir /tmp/synesis-packs/go-latest \
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
