/**
 * KnowledgeSearchService — server-side RAG via shared `@synesis/mcp-tools` handlers
 * (same code path as synesis-mcp-ts MCP tools). Calls planner `POST /v1/knowledge/search`
 * with the caller's PAT for scope alignment.
 */

import { dispatchSynesisTool, type SynesisMcpDeps, type SynesisMcpAuth } from "@synesis/mcp-tools";

export const KNOWLEDGE_TOOL_NAME = "synesis_knowledge_search";

const KNOWLEDGE_DESCRIPTION =
  "Search the Synesis knowledge catalog for distilled documentation snippets, code examples, " +
  "language specs, error catalogs, linter rules, style guides, CLI/framework patterns (e.g. Cobra, kubectl), " +
  "and architecture notes. Returns compact ranked chunks (usually fewer tokens than full web pages). " +
  "When you need external reference material, prefer this tool BEFORE synesis_web_search. " +
  "For Rust, use language=rust plus symbol_fqn=E0xxx for compiler errors, scope_tags like edition-2024/async/unsafe, " +
  "and inspect agent_enrichment_json for async_contract and borrow/lifetime constraints. " +
  "For Quarkus, use language=quarkus plus artifact_kind=config_reference or cli_command, scope_tags like build-time-config/reactive/native-image/dev-services, " +
  "and inspect agent_enrichment_json for build_time_config, event_loop_safety, native_image_note, extension_dependency, and CLI agent_advice. " +
  "For Python, use language=python plus artifact_kind=repo_map before broad searches in large repos, artifact_kind=type_stub for C-extension/type ambiguity, " +
  "and scope_tags like free-threading/subinterpreters/deferred-annotations/t-strings/uv to avoid environment drift and dependency hallucination. " +
  "Use filters (language, scope_tags, artifact_kind) when they narrow the query.";

const KNOWLEDGE_PARAMETERS = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description: "Search query describing what knowledge to find",
    },
    language: {
      type: "string",
      description: "Filter by programming language/framework (e.g. python, typescript, go, rust, quarkus)",
    },
    pack_id: {
      type: "string",
      description: "Filter by installed SynPack id (e.g. go-1.26, python-3.13)",
    },
    pack_version: {
      type: "string",
      description: "Filter by SynPack artifact version",
    },
    pack_ids: {
      type: "array",
      items: { type: "string" },
      description: "Filter by one or more installed SynPack ids",
    },
    package_name: {
      type: "string",
      description: "Filter by package/module name, such as net/http or fmt",
    },
    symbol_kind: {
      type: "string",
      description: "Filter by symbol kind, such as package, type, function, method, or example",
    },
    symbol_fqn: {
      type: "string",
      description: "Filter by fully-qualified symbol name",
    },
    perf_tier: {
      type: "string",
      description: "Filter by agentic performance tier, such as io-bound or concurrency-sensitive",
    },
    artifact_kind: {
      type: "string",
      description: "Filter by artifact type: code, docs, config, api_spec, architecture, compiler_error, language_spec, unsafe_guidance, async_guidance, config_reference, cli_command, platform_bom, pep, packaging_spec, tool_docs, type_stub, repo_map",
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

export const DEV_DOCS_TOOL_NAME = "search_developer_docs";

const DEV_DOCS_DESCRIPTION =
  "Search curated developer documentation in the knowledge catalog for languages and frameworks (e.g. Python, Go, Rust, Quarkus, React). " +
  "Prefer this (or synesis_knowledge_search) for API references, flags, and patterns before synesis_web_search. " +
  "For Rust projects, inspect Cargo.toml edition when possible and prefer Rust SynPack rows matching edition-2021 or edition-2024. " +
  "For Quarkus projects, prefer Quarkus SynPack CLI/config rows before manual Maven XML or Spring-style runtime-heavy patterns. " +
  "For Python projects, prefer repo_map rows for large-codebase orientation and uv/tooling rows before manual dependency edits. " +
  "If results are empty or clearly stale, use web search with snippets only first (avoid fetch_pages until needed).";

const DEV_DOCS_PARAMETERS = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description: "Search query describing what documentation to find",
    },
    language: {
      type: "string",
      description: "Filter by programming language or framework (e.g., python, react, go)",
    },
    pack_id: {
      type: "string",
      description: "Filter by installed SynPack id (e.g. go-1.26, python-3.13)",
    },
    top_k: {
      type: "integer",
      description: "Number of results to return (default 5, max 20)",
    },
  },
  required: ["query"],
};

export const DEV_DOCS_TOOL_SCHEMA_OPENAI = {
  type: "function" as const,
  function: {
    name: DEV_DOCS_TOOL_NAME,
    description: DEV_DOCS_DESCRIPTION,
    parameters: DEV_DOCS_PARAMETERS,
  },
};

export const DEV_DOCS_TOOL_SCHEMA_CLAUDE = {
  name: DEV_DOCS_TOOL_NAME,
  description: DEV_DOCS_DESCRIPTION,
  input_schema: DEV_DOCS_PARAMETERS,
};

export interface KnowledgeSearchResult {
  results: Array<{
    text: string;
    source_url: string;
    document_name: string;
    authority: string;
    pack_id?: string;
    pack_version?: string;
    pack_source_version?: string;
    pack_partition?: string;
    symbol_kind?: string;
    symbol_fqn?: string;
    package_name?: string;
    doc_relation_ids?: string[];
    agent_hook?: string;
    perf_tier?: string;
    safety_contract?: string;
    lifecycle_model?: string;
    agent_enrichment_json?: string;
    score: number;
    constraint_kind: string;
    corpus_class: string;
    scope_tags: string[];
    language: string;
    context_prefix: string;
    chunk_summary: string;
    content_profile: string;
    constraint_source: string;
    constraint_confidence: number;
    golden_path_id: string;
    novel_pattern: boolean;
  }>;
  query: string;
  total: number;
}

/** Identity for planner knowledge/search — must match validated session / PAT. */
export interface KnowledgeResolveContext {
  orgId: string;
  userId: string;
  tenantIds: string[];
  /** Raw Bearer token (syn- PAT preferred). When empty, internal service token is used if configured. */
  bearerToken: string;
}

export class KnowledgeSearchService {
  private searchCount = 0;
  private errorCount = 0;

  constructor(private readonly deps: SynesisMcpDeps) {}

  async resolve(
    args: Record<string, unknown>,
    context?: KnowledgeResolveContext,
  ): Promise<KnowledgeSearchResult> {
    this.searchCount++;
    const bearer =
      context?.bearerToken?.trim() || this.deps.internalServiceToken?.trim() || "";
    const auth: SynesisMcpAuth = {
      bearerToken: bearer,
      userId: context?.userId ?? "",
      orgId: context?.orgId ?? "",
      tenantIds: context?.tenantIds ?? [],
    };

    try {
      const raw = await dispatchSynesisTool(
        "synesis_knowledge_search",
        args,
        auth,
        this.deps,
      );
      const parsed = raw as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        this.errorCount++;
        return { results: [], query: String(args.query ?? ""), total: 0 };
      }
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const total =
        typeof parsed.total === "number"
          ? parsed.total
          : Array.isArray(results)
            ? results.length
            : 0;
      return {
        results: results as KnowledgeSearchResult["results"],
        query: String(parsed.query ?? args.query ?? ""),
        total,
      };
    } catch {
      this.errorCount++;
      return { results: [], query: String(args.query ?? ""), total: 0 };
    }
  }

  injectToolOpenAI(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools) return [KNOWLEDGE_TOOL_SCHEMA_OPENAI, DEV_DOCS_TOOL_SCHEMA_OPENAI];
    let newTools = [...tools];
    const existsKnowledge = (tools as Array<{ function?: { name?: string } }>).some(
      (t) => t.function?.name === KNOWLEDGE_TOOL_NAME,
    );
    if (!existsKnowledge) newTools.push(KNOWLEDGE_TOOL_SCHEMA_OPENAI);
    
    const existsDevDocs = (tools as Array<{ function?: { name?: string } }>).some(
      (t) => t.function?.name === DEV_DOCS_TOOL_NAME,
    );
    if (!existsDevDocs) newTools.push(DEV_DOCS_TOOL_SCHEMA_OPENAI);
    
    return newTools;
  }

  injectToolClaude(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools) return [KNOWLEDGE_TOOL_SCHEMA_CLAUDE, DEV_DOCS_TOOL_SCHEMA_CLAUDE];
    let newTools = [...tools];
    const existsKnowledge = (tools as Array<{ name?: string }>).some(
      (t) => t.name === KNOWLEDGE_TOOL_NAME,
    );
    if (!existsKnowledge) newTools.push(KNOWLEDGE_TOOL_SCHEMA_CLAUDE);
    
    const existsDevDocs = (tools as Array<{ name?: string }>).some(
      (t) => t.name === DEV_DOCS_TOOL_NAME,
    );
    if (!existsDevDocs) newTools.push(DEV_DOCS_TOOL_SCHEMA_CLAUDE);
    
    return newTools;
  }

  async resolveDevDocs(
    args: Record<string, unknown>,
    context?: KnowledgeResolveContext,
  ): Promise<KnowledgeSearchResult> {
    this.searchCount++;
    const bearer =
      context?.bearerToken?.trim() || this.deps.internalServiceToken?.trim() || "";
    const auth: SynesisMcpAuth = {
      bearerToken: bearer,
      userId: context?.userId ?? "",
      orgId: context?.orgId ?? "",
      tenantIds: context?.tenantIds ?? [],
    };

    try {
      const raw = await dispatchSynesisTool(
        "search_developer_docs",
        args,
        auth,
        this.deps,
      );
      const parsed = raw as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        this.errorCount++;
        return { results: [], query: String(args.query ?? ""), total: 0 };
      }
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const total =
        typeof parsed.total === "number"
          ? parsed.total
          : Array.isArray(results)
            ? results.length
            : 0;
      return {
        results: results as KnowledgeSearchResult["results"],
        query: String(args.query ?? ""),
        total,
      };
    } catch {
      this.errorCount++;
      return { results: [], query: String(args.query ?? ""), total: 0 };
    }
  }

  getStats() {
    return {
      searchCount: this.searchCount,
      errorCount: this.errorCount,
    };
  }
}
