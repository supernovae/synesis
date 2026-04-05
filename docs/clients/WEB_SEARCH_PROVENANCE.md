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

