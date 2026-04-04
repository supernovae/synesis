# Synesis + OpenCode (ACP)

[OpenCode](https://opencode.ai) can run agents via **`acp`** (Agent Client Protocol). Use **`synesis-yarn-acp`** to connect OpenCode to your **Synesis coder** (`yarn-ts`) deployment.

## Prerequisites

- [ACP overview and env vars](ACP_SYNESIS.md)
- OpenCode CLI installed and `opencode acp` (or equivalent) available per upstream docs.

## Build the bridge

```bash
cd base/yarn-ts && npm install && npm run build
```

## OpenCode configuration

Register the Synesis bridge as an ACP provider. The exact file format follows OpenCode’s schema; typically you specify:

- **Type**: `acp` or external command (per OpenCode version).
- **Command**: `node`
- **Args**: path to `base/yarn-ts/dist/acp/synesis-yarn-acp.js`
- **Env**:

```bash
SYNESIS_YARN_URL=https://coder.example.com
SYNESIS_YARN_TOKEN=<your-pat>
SYNESIS_YARN_MODEL=synesis-core   # optional
```

Replace the URL with your real coder HTTPS origin (no `/v1` suffix).

## Experience

- OpenCode drives the session; the bridge maps ACP `prompt` to Yarn `POST /v1/chat/completions` and streams assistant text to the ACP client as chunks.
- **Tools**: Model-proposed tools appear as ACP `tool_call` updates; OpenCode must execute and return results according to its ACP flow.
- For HTTP-based OpenCode profiles (if supported), you can alternatively point at `https://coder.example.com` with Anthropic-compatible headers — see [CLAUDECODE.md](CLAUDECODE.md) for header patterns.

## Troubleshooting

- **Binary not found**: Use absolute path to `node` and the built `synesis-yarn-acp.js`.
- **401**: Regenerate PAT with `coder` scope.
- **CORS / edge**: Browser-based OpenCode UIs use HTTPS; subprocess ACP only needs outbound HTTPS to `SYNESIS_YARN_URL` ([Cloudflare](../CLOUDFLARE_EDGE_HARDENING.md)).
