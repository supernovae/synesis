# Synesis + Zed (Agent Client Protocol)

Zed can integrate with agents that implement **ACP** over stdio. Use the Synesis bridge **`synesis-yarn-acp`** so Zed talks to your deployed **Synesis coder** (`yarn-ts`) over HTTPS.

## Prerequisites

- [ACP overview and env vars](ACP_SYNESIS.md)
- Zed version that supports external ACP agents (check Zed docs for “Agent Client Protocol” or “external agent”).

## Install the bridge

Build once (see [ACP_SYNESIS.md](ACP_SYNESIS.md)):

```bash
cd base/yarn-ts && npm install && npm run build
```

Note the path to `dist/acp/synesis-yarn-acp.js`.

## Configure Zed

Point Zed’s agent configuration at the **Node** process running the bridge. Exact keys depend on Zed’s release; typically you specify:

- **Command**: `node`
- **Args**: full path to `synesis-yarn-acp.js`
- **Environment** (inherited or set in Zed settings):

```bash
SYNESIS_YARN_URL=https://coder.example.com
SYNESIS_YARN_TOKEN=<your-pat>
# optional:
SYNESIS_YARN_MODEL=synesis-core
# optional — ask the coder for extended thinking (tier must support it):
# SYNESIS_YARN_ACP_ENABLE_THINKING=true
# optional — hide reasoning in the ACP transcript (default shows it when returned):
# SYNESIS_YARN_ACP_INCLUDE_REASONING=false
```

Use your real **HTTPS** coder hostname (same as [CLAUDECODE.md](CLAUDECODE.md)); do not append `/v1`.

## Experience

- User prompts in Zed are forwarded to Yarn; assistant text streams back as ACP chunks.
- **Tool calls** from the model appear as ACP tool updates; your Zed/ACP client is responsible for executing tools and sending results on the next turn.
- **Structured clarification** and **completion gate** behavior match the HTTP API; see [SYNESIS_CLARIFICATION.md](SYNESIS_CLARIFICATION.md) and [CANARY_PROMPT_PACK.md](CANARY_PROMPT_PACK.md) for testing.

## Troubleshooting

- **401 / 403**: PAT missing `coder` scope or wrong `SYNESIS_YARN_URL`.
- **Connection refused**: Coder not reachable from your machine; check VPN, Cloudflare, and [edge docs](../CLOUDFLARE_EDGE_HARDENING.md).
- **No output**: Confirm `node` path and that `npm run build` produced `dist/acp/synesis-yarn-acp.js`.
