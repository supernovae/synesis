# Source packs and local libraries

The local Synesis CLI builds portable source packs and serves an embedded SQLite library over MCP stdio. It does not call a model or require the former Planner/Yarn platform. The implementation is [@synesis/mcp](../packages/synesis-mcp/); its command is `synesis`.

From a checkout, build with `npm run build` and run commands as `npm run synesis -- ...`. A packaged installation provides the `synesis` executable. No new npm release is claimed by these instructions.

## Build a pack

A build config explicitly identifies the evidence and its provenance:

```json
{
  "id": "project-guide",
  "version": "2026.09.10",
  "title": "Project guide",
  "sourceRevision": "commit-or-source-revision",
  "attribution": "The source authors",
  "license": "License identifier or rights statement",
  "files": [
    "docs/guide.md",
    { "path": "src/config.ts", "symbols": ["parseConfig"] }
  ]
}
```

```bash
synesis build pack.json --root /absolute/project --output ./project-guide.synpack
synesis validate ./project-guide.synpack
synesis import ./project-guide.synpack --library /absolute/private-library
```

`--root` is mandatory. Files use relative POSIX paths and must be regular files inside that root. Symlinked inputs beneath the resolved root, traversal paths, invalid UTF-8 and NUL-containing content are rejected. The explicit file list prevents accidental recursive collection; it is not a secret scanner. Select and review content before sharing it. Local collection assumes the source filesystem is controlled by the invoking user; it is not an isolation boundary against another process racing filesystem changes.

UTF-8 source bytes, including line endings and a BOM when present, are preserved. Empty files are valid. `symbols` are optional publisher annotations, not an AST parser's proof of a definition. An optional per-source `url` must use HTTP(S) without embedded username/password. Locators are recorded, never fetched automatically.

`redistribution` defaults to `private`. Set it to `permitted` only when you have the right to distribute the included sources. The field records a declaration; it does not establish authorization or enforce DRM. All output archives use private file permissions, including packs declared redistributable. Publishing an archive or changing its file permissions is a separate deliberate action.

## Format and identity

A `.synpack` is gzip-compressed canonical UTF-8 JSON with `format: "synesis.source-pack"` and `formatVersion: 1`. Its schema includes the build metadata, sorted source records and a pack digest. Each source includes `path`, `text`, `sha256`, `symbols` and optional `url`.

The digest is SHA-256 of the canonical JSON payload excluding the digest field. Object keys are sorted lexicographically; arrays retain order, source records are sorted by path, and JSON has no extra whitespace. This rejects duplicate JSON keys and ambiguous serialization. The same validated source/config payload has the same identity; gzip bytes are reproducible with the same build runtime, not promised identical across all zlib versions.

Each `(id, version)` is immutable within a library. Identical imports are idempotent; different content or metadata under the same version is an error. There is no implicit `latest` alias. Discovery lists versions; the client selects one explicitly.

This is a fresh source-pack contract. Old graph/vector SynPack ZIPs and architecture-experiment archives are rejected. Rebuild selected original sources using the new builder; there is no conversion or migration command. A SQLite file is never an importable pack.

Limits are enforced before or during input reads/decompression: 32 MiB compressed archive, 64 MiB uncompressed JSON, 2 MiB per source and 5,000 sources per pack. Build-config input is limited to 1 MiB. These bound individual operations, not total library disk usage or all future capacity requirements.

The schema and validation are in [pack.ts](../packages/synesis-mcp/src/pack.ts). Checksums detect altered content; publisher authentication, source accuracy and prompt-injection resistance are separate concerns.

## Search and read

```bash
synesis packs --library /absolute/private-library
synesis sources --library /absolute/private-library --pack project-guide --version 2026.09.10
synesis search parseConfig --library /absolute/private-library --pack project-guide --version 2026.09.10
synesis read --library /absolute/private-library --pack project-guide --version 2026.09.10 \
  --path src/config.ts --offset 0 --length 8000
```

Search combines exact path/symbol matches with SQLite FTS5 over overlapping source windows. Natural-language search uses up to 32 distinct Unicode word terms joined by OR, with FTS ranking; it is not semantic similarity search. Terms containing punctuation are tokenized. Arbitrary SQL or FTS operators are not accepted as a query language. Results remain restricted to the selected pack version.

Reads return text, original source revision/checksum, pack digest, attribution, license, optional URL, line numbers and a `synpack:` citation identifier. Citation path segments are percent-encoded so punctuation in filenames cannot change the locator. A citation is a source locator, not a web link or correctness certificate. `offset` and `length` count Unicode code points, not bytes or JavaScript UTF-16 units. Follow `nextOffset` until it is null to recover the remainder, including long individual lines.

Search returns at most ten excerpts of 2,800 characters each; direct reads allow at most 16,000 characters. Pack/source listing supports `offset`/`limit` and returns `nextOffset`. Tool arguments are closed schemas; a client cannot inject a new filesystem root, library, principal or endpoint.

## Storage and recovery

The library directory must be absolute and private to the local OS user (0700 directory, 0600 files on POSIX). Windows ACLs are not configured or validated automatically; the operator must restrict access there. Synesis creates a new library on import. MCP and read commands open an existing library read-only and never build an index at startup. No process needs to stay running between uses.

The directory contains `library.sqlite` and SQLite-managed WAL/SHM files when needed. Use local disk, not a shared network filesystem. Imports and deletions use transactions; SQLite serializes writers with a bounded busy timeout. There is no distributed writer, horizontal replica or hosted ACL contract here. See [SQLite deployment guidance](https://www.sqlite.org/whentouse.html).

```bash
synesis export --library /absolute/private-library --pack project-guide --version 2026.09.10 \
  --output ./exported.synpack
synesis rebuild --library /absolute/private-library
synesis backup --library /absolute/private-library --output ./backup.sqlite
synesis delete --library /absolute/private-library --pack project-guide --version 2026.09.10
```

Export validates a consistent source snapshot. `rebuild` reconstructs FTS indexes from stored sources. Pack output and backup publication refuse overwrite and expose only completed output files. `backup` uses SQLite's backup API so a live WAL is handled consistently; do not copy only the main database while writers are active.

To restore a trusted local backup, stop readers/writers, create a fresh private directory and place the backup there as `library.sqlite` with private permissions. Open that directory with the CLI. Alternatively, create a fresh library by importing retained source archives. Only the current library schema is accepted; there are no upgrade/migration paths.

Deletion removes active pack records and indexed evidence. A minimal ID/version/digest record remains so a previously used version cannot be reassigned to different content. Reimporting that same content is allowed. Deletion cannot revoke exported archives, external backups or a client's prior copies, and is not a promise of forensic secure erasure. Keep private outputs outside version control and apply your device's backup/encryption/retention policy.

The reader uses [Node's built-in SQLite API](https://nodejs.org/api/sqlite.html), with extension loading disabled, defensive settings and parameterized statements. That API is still evolving. CI checks Node 24 and 26; no extra native database add-on or database daemon is required.

## Client access boundary

Every source in a configured library is available to that MCP client. Use a separate library for every required local access boundary; the client cannot widen access through tool arguments. Private source data may still be sent by the client to its configured model provider. Choosing a local reader does not make an independently hosted model private or offline.

Hosted shared retrieval, external identity, per-document/group/session grants, connector refresh jobs and authorized downloads are separate architecture work. Do not expose this stdio reader as an unauthenticated network service or treat a library path as multi-tenant authorization. See [MCP setup](clients/MCP_QUICKSTART.md) and [the decision record](ARCHITECTURE_REVIEW.md).
