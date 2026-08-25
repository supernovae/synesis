import type { SynesisMcpAuth } from "./auth-types.js";
import type { SynesisMcpDeps } from "./deps.js";
import { upstreamAuthHeaders } from "./deps.js";
import { buildSearchAttributionBody, type SearchAttributionInput } from "./search-contract.js";
import { LIMITS, boundedString, boundedStringArray, clampInt, requestFailure, sanitizeUpstreamError } from "./tool-utils.js";

const SEARCH_TIMEOUT_MS = 30_000;

function plannerBase(deps: SynesisMcpDeps): string {
  return deps.plannerBaseUrl.replace(/\/$/, "");
}

function optionalString(v: unknown): string | undefined {
  return boundedString(v, LIMITS.shortStringChars);
}

function optionalBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}

function buildWebSearchBody(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  toolName: string,
  attribution?: SearchAttributionInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: String(args.query ?? "").trim().slice(0, LIMITS.queryChars),
  };
  const topK = clampInt(args.top_k, 1, LIMITS.maxTopK);
  if (topK !== undefined) body.top_k = topK;
  const profile = optionalString(args.profile);
  if (profile) body.profile = profile;
  const fetchPages = optionalBoolean(args.fetch_pages);
  if (fetchPages !== undefined) body.fetch_pages = fetchPages;
  const maxFetchPages = clampInt(args.max_fetch_pages, 0, LIMITS.maxFetchPages);
  if (maxFetchPages !== undefined) body.max_fetch_pages = maxFetchPages;
  const minRelevance = typeof args.min_relevance === "number" && Number.isFinite(args.min_relevance)
    ? Math.min(Math.max(args.min_relevance, 0), 1)
    : undefined;
  if (minRelevance !== undefined) body.min_relevance = minRelevance;
  const preferredDomains = boundedStringArray(args.preferred_domains);
  if (preferredDomains) body.preferred_domains = preferredDomains;
  Object.assign(body, buildSearchAttributionBody(attribution, auth, "planner_internal", toolName));
  return body;
}

export async function runWebSearch(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
  toolName = "synesis_web_search",
  attribution?: SearchAttributionInput,
): Promise<unknown> {
  try {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { error: "validation_error", message: "query is required" };
    }
    if (query.length > LIMITS.queryChars) {
      return { error: "validation_error", message: `query must be ${LIMITS.queryChars} characters or fewer` };
    }
    const body = buildWebSearchBody(args, auth, toolName, attribution);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBase(deps)}/v1/web/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...upstreamAuthHeaders(auth, deps),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (resp.status === 404) {
      return { results: [], note: "Web search endpoint not yet available" };
    }
    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      payload = { parse_error: true, status: resp.status };
    }
    if (!resp.ok) {
      void payload;
      return sanitizeUpstreamError("web_search_failed", resp.status);
    }
    return payload;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("invalid_search_attribution_")) {
      return { error: "validation_error", message: "Invalid search attribution" };
    }
    return requestFailure("request_failed", e);
  }
}
