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
python -m app.cli --mode synpack --synpack-command build-go \
  --sources bootstrap/corpus/lang-go.yaml \
  --pack-id go-latest \
  --output dist/synpacks/go-latest.synpack
```

Validate and load:

```bash
python -m app.cli --mode synpack --synpack-command validate --synpack dist/synpacks/go-latest.synpack
python -m app.cli --mode synpack --synpack-command load --synpack dist/synpacks/go-latest.synpack --replace
```

List and search installed packs:

```bash
python -m app.cli --mode synpack --synpack-command list
python -m app.cli --mode synpack --synpack-command search --pack-id go-latest --query "fmt.Println examples"
```

## Retrieval

Planner and MCP knowledge search now accept pack filters:

- `pack_id` or `pack_ids`
- `pack_version`
- `package_name`
- `symbol_kind`
- `symbol_fqn`

Example:

```json
{
  "query": "HTTP rate limiting example",
  "pack_id": "go-latest",
  "package_name": "net/http",
  "symbol_kind": "example"
}
```

## Migration Notes

Schema v16 changes the Milvus partition key from `authority` to `pack_id` and
migrates the dense vector dimension from 384 to 1024. The indexer recreates the
catalog on schema drift; existing queue/staged ingestion will repopulate global
content with `pack_id="global"`.
