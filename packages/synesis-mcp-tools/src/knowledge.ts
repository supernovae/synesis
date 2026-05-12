import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { authHeaders, bearerForUpstream } from "./deps.js";
import { buildSearchAttributionBody } from "./search-contract.js";
import { LIMITS, boundedString, boundedStringArray, clampInt, requestFailure, sanitizeUpstreamError } from "./tool-utils.js";

const SEARCH_TIMEOUT_MS = 30_000;

function plannerBase(deps: SynesisMcpDeps): string {
  return deps.plannerBaseUrl.replace(/\/$/, "");
}

function optionalString(v: unknown): string | undefined {
  return boundedString(v, LIMITS.shortStringChars);
}

export interface GovernanceSearchDefaults {
  constraint_kind?: string;
  corpus_class?: string;
  scope_tags?: string[];
}

function buildSearchBody(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  fixedArtifactKind: string | undefined,
  governanceDefaults?: GovernanceSearchDefaults,
): Record<string, unknown> {
  const query = String(args.query ?? "").trim();
  const body: Record<string, unknown> = { query: query.slice(0, LIMITS.queryChars) };

  const topK = clampInt(args.top_k, 1, LIMITS.maxTopK);
  if (topK !== undefined) body.top_k = topK;

  const packId = optionalString(args.pack_id);
  if (packId !== undefined) body.pack_id = packId;

  const packIds = boundedStringArray(args.pack_ids);
  if (packIds) body.pack_ids = packIds;

  const packVersion = optionalString(args.pack_version);
  if (packVersion !== undefined) body.pack_version = packVersion;

  const packPartition = optionalString(args.pack_partition);
  if (packPartition !== undefined) body.pack_partition = packPartition;

  const version = optionalString(args.version);
  if (version !== undefined) body.version = version;

  const commit = optionalString(args.commit);
  if (commit !== undefined) body.commit = commit;

  const branch = optionalString(args.branch);
  if (branch !== undefined) body.branch = branch;

  const temporalAt = optionalString(args.temporal_at);
  if (temporalAt !== undefined) body.temporal_at = temporalAt;

  const graphDepth = clampInt(args.graph_depth, 0, LIMITS.maxGraphDepth);
  if (graphDepth !== undefined) body.graph_depth = graphDepth;

  const edgeTypes = boundedStringArray(args.edge_types);
  if (edgeTypes) body.edge_types = edgeTypes.map((v) => v.toUpperCase());

  const symbolKind = optionalString(args.symbol_kind);
  if (symbolKind !== undefined) body.symbol_kind = symbolKind;

  const symbolFqn = optionalString(args.symbol_fqn);
  if (symbolFqn !== undefined) body.symbol_fqn = symbolFqn;

  const packageName = optionalString(args.package_name);
  if (packageName !== undefined) body.package_name = packageName;

  const perfTier = optionalString(args.perf_tier);
  if (perfTier !== undefined) body.perf_tier = perfTier;

  const lang = optionalString(args.language);
  if (lang !== undefined) body.language = lang;

  const artifact = fixedArtifactKind ?? optionalString(args.artifact_kind);
  if (artifact !== undefined) body.artifact_kind = artifact;

  const domain = optionalString(args.domain);
  if (domain !== undefined) body.domain = domain;

  const corpusClass = optionalString(args.corpus_class) ?? governanceDefaults?.corpus_class;
  if (corpusClass !== undefined) body.corpus_class = corpusClass;

  const constraintKind = optionalString(args.constraint_kind) ?? governanceDefaults?.constraint_kind;
  if (constraintKind !== undefined) body.constraint_kind = constraintKind;

  const scopeTags = boundedStringArray(args.scope_tags);
  if (scopeTags) {
    body.scope_tags = scopeTags;
  } else if (governanceDefaults?.scope_tags?.length) {
    body.scope_tags = [...governanceDefaults.scope_tags];
  }

  const tags = optionalString(args.tags);
  if (tags !== undefined) body.tags = tags;

  const contentFormat = optionalString(args.content_format);
  if (contentFormat !== undefined) body.content_format = contentFormat;

  const repoPath = optionalString(args.repo_path);
  if (repoPath !== undefined) body.repo_path = repoPath;

  const modulePath = optionalString(args.module_path);
  if (modulePath !== undefined) body.module_path = modulePath;

  const symbolName = optionalString(args.symbol_name);
  if (symbolName !== undefined) body.symbol_name = symbolName;

  if (typeof args.has_code === "boolean") body.has_code = args.has_code;

  const codeLanguage = optionalString(args.code_language);
  if (codeLanguage !== undefined) body.code_language = codeLanguage;

  const contentProfile = optionalString(args.content_profile);
  if (contentProfile !== undefined) body.content_profile = contentProfile;

  const constraintSource = optionalString(args.constraint_source);
  if (constraintSource !== undefined) body.constraint_source = constraintSource;

  const goldenPathId = optionalString(args.golden_path_id);
  if (goldenPathId !== undefined) body.golden_path_id = goldenPathId;

  Object.assign(body, buildSearchAttributionBody(args, auth, "planner_internal", "synesis_knowledge_search"));

  return body;
}

export async function runKnowledgeSearch(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
  fixedArtifactKind: string | undefined,
): Promise<unknown> {
  try {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { error: "validation_error", message: "query is required" };
    }
    if (query.length > LIMITS.queryChars) {
      return { error: "validation_error", message: `query must be ${LIMITS.queryChars} characters or fewer` };
    }

    const body = buildSearchBody(args, auth, fixedArtifactKind);
    const bearer = bearerForUpstream(auth, deps);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBase(deps)}/v1/knowledge/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(bearer),
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
      void payload;
      return sanitizeUpstreamError("knowledge_search_failed", resp.status);
    }

    return payload;
  } catch (e) {
    return requestFailure("request_failed", e);
  }
}
