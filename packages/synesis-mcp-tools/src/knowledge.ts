import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { authHeaders, bearerForUpstream } from "./deps.js";
import { buildSearchAttributionBody } from "./search-contract.js";

const SEARCH_TIMEOUT_MS = 30_000;

function plannerBase(deps: SynesisMcpDeps): string {
  return deps.plannerBaseUrl.replace(/\/$/, "");
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
  const body: Record<string, unknown> = { query };

  const topK = optionalNumber(args.top_k);
  if (topK !== undefined) body.top_k = topK;

  const packId = optionalString(args.pack_id);
  if (packId !== undefined) body.pack_id = packId;

  if (Array.isArray(args.pack_ids) && args.pack_ids.length > 0) {
    body.pack_ids = args.pack_ids.map((v) => String(v)).filter((v) => v.trim());
  }

  const packVersion = optionalString(args.pack_version);
  if (packVersion !== undefined) body.pack_version = packVersion;

  const packPartition = optionalString(args.pack_partition);
  if (packPartition !== undefined) body.pack_partition = packPartition;

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

  if (Array.isArray(args.scope_tags) && args.scope_tags.length > 0) {
    body.scope_tags = args.scope_tags.map((t) => String(t));
  } else if (governanceDefaults?.scope_tags?.length) {
    body.scope_tags = [...governanceDefaults.scope_tags];
  }

  const tags = optionalString(args.tags);
  if (tags !== undefined) body.tags = tags;

  const contentFormat = optionalString(args.content_format);
  if (contentFormat !== undefined) body.content_format = contentFormat;

  const repoPath = optionalString(args.repo_path);
  if (repoPath !== undefined) body.repo_path = repoPath;

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
