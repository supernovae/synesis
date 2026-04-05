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
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: String(args.query ?? "").trim(),
  };
  const topK = optionalNumber(args.top_k);
  if (topK !== undefined) body.top_k = topK;
  const profile = optionalString(args.profile);
  if (profile) body.profile = profile;
  const fetchPages = optionalBoolean(args.fetch_pages);
  if (fetchPages !== undefined) body.fetch_pages = fetchPages;
  const maxFetchPages = optionalNumber(args.max_fetch_pages);
  if (maxFetchPages !== undefined) body.max_fetch_pages = maxFetchPages;
  const minRelevance = optionalNumber(args.min_relevance);
  if (minRelevance !== undefined) body.min_relevance = minRelevance;
  if (Array.isArray(args.preferred_domains) && args.preferred_domains.length > 0) {
    body.preferred_domains = args.preferred_domains.map((d) => String(d));
  }
  Object.assign(body, buildSearchAttributionBody(args, auth, "planner_internal", toolName));
  return body;
}

export async function runWebSearch(
  args: Record<string, unknown>,
  auth: SynesisMcpAuth,
  deps: SynesisMcpDeps,
  toolName = "synesis_web_search",
): Promise<unknown> {
  try {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { error: "validation_error", message: "query is required" };
    }
    const body = buildWebSearchBody(args, auth, toolName);
    const bearer = bearerForUpstream(auth, deps);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${plannerBase(deps)}/v1/web/search`, {
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
      return { results: [], note: "Web search endpoint not yet available" };
    }
    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      payload = { parse_error: true, status: resp.status };
    }
    if (!resp.ok) {
      return {
        error: "web_search_failed",
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

