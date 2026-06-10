import type { SynesisMcpAuth } from "./auth-types.js";

export const SEARCH_SOURCE_SURFACES = [
  "yarn_chat",
  "yarn_mcp_http",
  "openwebui_planner",
  "planner_internal",
  "external_api",
] as const;

export type SearchSourceSurface = (typeof SEARCH_SOURCE_SURFACES)[number];

export interface SearchAttributionInput {
  sourceSurface?: SearchSourceSurface;
  toolName?: string;
  requestId?: string;
  sessionKey?: string;
  conversationId?: string;
  traceId?: string;
}

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

export function buildSearchAttributionBody(
  attribution: SearchAttributionInput | undefined,
  auth: SynesisMcpAuth,
  defaultSurface: SearchSourceSurface,
  defaultToolName: string,
): Record<string, unknown> {
  const input = attribution ?? {};
  const body: Record<string, unknown> = {
    source_surface: input.sourceSurface ?? defaultSurface,
    tool_name: optionalString(input.toolName) ?? defaultToolName,
  };

  const requestId = optionalString(input.requestId);
  if (requestId) body.request_id = requestId;
  const sessionKey = optionalString(input.sessionKey);
  if (sessionKey) body.session_key = sessionKey;
  const conversationId = optionalString(input.conversationId);
  if (conversationId) body.conversation_id = conversationId;
  const traceId = optionalString(input.traceId);
  if (traceId) body.trace_id = traceId;

  if (auth.orgId) body.caller_org_id = auth.orgId;
  if (auth.userId) body.caller_user_id = auth.userId;
  if (auth.tenantIds?.length) body.caller_tenant_ids = [...auth.tenantIds];
  if (auth.aclGroups?.length) body.caller_acl_groups = [...auth.aclGroups];

  return body;
}
