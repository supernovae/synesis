# Synesis local knowledge tools

Build portable source packs and expose a local SQLite library to MCP clients.
Requires Node.js 24.14 or newer with built-in SQLite/FTS5. No model provider,
Planner service, PAT, Python environment or database daemon is required.

The package provides the `synesis` command. Run `synesis --help` for commands.
Build configuration explicitly lists files, pack ID/version, source revision,
attribution and license. Sources stay inside the supplied root. Pack versions are
immutable on import; changed evidence requires a new version.

```bash
synesis build pack.json --root ./sources --output ./manual.synpack
synesis validate ./manual.synpack
synesis import ./manual.synpack --library /absolute/private/library
synesis packs --library /absolute/private/library
synesis mcp --library /absolute/private/library
```

The MCP server exposes `knowledge_packs`, `knowledge_sources`, `knowledge_search`
and `knowledge_read`. These tools are read-only. Every search/read selects an
explicit pack and version; reads provide citations and a continuation offset.
The MCP client owns planning, model calls, tool execution and approvals.

A library belongs to its local OS user. Give each client trust boundary its own
library: every source in the configured library is readable by that client.
Directories/files require private permissions on POSIX. This is not hosted
multi-tenant authorization. Source content remains untrusted data.

Packs are gzip-compressed canonical JSON, not executable code or SQLite files.
Only the source-pack format is accepted. Imports reject corrupt evidence, invalid
paths, unknown fields, duplicate sources and oversized data. A checksum verifies
integrity, not publisher trust or answer correctness. The redistribution field
records the publisher's declaration; it does not implement DRM or revoke copies.

Search uses lexical terms and explicit path/symbol metadata, not embeddings or
an LLM. Natural-language paraphrases and multilingual recall are not guaranteed.
The SQLite index can be rebuilt and sources exported without model calls.

This package is Apache-2.0 licensed. It does not include a model or bundled corpus.
