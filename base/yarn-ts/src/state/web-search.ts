/**
 * WebSearchService — server-side planner-backed web search via shared `@synesis/mcp-tools`.
 */

import { dispatchSynesisTool, type SynesisMcpDeps, type SynesisMcpAuth } from "@synesis/mcp-tools";

export const WEB_SEARCH_TOOL_NAME = "synesis_web_search";
export const WEB_SEARCH_TOOL_ALIAS = "web_search";

const WEB_SEARCH_DESCRIPTION =
  "Search the public web via Synesis planner-backed retrieval. " +
  "Default behavior returns snippets only (token-efficient). " +
  "Use AFTER synesis_knowledge_search or search_developer_docs when the catalog lacks the answer or you need very fresh sources. " +
  "Avoid fetch_pages unless snippets are insufficient — full page text is large and costly in context.";

const WEB_SEARCH_PARAMETERS = {
  type: "object" as const,
  properties: {
    query: { type: "string", description: "Web search query." },
    profile: { type: "string", enum: ["web", "code"], description: "Search profile (web or code)." },
    top_k: { type: "integer", description: "Maximum number of results to return (1-20)." },
    fetch_pages: {
      type: "boolean",
      description:
        "If true, fetches and returns full page bodies (high token cost). Default omit/false: use search snippets only. " +
        "Set true only when snippets are inadequate.",
    },
    max_fetch_pages: {
      type: "integer",
      description: "Cap on full-page fetches when fetch_pages is true (keep low to limit context size).",
    },
    min_relevance: { type: "number", description: "Minimum relevance threshold in [0,1]." },
    preferred_domains: {
      type: "array",
      items: { type: "string" },
      description: "Optional preferred domains for ranking policy.",
    },
  },
  required: ["query"],
};

export const WEB_SEARCH_TOOL_SCHEMA_OPENAI = {
  type: "function" as const,
  function: {
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: WEB_SEARCH_PARAMETERS,
  },
};

export const WEB_SEARCH_TOOL_SCHEMA_CLAUDE = {
  name: WEB_SEARCH_TOOL_NAME,
  description: WEB_SEARCH_DESCRIPTION,
  input_schema: WEB_SEARCH_PARAMETERS,
};

export interface WebSearchResolveContext {
  orgId: string;
  userId: string;
  tenantIds: string[];
  bearerToken: string;
  requestId?: string;
  sessionKey?: string;
  conversationId?: string;
  traceId?: string;
  sourceSurface?: "yarn_chat" | "yarn_mcp_http";
  toolName?: string;
}

export class WebSearchService {
  private searchCount = 0;
  private errorCount = 0;

  constructor(private readonly deps: SynesisMcpDeps) {}

  async resolve(
    args: Record<string, unknown>,
    context?: WebSearchResolveContext,
  ): Promise<Record<string, unknown>> {
    this.searchCount++;
    const bearer = context?.bearerToken?.trim() || this.deps.internalServiceToken?.trim() || "";
    const auth: SynesisMcpAuth = {
      bearerToken: bearer,
      userId: context?.userId ?? "",
      orgId: context?.orgId ?? "",
      tenantIds: context?.tenantIds ?? [],
    };

    const requestArgs: Record<string, unknown> = {
      ...args,
      source_surface: context?.sourceSurface ?? "yarn_chat",
      tool_name: context?.toolName ?? WEB_SEARCH_TOOL_NAME,
    };
    if (context?.requestId) requestArgs.request_id = context.requestId;
    if (context?.sessionKey) requestArgs.session_key = context.sessionKey;
    if (context?.conversationId) requestArgs.conversation_id = context.conversationId;
    if (context?.traceId) requestArgs.trace_id = context.traceId;

    try {
      const raw = await dispatchSynesisTool(WEB_SEARCH_TOOL_NAME, requestArgs, auth, this.deps);
      const parsed = raw as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        this.errorCount++;
      }
      return parsed;
    } catch {
      this.errorCount++;
      return {
        query: String(args.query ?? ""),
        total: 0,
        results: [],
        error: "request_failed",
      };
    }
  }

  injectToolOpenAI(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools) return [WEB_SEARCH_TOOL_SCHEMA_OPENAI];
    const exists = (tools as Array<{ function?: { name?: string } }>).some(
      (t) => t.function?.name === WEB_SEARCH_TOOL_NAME,
    );
    if (exists) return tools;
    return [...tools, WEB_SEARCH_TOOL_SCHEMA_OPENAI];
  }

  injectToolClaude(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools) return [WEB_SEARCH_TOOL_SCHEMA_CLAUDE];
    const exists = (tools as Array<{ name?: string }>).some((t) => t.name === WEB_SEARCH_TOOL_NAME);
    if (exists) return tools;
    return [...tools, WEB_SEARCH_TOOL_SCHEMA_CLAUDE];
  }

  getStats() {
    return {
      searchCount: this.searchCount,
      errorCount: this.errorCount,
    };
  }
}

