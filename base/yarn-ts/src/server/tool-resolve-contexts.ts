import type { AuthUser } from "../auth.js";
import type { KnowledgeResolveContext } from "../state/knowledge-search.js";
import { WEB_SEARCH_TOOL_NAME, type WebSearchResolveContext } from "../state/web-search.js";
import { getBearerToken } from "./internal-auth.js";

export function knowledgeResolveContext(
  authUser: AuthUser,
  req: { headers: { authorization?: string } },
): KnowledgeResolveContext {
  return {
    orgId: authUser.orgId,
    userId: authUser.userId,
    tenantIds: authUser.tenantIds,
    bearerToken: getBearerToken(req.headers.authorization),
  };
}

export function webSearchResolveContext(
  authUser: AuthUser,
  req: { headers: { authorization?: string } },
  args: {
    requestId?: string;
    sessionKey?: string;
    conversationId?: string;
    traceId?: string;
    sourceSurface?: "yarn_chat" | "yarn_mcp_http";
    toolName?: string;
  } = {},
): WebSearchResolveContext {
  return {
    orgId: authUser.orgId,
    userId: authUser.userId,
    tenantIds: authUser.tenantIds,
    bearerToken: getBearerToken(req.headers.authorization),
    requestId: args.requestId,
    sessionKey: args.sessionKey,
    conversationId: args.conversationId,
    traceId: args.traceId,
    sourceSurface: args.sourceSurface ?? "yarn_chat",
    toolName: args.toolName ?? WEB_SEARCH_TOOL_NAME,
  };
}
