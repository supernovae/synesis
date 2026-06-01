# Synesis MCP Quickstart

Synesis MCP gives your IDE and agent harness direct access to your
organization's knowledge graph, SynPack bundles, multi-corpus search, and
developer safety tooling through the
[Model Context Protocol](https://modelcontextprotocol.io/).

## What you get

| Tool | What it does |
|------|-------------|
| `synesis_search` | Graph-native RAG retrieval against your Synesis content graph with pack, symbol, temporal, and graph-expansion filters. |
| `synesis_resolve_pack` | Resolve an installed SynPack v2 by library, language, package, or symbol. Returns pack IDs, source versions, quality/trust/freshness scores. |
| `synesis_context_bundle` | Answer-ready context bundles: cards, examples, anti-patterns, related symbols, freshness warnings, and quality signals. |
| `synesis_code_search` | Search the indexed code corpus. |
| `synesis_docs_search` | Search the indexed documentation corpus. |
| `synesis_web_search` | Web search with provenance and attribution. |
| `synesis_patch_integrity` | Deterministic safety checks on code and patches (secrets, egress, path traversal, dangerous commands). |

Set `SYNESIS_TOOLS=all` to enable additional tools: `synesis_classify`,
`synesis_plan`, `synesis_critique`, `synesis_config_search`,
`synesis_terraform_plan_analyze`, `synesis_ecma_environment_check`,
`synesis_ecma_package_risk_analyze`.

## Prerequisites

1. A running Synesis deployment with the planner backend accessible.
2. Either a **Personal Access Token (PAT)** with the `mcp:invoke` scope, or a Synesis OIDC access token issued to client `synesis-harness`.

### Creating a PAT

1. Open the Synesis Admin UI.
2. Navigate to **Settings > Personal Access Tokens**.
3. Click **Create Token**.
4. Give it a descriptive name (e.g. "Cursor MCP").
5. Select the `mcp:invoke` scope.
6. Copy the token (`syn-...`). You will not be able to see it again.

---

## Option A: Local stdio server (recommended)

Install `@synesis/mcp` via npm. Your IDE spawns it as a subprocess and
communicates over stdio.

### Cursor

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "synesis": {
      "command": "npx",
      "args": ["-y", "@synesis/mcp"],
      "env": {
        "SYNESIS_URL": "https://synesis.company.com",
        "SYNESIS_PAT": "syn-your-token-here"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Create or edit `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "synesis": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@synesis/mcp"],
      "env": {
        "SYNESIS_URL": "https://synesis.company.com",
        "SYNESIS_PAT": "syn-your-token-here"
      }
    }
  }
}
```

### JetBrains (AI Assistant)

1. Open **Settings > Tools > AI Assistant > MCP Servers**.
2. Add a new server:
   - **Name**: Synesis
   - **Type**: stdio
   - **Command**: `npx`
   - **Arguments**: `-y @synesis/mcp`
3. Set environment variables:
   - `SYNESIS_URL` = your Synesis URL
   - `SYNESIS_PAT` = your PAT

### Programmatic / SDK

```typescript
import { createSynesisMcpServer } from "@synesis/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createSynesisMcpServer({
  url: "https://synesis.company.com",
  pat: process.env.SYNESIS_PAT!,
  allTools: false,  // set true for the full tool set
});

await server.connect(new StdioServerTransport());
```

---

## Option B: Hosted Streamable HTTP (enterprise)

For managed deployments where a centralized MCP endpoint is preferred,
point your IDE at the hosted service URL.

Hosted MCP accepts both PATs and OIDC bearer JWTs when the deployment has `SYNESIS_OIDC_ISSUER_URL` configured.

For OIDC-capable harnesses such as Pi:

- Discovery URL: `https://<keycloak-host>/realms/synesis/.well-known/openid-configuration`
- Client ID: `synesis-harness`
- Client secret: none
- Flow: Authorization Code + PKCE (`S256`) or Device Authorization Grant
- Required role in the token: `synesis-user`, `synesis-org-admin`, or `synesis-admin`

Use the resulting access token as the HTTP bearer token:

```http
Authorization: Bearer <oidc-access-token>
```

### Cursor

```json
{
  "mcpServers": {
    "synesis": {
      "url": "https://mcp.company.com/mcp",
      "headers": {
        "Authorization": "Bearer syn-your-token-here"
      }
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "synesis": {
      "type": "http",
      "url": "https://mcp.company.com/mcp",
      "headers": {
        "Authorization": "Bearer syn-your-token-here"
      }
    }
  }
}
```

---

## Configuration reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNESIS_URL` | Yes | Base URL of your Synesis planner backend. |
| `SYNESIS_PAT` | Yes for local stdio | Personal access token with `mcp:invoke` scope. |
| `SYNESIS_TOOLS` | No | Set to `all` to enable all tools including niche/advanced. |

---

## Troubleshooting

**"SYNESIS_URL is required"** — Set the `SYNESIS_URL` environment variable in
your MCP server configuration.

**"SYNESIS_PAT is required"** — Create a PAT in the Synesis Admin UI with the
`mcp:invoke` scope and set it as the `SYNESIS_PAT` environment variable.

**Tools return `knowledge_search_failed` or `web_search_failed`** — The planner
backend is not reachable from the MCP server. Verify `SYNESIS_URL` is correct
and that the planner health endpoint (`/health`) responds.

**"Insufficient scope for MCP access"** (hosted only) — The PAT does not have
the `mcp:invoke` or `coder` scope, or the OIDC token is missing an accepted Synesis role. Regenerate the PAT with the correct scope or assign `synesis-user` in Keycloak realm `synesis`.

**"Invalid OIDC bearer token"** (hosted only) — The token signature, issuer, client, expiry, or required role failed validation. Confirm the harness is using realm `synesis`, client `synesis-harness`, and the exact issuer configured on hosted MCP.

**Rate limit errors (429)** — The hosted MCP enforces per-route rate limits.
Wait for the `Retry-After` header duration before retrying.

---

## Updating

The `npx -y @synesis/mcp` approach always pulls the latest published version.
To pin a specific version:

```json
{
  "args": ["-y", "@synesis/mcp@0.1.0"]
}
```
