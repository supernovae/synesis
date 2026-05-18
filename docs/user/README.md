# User Guide

Connect your IDE, terminal, or chat client to Synesis.

## Quick start

1. **Get a Personal Access Token (PAT)**: ask your admin to create one from the Admin UI under **Tokens**.
2. **Set the endpoint**: your planner URL (e.g. `https://api.example.com/v1`).
3. **Configure your client** — see the [Clients Guide](../clients/CLIENTS.md) for IDE-specific instructions.

## Supported clients

| Client | Protocol | Setup |
|--------|----------|-------|
| Open WebUI | OpenAI Chat Completions | Built-in; login via Keycloak |
| Cursor / VS Code | OpenAI Chat Completions | Set `OPENAI_API_BASE` and `OPENAI_API_KEY` (PAT) |
| Claude Code | Anthropic Messages | Configure Yarn endpoint as provider |
| Codex CLI | OpenAI Chat Completions | `export OPENAI_API_BASE=<yarn-url>/v1` |
| MCP clients | Streamable HTTP | Connect to `<mcp-url>/mcp` with PAT as Bearer |

## Authentication

All API calls require a Bearer token. Use either:

- A **PAT** (`syn-...`) for personal access (recommended for IDE/CLI use).
- An **internal service token** for service-to-service calls (admin-managed).

Tokens without explicit scopes are denied by default. Request appropriate scopes from your admin:

- `model:readonly` — chat completions
- `coder:execute` — Yarn coding endpoints
- `chat:read` — read-only chat access

## Rate limits

Services enforce per-user rate limits. If you receive HTTP 429, wait for the `Retry-After` header duration. Contact your admin if you need higher limits.

## Troubleshooting

- **401 Unauthorized**: check that your PAT is valid and not expired.
- **403 Forbidden**: your token may lack the required scope, or FGA authorization is denied.
- **429 Too Many Requests**: you've hit a rate limit; back off and retry.
- **502 Bad Gateway**: the backend service may be restarting; retry after a few seconds.
