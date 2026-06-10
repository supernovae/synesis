# OpenCode With Synesis Coder

Use this guide to connect OpenCode to the Synesis **coder frontend** (`yarn-ts`).

Synesis supports two OpenCode paths:

- **ACP bridge**: OpenCode starts `synesis-yarn-acp` over stdio. This is the recommended editor/agent integration when your OpenCode version supports ACP.
- **OpenAI-compatible HTTPS**: OpenCode talks directly to `POST /v1/chat/completions` with an API base URL and key. This is useful for `opencode run`, eval harnesses, and versions configured as an OpenAI-compatible provider.

## Prerequisites

- A reachable Synesis coder host, for example `https://coder.example.com`.
- A Synesis PAT with the `coder` scope for HTTPS or ACP requests.
- OpenCode installed locally.
- Node.js 24+ when using the checked-in ACP bridge.

## Option 1: ACP Bridge

Build the bridge:

```bash
cd base/yarn-ts
npm install
npm run build
```

Configure OpenCode to run the bridge as an ACP provider. OpenCode's config schema can vary by release, but the values should map to:

| Setting | Value |
|---------|-------|
| Provider type | `acp` or external command, depending on your OpenCode version |
| Command | `node` |
| Args | `/absolute/path/to/synesis/base/yarn-ts/dist/acp/synesis-yarn-acp.js` |
| Environment | See below |

Environment for the ACP bridge:

```bash
SYNESIS_YARN_URL=https://coder.example.com
SYNESIS_YARN_TOKEN=<synesis-pat-with-coder-scope>
SYNESIS_YARN_MODEL=synesis-core
```

Optional ACP bridge settings:

```bash
SYNESIS_YARN_ACP_ENABLE_THINKING=true
SYNESIS_YARN_ACP_INCLUDE_REASONING=false
```

Use a base URL with no `/v1` suffix for `SYNESIS_YARN_URL`. The bridge calls Yarn's OpenAI-compatible API internally and maps ACP prompts, tool calls, and filesystem RPCs into the Synesis coder session.

For per-editor ACP details, see [ACP_SYNESIS.md](ACP_SYNESIS.md) and [ACP_OPENCODE.md](ACP_OPENCODE.md).

## Option 2: OpenAI-Compatible HTTPS

Use this when OpenCode is configured as an OpenAI-compatible client or when running `opencode run`.

Common environment shape:

```bash
export OPENAI_BASE_URL="https://coder.example.com/v1"
export OPENAI_API_KEY="<synesis-pat-with-coder-scope>"
export OPENCODE_MODEL="synesis-core"
```

Run shape used by the Synesis eval harness:

```bash
opencode run \
  --model synesis-core \
  --session my-synesis-session \
  --prompt-file ./prompt.md
```

If your OpenCode version uses a provider config file instead of environment variables, enter the same values:

| Provider Field | Value |
|----------------|-------|
| API base URL | `https://coder.example.com/v1` |
| API key | Synesis PAT with `coder` scope |
| Model | `synesis-core`, `synesis-pulse`, or `synesis-horizon` |
| Chat endpoint | `/chat/completions` under the base URL |

## Models

Yarn exposes these client-facing coder tiers:

| Model | Use |
|-------|-----|
| `synesis-pulse` | Fast, low-cost coding tasks. |
| `synesis-core` | Default balanced coder tier. |
| `synesis-horizon` | Larger or higher-risk coding tasks. |

Model discovery is available at:

```bash
curl -sS \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  "https://coder.example.com/v1/models"
```

## Workspace Context

OpenCode often includes environment lines such as `Working directory:` and `Workspace root folder:` in the prompt. Yarn can parse those as fallback context, but explicit metadata or headers are more reliable when your integration layer can send them.

For OpenAI-compatible HTTPS clients, send flat metadata when possible:

```json
{
  "metadata": {
    "synesis_project_root": "/home/alex/src/project",
    "synesis_shell_cwd": "/home/alex/src/project",
    "synesis_client_model_label": "OpenCode"
  }
}
```

See [SESSION_EXECUTION_CONTEXT.md](SESSION_EXECUTION_CONTEXT.md) for the full contract.

## Tool Behavior

OpenCode uses native tool names and schemas. Yarn adds OpenCode-specific guidance when the request is detected as OpenCode, including:

- Use exact OpenCode tool names rather than aliases from other agent APIs.
- Use OpenCode `todowrite` with `id`, `content`, `status`, and `priority` on each todo item.
- Keep file paths anchored to the known workspace context to avoid duplicated path segments.

## Verification

Check model discovery:

```bash
curl -sS \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  "https://coder.example.com/v1/models" | jq .
```

Check a minimal OpenAI-compatible request:

```bash
curl -sS "https://coder.example.com/v1/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "synesis-core",
    "messages": [{"role": "user", "content": "Reply with OK."}],
    "stream": false
  }' | jq .
```

## Troubleshooting

**401 Unauthorized**: Regenerate a Synesis PAT with the `coder` scope. For ACP, confirm `SYNESIS_YARN_TOKEN` is set. For HTTPS, confirm `OPENAI_API_KEY` is set.

**404 or endpoint not found**: For ACP, `SYNESIS_YARN_URL` should be the host only, for example `https://coder.example.com`. For OpenAI-compatible HTTPS, `OPENAI_BASE_URL` should include `/v1`.

**OpenCode rejects tool calls**: Confirm Yarn detects the request as OpenCode. If using a custom proxy, preserve the OpenCode user agent or add a stable client hint such as `x-synesis-client: opencode`.

**Path duplication such as `repo/repo/file`**: Send explicit session execution context metadata or headers, or verify OpenCode is including `Working directory:` and `Workspace root folder:` lines that Yarn can parse.
