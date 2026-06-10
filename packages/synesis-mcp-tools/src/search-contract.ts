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

const SEARCH_SOURCE_SURFACE_SET = new Set<string>(SEARCH_SOURCE_SURFACES);
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SESSION_KEY_RE = /^[A-Za-z0-9_.:@/-]{1,256}$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9_.:@/-]{1,256}$/;
const TRACE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function optionalString(v: unknown, pattern: RegExp, maxChars: number, fieldName: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.length > maxChars || !pattern.test(s)) {
    throw new Error(`invalid_search_attribution_${fieldName}`);
  }
  return s;
}

function normalizeSourceSurface(value: SearchSourceSurface | undefined, fallback: SearchSourceSurface): SearchSourceSurface {
  if (value === undefined) return fallback;
  if (!SEARCH_SOURCE_SURFACE_SET.has(value)) {
    throw new Error("invalid_search_attribution_source_surface");
  }
  return value;
}

export function buildSearchAttributionBody(
  attribution: SearchAttributionInput | undefined,
  auth: SynesisMcpAuth,
  defaultSurface: SearchSourceSurface,
  defaultToolName: string,
): Record<string, unknown> {
  const input = attribution ?? {};
  const body: Record<string, unknown> = {
    source_surface: normalizeSourceSurface(input.sourceSurface, defaultSurface),
    tool_name: optionalString(input.toolName, TOOL_NAME_RE, 128, "tool_name") ?? defaultToolName,
  };

  const requestId = optionalString(input.requestId, REQUEST_ID_RE, 128, "request_id");
  if (requestId) body.request_id = requestId;
  const sessionKey = optionalString(input.sessionKey, SESSION_KEY_RE, 256, "session_key");
  if (sessionKey) body.session_key = sessionKey;
  const conversationId = optionalString(input.conversationId, CONVERSATION_ID_RE, 256, "conversation_id");
  if (conversationId) body.conversation_id = conversationId;
  const traceId = optionalString(input.traceId, TRACE_ID_RE, 128, "trace_id");
  if (traceId) body.trace_id = traceId;

  if (auth.orgId) body.caller_org_id = auth.orgId;
  if (auth.userId) body.caller_user_id = auth.userId;
  if (auth.tenantIds?.length) body.caller_tenant_ids = [...auth.tenantIds];
  if (auth.aclGroups?.length) body.caller_acl_groups = [...auth.aclGroups];

  return body;
}
