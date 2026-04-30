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

## Staged Builds

Use staged commands for recoverable large builds:

```bash
python -m app.cli --mode synpack --synpack-command prepare-language \
  --language go --pack-id go-latest --work-dir /tmp/synesis-packs/go-latest

python -m app.cli --mode synpack --synpack-command enrich-language \
  --language go --pack-id go-latest --work-dir /tmp/synesis-packs/go-latest \
  --batch-size 250 --max-requests 7500 --concurrency 6

python -m app.cli --mode synpack --synpack-command finalize-language \
  --language go --pack-id go-latest --work-dir /tmp/synesis-packs/go-latest \
  --output dist/synpacks/go-latest.synpack
```

Use `--estimate-costs-only` after prepare/staging when you want a grounded cost
estimate from extracted chunks before spending enrichment tokens.

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
