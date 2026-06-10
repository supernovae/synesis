# Web Search Provenance Runbook

This runbook describes how `synesis_web_search` attribution flows across Planner, Yarn, MCP, and Admin.

## Contract

All callers should use Planner `POST /v1/web/search` with the same attribution fields:

- `query`, `profile`
- `source_surface` (`yarn_chat`, `yarn_mcp_http`, `openwebui_planner`, `planner_internal`, `external_api`)
- `tool_name`
- `request_id`, `session_key`, `conversation_id`, `trace_id`
- `caller_org_id`, `caller_user_id`, `caller_tenant_ids`

Planner returns:

- `results`
- `timings`
- `attribution_echo`
- `policy` (`allow`, `deny`, `degraded`)

## Where To Query In Admin

Use `GET /api/v1/integrations/web-search/log` with filters:

- `source_surface`
- `org_id`
- `user_id`
- `session_key`
- `request_id`
- `trace_id`
- `tool_name`
- `engine`
- `outcome`

The Admin `web_search_log` rows now include:

- identity: `org_id`, `user_id`, `tenant_id`
- request/session tracing: `request_id`, `session_key`, `conversation_id`, `trace_id`
- source: `source_surface`, `tool_name`
- policy/accounting ready fields: `query_hash`, `rate_bucket_key`, `blocked_reason`, `policy_action`, `token_estimate`

## Cross-Service Correlation

1. Start with a `request_id` or `trace_id` from Yarn/Planner logs.
2. Filter Admin web search log by `request_id` or `trace_id`.
3. Validate source path with `source_surface`:
   - `yarn_chat` for in-chat tool use
   - `yarn_mcp_http` for MCP HTTP calls
   - `openwebui_planner` for planner-internal retrieval from OpenWebUI traffic

## Planner → Admin: when the log is empty

Successful SearXNG calls still need a **Postgres DSN** on planner-ts for rows to appear under **Admin → Integrations → Web Search**. Persistence runs in the web-search observer (`setWebSearchObserver` in planner) and is a no-op if `SYNESIS_PLANNER_TS_ADMIN_DB_URL` is unset.

The reference deployment wires this from the `synesis-admin-db-url` secret (`admin-url` key); see [`base/planner-ts/deployment.yaml`](../../base/planner-ts/deployment.yaml). If web search works (HTTP 200 from `POST /v1/web/search`) but the Admin log is always empty, confirm that env var is present in the live planner-ts Deployment.

## Claude Code vs Synesis `synesis_web_search`

**Claude Code’s built-in “Web Search”** (transcript lines like `Web Search("…")` / approval prompts) is an **Anthropic client-side** capability. It does **not** invoke Planner, SearXNG, or Synesis MCP, and it will not produce rows in the Admin web search log.

**Synesis-backed web search** is exposed as MCP tools **`synesis_web_search`** and **`web_search`** (same handler). Typical paths:

- **Streamable MCP** (`synesis-mcp`) or **Yarn** `POST /v1/mcp/tools/call` — attribution defaults include `source_surface: yarn_mcp_http` unless the client passes overrides.
- **OpenAI-compatible chat** on Yarn: when `SYNESIS_YARN_WEB_SEARCH_ENABLED` is true and the request is **non-streaming**, Yarn can inject `synesis_web_search` and execute a server-side tool loop (Planner → SearXNG).

The **Anthropic `POST /v1/messages`** path on Yarn does **not** currently inject or execute server-side `synesis_web_search` (no tool-result loop there). For SearXNG-backed search from Claude Code over HTTPS, configure **MCP** so the model calls `synesis_web_search` / `web_search`, or use the OpenAI chat path where server-side web search is enabled.

See also [Claude Code compatibility](../claude_code_compat.md) (MCP vs tool-search policy) and [HTTPS-first clients](ACP_HTTP_CLIENTS.md).
