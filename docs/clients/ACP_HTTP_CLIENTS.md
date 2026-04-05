# Synesis clients: HTTPS first (no ACP subprocess)

These clients integrate with Synesis **coder** using **HTTPS** and an **API key** (Anthropic-compatible `POST /v1/messages` or OpenAI-compatible `POST /v1/chat/completions`). You do **not** need **`synesis-yarn-acp`** unless you explicitly want an ACP stdio bridge for another tool.

Typical HTTPS-first tools include **Claude Code**, **Cursor**, **VS Code** extensions (Continue, Cline, Copilot-compatible setups), and **Roo Code**. Setup follows the same base URL and PAT pattern as [Claude Code on coder](CLAUDECODE.md); use each product’s UI to set **API base URL** / **override endpoint** and **API key**.

## Environment pattern

- **Base URL**: `https://<your-coder-host>` (no `/v1`).
- **Auth**: Synesis PAT with **`coder`** scope (`x-api-key` or provider-specific token field).
- **Model**: Tier names such as `synesis-pulse`, `synesis-core`, `synesis-horizon` where supported.

## When to use ACP instead

Use [ACP_SYNESIS.md](ACP_SYNESIS.md) and the per-editor ACP pages (**Zed**, **JetBrains**, **OpenCode**, **Neovim**) when the tool only speaks **Agent Client Protocol** over stdio, not raw HTTPS.

## Cloudflare

See [Cloudflare Edge Hardening](../CLOUDFLARE_EDGE_HARDENING.md) for WAF, tunnels, and HTTPS behavior. ACP subprocesses still call the same **`SYNESIS_YARN_URL`** over HTTPS from your machine.

## Tool results and debugging

Workspace MCP tools such as `run_build`, `run_test`, and `run_lint` return **structured fields** (`summary`, `errorLines`, `errors`, `nextActions`, capped `stdout`/`stderr`) so models can target fixes without pasting full logs. For **complete** command output (e.g. long `go test` traces), rely on the **client transcript** or local terminal where the agent ran the command—server logs may not include every byte of stderr. Use request/correlation IDs from responses when correlating with Yarn logs.

For Claude/OpenAI session stalls tied to tool-call resume history, use the Yarn upstream diagnostics playbook in [Claude Code Compatibility](../claude_code_compat.md#upstream-error-playbook-vercel-ai-sdk).
