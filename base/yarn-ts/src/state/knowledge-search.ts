/**
 * KnowledgeSearchService — bridges Yarn to MCP-TS for RAG corpus retrieval.
 *
 * Follows the ArtifactRetrievalService pattern:
 *   - injectToolOpenAI/Claude: adds synesis_knowledge_search to the LLM tool list
 *   - resolve(): calls MCP-TS to execute the search
 *   - Can be used in Yarn's server-side tool resolution loop
 */

export const KNOWLEDGE_TOOL_NAME = "synesis_knowledge_search";

const KNOWLEDGE_DESCRIPTION =
  "Search the Synesis knowledge catalog for relevant documentation, code examples, " +
  "language specifications, error catalogs, linter rules, style guides, and architecture " +
  "patterns. Returns ranked chunks with provenance, authority, and constraint metadata. " +
  "Use when you need grounded evidence from organizational knowledge or curated technical references.";

const KNOWLEDGE_PARAMETERS = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description: "Search query describing what knowledge to find",
    },
    language: {
      type: "string",
      description: "Filter by programming language (e.g. python, typescript, go, rust)",
    },
    artifact_kind: {
      type: "string",
      description: "Filter by artifact type: code, docs, config, api_spec, architecture",
    },
    scope_tags: {
      type: "array",
      items: { type: "string" },
      description:
        "Filter by purpose tags: error-catalog, linter-rules, language-spec, style-guide, testing-framework, package-tooling, build-tooling",
    },
    constraint_kind: {
      type: "string",
      description: "Filter by constraint trust level: hard (specs/compiler), guiding (best practice), advisory (community)",
      enum: ["hard", "guiding", "advisory"],
    },
    top_k: {
      type: "integer",
      description: "Number of results to return (default 5, max 20)",
    },
  },
  required: ["query"],
};

export const KNOWLEDGE_TOOL_SCHEMA_OPENAI = {
  type: "function" as const,
  function: {
    name: KNOWLEDGE_TOOL_NAME,
    description: KNOWLEDGE_DESCRIPTION,
    parameters: KNOWLEDGE_PARAMETERS,
  },
};

export const KNOWLEDGE_TOOL_SCHEMA_CLAUDE = {
  name: KNOWLEDGE_TOOL_NAME,
  description: KNOWLEDGE_DESCRIPTION,
  input_schema: KNOWLEDGE_PARAMETERS,
};

export interface KnowledgeSearchResult {
  results: Array<{
    text: string;
    source_url: string;
    document_name: string;
    authority: string;
    score: number;
    constraint_kind: string;
    corpus_class: string;
    scope_tags: string[];
    language: string;
    context_prefix: string;
    chunk_summary: string;
  }>;
  query: string;
  total: number;
}

export class KnowledgeSearchService {
  private searchCount = 0;
  private errorCount = 0;

  constructor(
    private readonly mcpServiceUrl: string,
    private readonly callerOrgId?: string,
    private readonly callerUserId?: string,
  ) {}

  async resolve(
    args: Record<string, unknown>,
    callerOverrides?: { orgId?: string; userId?: string; aclGroups?: string[] },
  ): Promise<KnowledgeSearchResult> {
    this.searchCount++;
    const url = `${this.mcpServiceUrl.replace(/\/$/, "")}/mcp/tools/call`;

    const caller: Record<string, unknown> = {};
    const orgId = callerOverrides?.orgId ?? this.callerOrgId;
    const userId = callerOverrides?.userId ?? this.callerUserId;
    if (orgId) caller.org_id = orgId;
    if (userId) caller.user_id = userId;
    if (callerOverrides?.aclGroups) caller.acl_groups = callerOverrides.aclGroups;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "synesis_search",
          arguments: args,
          caller: Object.keys(caller).length > 0 ? caller : undefined,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        this.errorCount++;
        return { results: [], query: String(args.query ?? ""), total: 0 };
      }
      const data = (await resp.json()) as { content?: Array<{ text?: string }> };
      const text = data.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(text) as KnowledgeSearchResult;
      return parsed;
    } catch {
      this.errorCount++;
      return { results: [], query: String(args.query ?? ""), total: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  injectToolOpenAI(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools) return [KNOWLEDGE_TOOL_SCHEMA_OPENAI];
    const exists = (tools as Array<{ function?: { name?: string } }>).some(
      (t) => t.function?.name === KNOWLEDGE_TOOL_NAME,
    );
    if (exists) return tools;
    return [...tools, KNOWLEDGE_TOOL_SCHEMA_OPENAI];
  }

  injectToolClaude(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools) return [KNOWLEDGE_TOOL_SCHEMA_CLAUDE];
    const exists = (tools as Array<{ name?: string }>).some(
      (t) => t.name === KNOWLEDGE_TOOL_NAME,
    );
    if (exists) return tools;
    return [...tools, KNOWLEDGE_TOOL_SCHEMA_CLAUDE];
  }

  getStats() {
    return {
      searchCount: this.searchCount,
      errorCount: this.errorCount,
    };
  }
}
