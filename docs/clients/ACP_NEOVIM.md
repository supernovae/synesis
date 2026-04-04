# Synesis + Neovim (Avante / CodeCompanion + ACP)

Neovim plugins such as **Avante.nvim** or **CodeCompanion.nvim** can integrate with **Agent Client Protocol** agents when configured to spawn an external process. Use **`synesis-yarn-acp`** to route that traffic to **Synesis coder** (`yarn-ts`).

## Prerequisites

- [ACP overview and env vars](ACP_SYNESIS.md)
- Neovim plugin version that supports **ACP** or “external agent” stdio (check plugin docs).
- Node.js available on `PATH` (or full path in config).

## Build the bridge

```bash
cd base/yarn-ts && npm install && npm run build
```

## Plugin configuration (conceptual)

Exact Lua keys differ by plugin; the pattern is:

```lua
-- Example shape only — replace with your plugin's actual option names
agent = {
  command = "node",
  args = { "/absolute/path/to/synesis/base/yarn-ts/dist/acp/synesis-yarn-acp.js" },
  env = {
    SYNESIS_YARN_URL = "https://coder.example.com",
    SYNESIS_YARN_TOKEN = os.getenv("SYNESIS_YARN_TOKEN"),
    SYNESIS_YARN_MODEL = "synesis-core",
  },
}
```

Prefer reading the token from the environment rather than committing secrets:

```bash
export SYNESIS_YARN_TOKEN="your-pat"
```

## Experience

- Chat buffers send user text through ACP; assistant replies stream into the UI.
- **Tool calls** (file edits, terminal) depend on the plugin’s ACP tool loop; ensure tool permissions match your workflow.
- If the plugin supports **direct HTTP** to Anthropic-compatible endpoints instead, you can point it at `https://coder.example.com` with `x-api-key` / `anthropic-version` as in [CLAUDECODE.md](CLAUDECODE.md) — ACP is optional.

## Troubleshooting

- **Spawn failed**: Check `node` path inside Neovim’s environment (GUI apps on macOS may not inherit shell `PATH`; use full paths).
- **Blank responses**: Verify `SYNESIS_YARN_URL` has no trailing slash and includes `https://`.
- **Logs**: Run the bridge manually in a terminal with the same env to see stderr.
