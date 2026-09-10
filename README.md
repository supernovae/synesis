# Synesis

[![Knowledge checks](https://github.com/supernovae/synesis/actions/workflows/knowledge.yml/badge.svg)](https://github.com/supernovae/synesis/actions/workflows/knowledge.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Portable source packs and local knowledge tools for chat and coding clients.**

Synesis packages selected documents and code into versioned source archives, indexes them locally, and exposes search and source reads through MCP. Results carry source revisions, checksums and citations. Your client continues to own model calls, planning, execution and approvals.

The local CLI and MCP reader work without a running Synesis deployment, model credentials or a database service. They use Node.js and an embedded SQLite index. This is the first implemented part of the [architecture redesign](docs/ARCHITECTURE_REVIEW.md); shared hosting and broader retrieval-quality evaluation remain separate work.

[Quick start](#try-it) · [Source packs](docs/SOURCE_PACKS.md) · [Connect a client](docs/clients/MCP_QUICKSTART.md) · [Design decisions](docs/ARCHITECTURE_REVIEW.md) · [Contribute](CONTRIBUTING.md)

## Try it

Use Node.js **24.14 or newer**. From a checkout:

```bash
npm ci --ignore-scripts --workspace=@synesis/mcp --include-workspace-root=false
npm run build
npm run synesis -- build examples/source-pack/pack.json \
  --root examples/source-pack --output /tmp/synesis-example.synpack
npm run synesis -- import /tmp/synesis-example.synpack --library /tmp/synesis-example-library
npm run synesis -- search readPinnedSource \
  --library /tmp/synesis-example-library --pack synesis-example --version 1.0
```

The example includes one small source file. Output files are created privately and never overwrite an existing file; choose another output path when repeating a build. Reimporting identical content is harmless. A changed pack needs a new version.

For your own content, write a [build configuration](docs/SOURCE_PACKS.md#build-a-pack) with explicit files, revision, attribution and license. Source archives are private by default. No files are discovered automatically from your home directory or the client's working directory.

## Connect through MCP

Configure a stdio MCP server using your client's supported settings:

```json
{
  "mcpServers": {
    "synesis": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/synesis/packages/synesis-mcp/dist/cli.js",
        "mcp",
        "--library",
        "/absolute/path/to/private-library"
      ]
    }
  }
}
```

Clients differ in their configuration structure; the executable and arguments are the contract. See [MCP setup](docs/clients/MCP_QUICKSTART.md). For MCP, invoke the CLI directly so npm's command banners cannot enter the protocol stream.

| Tool | Purpose |
| --- | --- |
| `knowledge_packs` | Discover installed pack versions and provenance. |
| `knowledge_sources` | Browse source paths within an exact version. |
| `knowledge_search` | Find bounded evidence using words, paths or annotated symbols. |
| `knowledge_read` | Read original source text, with citations and a continuation offset. |

Every search/read selects an explicit pack and version. The MCP tools are read-only; building, importing, exporting and deleting packs are explicit CLI operations.

## Scope and boundaries

- **The library is local and private to its OS user.** Every source in the configured library is accessible to that MCP client. Use separate libraries for separate client trust boundaries. Hosted multi-tenant authorization is not implemented by this reader.
- **Sources remain inspectable.** Packs contain source text and metadata, with a rebuildable SQLite index. They contain no model weights, required embeddings or generated context cards.
- **Retrieval is lexical.** Exact names and paths work well for navigation; paraphrases, multilingual questions and complex research need evaluation. No task-success improvement or hallucination prevention is guaranteed.
- **Integrity is not trust.** Checksums detect changed content. They do not establish the publisher's identity, validate a claim or make source instructions safe to execute.
- **Model compatibility stays with the native client and endpoint.** Synesis does not rewrite transcripts, discount context windows by model family or add another planning loop.
- **Offline use needs installed dependencies and available packs.** Pack operations themselves make no network or model calls. Your chosen client/model may have separate network requirements.

The CLI also supports validation, export, deletion, index rebuilding and consistent local backups. See [storage and recovery](docs/SOURCE_PACKS.md#storage-and-recovery). Node's built-in SQLite API is still evolving; the supported runtime range is exercised in CI rather than inferred from a model or client name.

## Development status

The prior multi-service deployment was shut down because of operating cost. The Planner-backed MCP entry point has been replaced with the local reader; it no longer consumes `SYNESIS_URL`, `SYNESIS_PAT` or a broad remote tool catalog. Existing Planner/Yarn and infrastructure code remains in the repository for capability extraction and removal. It is not a dependency of the new package or a second supported mode of its CLI.

The [decision record](docs/ARCHITECTURE_REVIEW.md) tracks completed work, remaining boundaries and the stopping points for a pack-only product or retirement. The project does not currently offer a hosted service or claim universal model/harness parity.

A [public capability trial](evals/architecture/README.md#public-capability-trial) confirms that Git snapshots and an existing filesystem MCP server already cover offline versioned reads and reuse across working directories. Synesis's combined search/version/citation interface remains a convenience to evaluate in real work, not a demonstrated retrieval or model-quality advantage.

```bash
npm run build
npm test
```

Tests exercise real SQLite operations and an MCP client/server subprocess, including immutable versions, malformed packs, source-root confinement, Unicode reads, backup/restore and shutdown. They do not establish live model quality or large-corpus capacity.

Code for the new core lives in [packages/synesis-mcp](packages/synesis-mcp/). Improvements to source formats, retrieval evals and client integration are welcome. See [contributing](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Source packs retain their own attribution, licensing and redistribution declarations.
