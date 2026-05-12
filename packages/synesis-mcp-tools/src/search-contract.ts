import type { SynesisMcpAuth } from "./auth-types.js";

export const SEARCH_SOURCE_SURFACES = [
  "yarn_chat",
  "yarn_mcp_http",
  "openwebui_planner",
  "planner_internal",
  "external_api",
] as const;

export type SearchSourceSurface = (typeof SEARCH_SOURCE_SURFACES)[number];

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

export function buildSearchAttributionBody(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  defaultSurface: SearchSourceSurface,
  toolName: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    source_surface: optionalString(args.source_surface) ?? defaultSurface,
    tool_name: optionalString(args.tool_name) ?? toolName,
  };

  const requestId = optionalString(args.request_id);
  if (requestId) body.request_id = requestId;
  const sessionKey = optionalString(args.session_key);
  if (sessionKey) body.session_key = sessionKey;
  const conversationId = optionalString(args.conversation_id);
  if (conversationId) body.conversation_id = conversationId;
  const traceId = optionalString(args.trace_id);
  if (traceId) body.trace_id = traceId;

  if (auth.orgId) body.caller_org_id = auth.orgId;
  if (auth.userId) body.caller_user_id = auth.userId;
  if (auth.tenantIds?.length) body.caller_tenant_ids = [...auth.tenantIds];
  if (auth.aclGroups?.length) body.caller_acl_groups = [...auth.aclGroups];

  return body;
}
