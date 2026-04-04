# Synesis + JetBrains IDEs (Agent Client Protocol)

JetBrains products can connect to **ACP**-compatible agents for coding assistance. The Synesis bridge **`synesis-yarn-acp`** lets the IDE spawn a subprocess that forwards requests to **Synesis coder** (`yarn-ts`) over HTTPS.

## Prerequisites

- [ACP overview and env vars](ACP_SYNESIS.md)
- JetBrains build that documents **Agent Client Protocol** or “external agent” integration (check JetBrains AI / Junie / plugin release notes for your IDE).

## Install the bridge

```bash
cd base/yarn-ts && npm install && npm run build
```

Use the generated `dist/acp/synesis-yarn-acp.js` path in the configuration below.

## Configure the IDE

In the JetBrains settings for **external agent** or **ACP** (wording varies by product):

1. Set the **agent command** to your `node` binary.
2. Set **arguments** to the absolute path of `synesis-yarn-acp.js`.
3. Set **environment variables** for the agent process:

| Variable | Example |
|----------|---------|
| `SYNESIS_YARN_URL` | `https://coder.example.com` |
| `SYNESIS_YARN_TOKEN` | Synesis PAT with `coder` scope |
| `SYNESIS_YARN_MODEL` | `synesis-core` (optional) |

`SYNESIS_CODER_URL` may be used instead of `SYNESIS_YARN_URL`.

## Experience

- Chat and inline prompts go to Yarn via the Messages API; responses stream as ACP notifications.
- **Tool execution** is handled by the JetBrains side per ACP; ensure allowed tools match your org policy.
- For **HTTPS-only** setups (no ACP), point the built-in HTTP client at the same base URL as [CLAUDECODE.md](CLAUDECODE.md).

## Troubleshooting

- **SSL errors**: Corporate proxies may require trust store configuration; same as any HTTPS client to your coder host.
- **Timeout**: Long generations may hit IDE-side timeouts; increase if your product exposes such a setting.
- **Path issues**: Use absolute paths to `node` and `synesis-yarn-acp.js` on Windows (WSL vs native Node).
