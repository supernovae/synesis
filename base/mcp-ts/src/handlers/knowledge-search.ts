import type { McpConfig } from "../config.js";
import type { CallerIdentity, McpToolDefinition } from "../tool-registry.js";

const SEARCH_TIMEOUT_MS = 30_000;

function plannerBaseUrl(config: McpConfig): string {
  return config.SYNESIS_PLANNER_URL.replace(/\/$/, "");
}

function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token.trim()) {
    h.Authorization = `Bearer ${token.trim()}`;
  }
  return h;
}

function optionalString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function optionalNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildSearchBody(
  args: Record<string, unknown>,
  caller: CallerIdentity | undefined,
  fixedArtifactKind: string | undefined,
): Record<string, unknown> {
  const query = String(args.query ?? "").trim();
  const body: Record<string, unknown> = { query };

  const topK = optionalNumber(args.top_k);
  if (topK !== undefined) body.top_k = topK;

  const lang = optionalString(args.language);
  if (lang !== undefined) body.language = lang;

  const artifact =
    fixedArtifactKind ?? optionalString(args.artifact_kind);
  if (artifact !== undefined) body.artifact_kind = artifact;

  const domain = optionalString(args.domain);
  if (domain !== undefined) body.domain = domain;

  const corpusClass = optionalString(args.corpus_class);
  if (corpusClass !== undefined) body.corpus_class = corpusClass;

  const constraintKind = optionalString(args.constraint_kind);
  if (constraintKind !== undefined) body.constraint_kind = constraintKind;

  if (Array.isArray(args.scope_tags) && args.scope_tags.length > 0) {
    body.scope_tags = args.scope_tags.map((t) => String(t));
  }

  const tags = optionalString(args.tags);
  if (tags !== undefined) body.tags = tags;

  const contentFormat = optionalString(args.content_format);
  if (contentFormat !== undefined) body.content_format = contentFormat;

  const repoPath = optionalString(args.repo_path);
  if (repoPath !== undefined) body.repo_path = repoPath;

  if (caller?.org_id) body.caller_org_id = caller.org_id;
  if (caller?.tenant_ids?.length) body.caller_tenant_ids = [...caller.tenant_ids];
  if (caller?.acl_groups?.length) body.caller_acl_groups = [...caller.acl_groups];
  if (caller?.user_id) body.caller_user_id = caller.user_id;

  return body;
}

async function runKnowledgeSearch(
  config: McpConfig,
  args: Record<string, unknown>,
  caller: CallerIdentity | undefined,
  fixedArtifactKind: string | undefined,
): Promise<unknown> {
  try {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { error: "validation_error", message: "query is required" };
    }

    const body = buildSearchBody(args, caller, fixedArtifactKind);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBaseUrl(config)}/v1/knowledge/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(config.SYNESIS_INTERNAL_SERVICE_TOKEN),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }

    if (resp.status === 404) {
      return { results: [], note: "Knowledge search endpoint not yet available" };
    }

    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      payload = { parse_error: true, status: resp.status };
    }

    if (!resp.ok) {
      return {
        error: "knowledge_search_failed",
        status: resp.status,
        detail: payload,
      };
    }

    return payload;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      error: aborted ? "timeout" : "request_failed",
      message,
    };
  }
}

const searchInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    top_k: { type: "integer", description: "Number of results (1–50)" },
    language: { type: "string", description: "Filter by language (e.g. python, typescript)" },
    artifact_kind: {
      type: "string",
      description: "Artifact type: code, docs, config, or api_spec",
      enum: ["code", "docs", "config", "api_spec"],
    },
    domain: { type: "string", description: "Taxonomy domain filter" },
    corpus_class: { type: "string", description: "Corpus class filter" },
    constraint_kind: { type: "string", description: "Constraint kind filter" },
    scope_tags: {
      type: "array",
      items: { type: "string" },
      description: "Scope tag filters",
    },
    tags: { type: "string", description: "Tag substring filter" },
    content_format: { type: "string", description: "Content format (e.g. yaml, json)" },
    repo_path: { type: "string", description: "Repository path filter" },
  },
  required: ["query"],
};

export function createKnowledgeSearchTools(config: McpConfig): McpToolDefinition[] {
  return [
    {
      name: "synesis_search",
      description:
        "RAG retrieval against the Synesis knowledge catalog. Returns ranked chunks with provenance and scores. Supports metadata filters (language, artifact kind, domain, tags, repo path, etc.).",
      inputSchema: searchInputSchema,
      handler: async (args, caller) => runKnowledgeSearch(config, args, caller, undefined),
    },
    {
      name: "synesis_code_search",
      description:
        "Search the Synesis code corpus (artifact_kind=code). Returns ranked code chunks with provenance.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What code to search for" },
          top_k: { type: "integer", description: "Number of results", default: 5 },
          language: {
            type: "string",
            description: "Programming language filter (e.g. python, go, rust)",
          },
          domain: { type: "string", description: "Taxonomy domain filter" },
          corpus_class: { type: "string" },
          constraint_kind: { type: "string" },
          scope_tags: { type: "array", items: { type: "string" } },
          tags: { type: "string", description: "Tag substring filter" },
          content_format: { type: "string" },
          repo_path: { type: "string", description: "Repository filter (e.g. owner/repo)" },
        },
        required: ["query"],
      },
      handler: async (args, caller) => runKnowledgeSearch(config, args, caller, "code"),
    },
    {
      name: "synesis_docs_search",
      description:
        "Search the Synesis documentation corpus (artifact_kind=docs). Returns ranked documentation chunks.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What documentation to search for" },
          top_k: { type: "integer", description: "Number of results", default: 5 },
          domain: { type: "string", description: "Taxonomy domain filter" },
          corpus_class: { type: "string" },
          constraint_kind: { type: "string" },
          scope_tags: { type: "array", items: { type: "string" } },
          tags: { type: "string", description: "Tag substring filter" },
          content_format: { type: "string" },
          repo_path: { type: "string" },
        },
        required: ["query"],
      },
      handler: async (args, caller) => runKnowledgeSearch(config, args, caller, "docs"),
    },
    {
      name: "synesis_config_search",
      description:
        "Search the Synesis configuration corpus (artifact_kind=config): YAML, JSON, HCL, Kubernetes, Terraform, CI, etc.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What configuration to search for" },
          top_k: { type: "integer", description: "Number of results", default: 5 },
          language: { type: "string", description: "Language/format hint (e.g. yaml, hcl)" },
          domain: { type: "string", description: "Taxonomy domain filter" },
          corpus_class: { type: "string" },
          constraint_kind: { type: "string" },
          scope_tags: { type: "array", items: { type: "string" } },
          tags: { type: "string", description: "Tag substring filter" },
          content_format: {
            type: "string",
            description: "Content format filter (e.g. yaml, json, hcl, toml)",
          },
          repo_path: { type: "string" },
        },
        required: ["query"],
      },
      handler: async (args, caller) => runKnowledgeSearch(config, args, caller, "config"),
    },
  ];
}
