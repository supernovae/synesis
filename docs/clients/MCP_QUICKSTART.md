# Connect the local Synesis MCP reader

Build and import a [source pack](../SOURCE_PACKS.md) first. The MCP reader requires an existing absolute library path and Node.js 24.14 or newer. Only the local library and runtime are required.

From the repository root:

```bash
npm run build
node packages/synesis-mcp/dist/cli.js mcp --library /absolute/private-library
```

The process waits for MCP JSON-RPC on stdin. No startup banner is written to stdout; diagnostics use stderr. A client normally launches and closes this process itself. Use the executable directly, not `npm run`, for MCP transport.

For clients using an `mcpServers` configuration object:

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

Adapt the configuration structure to the client. The command/arguments and MCP stdio protocol are the integration contract; this example is not a claim that every client's settings use identical keys. Absolute executable, script and library paths keep behavior independent of the client's cwd or project root. Do not change the client's model endpoint or install a Synesis execution hook for this reader.

## Available tools

| Tool | Inputs and behavior |
| --- | --- |
| `knowledge_packs` | Paged discovery with `offset` and `limit`; returns installed immutable versions. |
| `knowledge_sources` | `pack`, `version` and pagination; lists evidence paths and checksums. |
| `knowledge_search` | `pack`, `version`, `query`, optional `limit`; lexical/path/symbol retrieval. |
| `knowledge_read` | `pack`, `version`, `path`, optional `offset` and `length`; recoverable source reads with citations. |

All four tools are read-only and use bounded closed schemas. Build/import/export/delete/backup are CLI operations, not model-callable tools. Unknown arguments cannot supply another library or filesystem root. The client owns native tools, model behavior, execution and approvals.

## Private libraries and limits

A configured client can read every installed source in that library. Give separate client trust boundaries separate library directories. POSIX directories/files must be private to their OS user. A library's source data can still be transmitted to the client's chosen model provider; decide that separately from storage locality.

Pack metadata and source text remain untrusted data. MCP annotations describe tool behavior, not the safety of instructions found in a document. Model behavior and conversation context are client-owned.

The implementation is tested with the official MCP SDK client over a real subprocess, including negotiation, tool calls, argument rejection, different cwd and shutdown. It has not been certified against every named harness/version. This package supplies local stdio; clients requiring an HTTP-only endpoint cannot connect directly.
