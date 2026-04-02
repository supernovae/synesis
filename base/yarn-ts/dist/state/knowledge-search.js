/**
 * KnowledgeSearchService — bridges Yarn to MCP-TS for RAG corpus retrieval.
 *
 * Follows the ArtifactRetrievalService pattern:
 *   - injectToolOpenAI/Claude: adds synesis_knowledge_search to the LLM tool list
 *   - resolve(): calls MCP-TS to execute the search
 *   - Can be used in Yarn's server-side tool resolution loop
 */
export const KNOWLEDGE_TOOL_NAME = "synesis_knowledge_search";
const KNOWLEDGE_DESCRIPTION = "Search the Synesis knowledge catalog for relevant documentation, code examples, " +
    "language specifications, error catalogs, linter rules, style guides, and architecture " +
    "patterns. Returns ranked chunks with provenance, authority, and constraint metadata. " +
    "Use when you need grounded evidence from organizational knowledge or curated technical references.";
const KNOWLEDGE_PARAMETERS = {
    type: "object",
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
            description: "Filter by purpose tags: error-catalog, linter-rules, language-spec, style-guide, testing-framework, package-tooling, build-tooling",
        },
        constraint_kind: {
            type: "string",
            description: "Filter by constraint trust level: hard (specs/compiler), guiding (best practice), advisory (community)",
            enum: ["hard", "guiding", "advisory"],
        },
        content_profile: {
            type: "string",
            description: "Content profile: reference, procedural, tutorial, api_spec, architecture, policy",
        },
        constraint_source: {
            type: "string",
            description: "Source of constraint (e.g. typescript-spec, eslint, ruff)",
        },
        golden_path_id: {
            type: "string",
            description: "Backstage/Developer Hub golden path template ID",
        },
        top_k: {
            type: "integer",
            description: "Number of results to return (default 5, max 20)",
        },
    },
    required: ["query"],
};
export const KNOWLEDGE_TOOL_SCHEMA_OPENAI = {
    type: "function",
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
export class KnowledgeSearchService {
    mcpServiceUrl;
    callerOrgId;
    callerUserId;
    searchCount = 0;
    errorCount = 0;
    constructor(mcpServiceUrl, callerOrgId, callerUserId) {
        this.mcpServiceUrl = mcpServiceUrl;
        this.callerOrgId = callerOrgId;
        this.callerUserId = callerUserId;
    }
    async resolve(args, callerOverrides) {
        this.searchCount++;
        const url = `${this.mcpServiceUrl.replace(/\/$/, "")}/mcp/tools/call`;
        const caller = {};
        const orgId = callerOverrides?.orgId ?? this.callerOrgId;
        const userId = callerOverrides?.userId ?? this.callerUserId;
        if (orgId)
            caller.org_id = orgId;
        if (userId)
            caller.user_id = userId;
        if (callerOverrides?.aclGroups)
            caller.acl_groups = callerOverrides.aclGroups;
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
            const data = (await resp.json());
            const text = data.content?.[0]?.text ?? "{}";
            const parsed = JSON.parse(text);
            return parsed;
        }
        catch {
            this.errorCount++;
            return { results: [], query: String(args.query ?? ""), total: 0 };
        }
        finally {
            clearTimeout(timer);
        }
    }
    injectToolOpenAI(tools) {
        if (!tools)
            return [KNOWLEDGE_TOOL_SCHEMA_OPENAI];
        const exists = tools.some((t) => t.function?.name === KNOWLEDGE_TOOL_NAME);
        if (exists)
            return tools;
        return [...tools, KNOWLEDGE_TOOL_SCHEMA_OPENAI];
    }
    injectToolClaude(tools) {
        if (!tools)
            return [KNOWLEDGE_TOOL_SCHEMA_CLAUDE];
        const exists = tools.some((t) => t.name === KNOWLEDGE_TOOL_NAME);
        if (exists)
            return tools;
        return [...tools, KNOWLEDGE_TOOL_SCHEMA_CLAUDE];
    }
    getStats() {
        return {
            searchCount: this.searchCount,
            errorCount: this.errorCount,
        };
    }
}
