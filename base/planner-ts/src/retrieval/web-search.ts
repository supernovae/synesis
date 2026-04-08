/**
 * SearXNG web search client.
 *
 * Ports the Python search_and_process() and multi-source fan-out from web_search.py.
 */

import type { SearchResult, WebSearchAttribution } from "./types.js";
import { scanWebContent, redactPatterns } from "../security/scanner.js";

export interface WebSearchConfig {
  url: string;
  enabled: boolean;
  timeoutMs: number;
  maxResults: number;
  engineAuthorityMap?: Record<string, { authority: string; origin_type: string }>;
}

export interface WebSearchObserverPayload {
  query: string;
  profile: "web" | "code";
  results: SearchResult[];
  latencyMs: number;
  attribution?: WebSearchAttribution;
}

let webSearchObserver: ((payload: WebSearchObserverPayload) => void | Promise<void>) | null = null;

export function setWebSearchObserver(
  observer: ((payload: WebSearchObserverPayload) => void | Promise<void>) | null,
): void {
  webSearchObserver = observer;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

const ABSOLUTE_MIN_RELEVANCE = 0.3;
const PAGE_FETCH_TIMEOUT_MS = 4000;
const MAX_PAGE_CONTENT_CHARS = 4000;

function logSearxngDiagnostic(msg: string, meta: Record<string, unknown>): void {
  try {
    process.stderr.write(
      JSON.stringify({
        level: 40,
        time: Date.now(),
        msg,
        component: "querySearxng",
        ...meta,
      }) + "\n",
    );
  } catch {
    /* ignore */
  }
}

async function querySearxng(
  query: string,
  config: WebSearchConfig,
  params: Record<string, string> = {},
): Promise<SearxngResult[]> {
  if (!config.url) return [];

  const base = config.url.replace(/\/$/, "");
  const searchParams = new URLSearchParams({
    q: query,
    format: "json",
    pageno: "1",
    ...params,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const resp = await fetch(`${base}/search?${searchParams}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      logSearxngDiagnostic("searxng_http_error", {
        status: resp.status,
        query: query.slice(0, 200),
      });
      return [];
    }
    const data = (await resp.json()) as SearxngResponse;
    return (data.results ?? []).slice(0, config.maxResults);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logSearxngDiagnostic("searxng_request_failed", {
      error: detail.slice(0, 300),
      query: query.slice(0, 200),
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function bm25Score(query: string, text: string): number {
  const k1 = 1.2;
  const b = 0.75;
  const avgDl = 200;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const docTerms = text.toLowerCase().split(/\s+/).filter(Boolean);
  const dl = docTerms.length;
  if (dl === 0 || queryTerms.length === 0) return 0;

  const termFreq = new Map<string, number>();
  for (const t of docTerms) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (dl / avgDl));
    score += numerator / denominator;
  }
  return score;
}

function classifyTrust(
  results: SearchResult[],
  authorityMap?: Record<string, { authority: string; origin_type: string }>,
): void {
  if (!authorityMap) return;
  for (const r of results) {
    const mapping = authorityMap[r.engine];
    if (mapping) {
      r.authority = mapping.authority;
      r.origin_type = mapping.origin_type;
      r.is_trusted = true;
    }
  }
}

function scoreAndFilter(query: string, results: SearchResult[], minRelevance: number): SearchResult[] {
  for (const r of results) {
    const text = `${r.title} ${r.snippet} ${r.fetched_content}`.slice(0, 2000);
    r.relevance = bm25Score(query, text);
  }
  const maxRel = Math.max(...results.map((r) => r.relevance), 0.001);
  const threshold = Math.max(maxRel * minRelevance, ABSOLUTE_MIN_RELEVANCE);
  return results.filter((r) => r.relevance >= threshold);
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Synesis-Bot/1.0 (knowledge retrieval)" },
      redirect: "follow",
    });
    if (!resp.ok) return "";
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return "";
    const body = await resp.text();
    return stripHtml(body).slice(0, MAX_PAGE_CONTENT_CHARS);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  let out = "";
  let i = 0;
  let inTag = false;
  let skipUntilTag = "";

  while (i < html.length) {
    if (!inTag && html[i] === "<") {
      const close = html.indexOf(">", i + 1);
      if (close === -1) break;
      const rawTag = html.slice(i + 1, close).trim().toLowerCase();
      const normalizedTag = rawTag.replace(/^\//, "").split(/\s+/)[0] ?? "";
      inTag = true;
      if (normalizedTag === "script" || normalizedTag === "style") {
        skipUntilTag = normalizedTag;
      }
      i = close + 1;
      continue;
    }

    if (inTag) {
      if (html[i] === "<") {
        const close = html.indexOf(">", i + 1);
        if (close === -1) break;
        const rawTag = html.slice(i + 1, close).trim().toLowerCase();
        const normalizedTag = rawTag.replace(/^\//, "").split(/\s+/)[0] ?? "";
        const isClosing = rawTag.startsWith("/");
        if (!skipUntilTag && isClosing) {
          inTag = false;
        } else if (skipUntilTag && isClosing && normalizedTag === skipUntilTag) {
          skipUntilTag = "";
          inTag = false;
        }
        i = close + 1;
      } else {
        i += 1;
      }
      continue;
    }

    const ch = html[i];
    out += (ch === "<" || ch === ">") ? " " : ch;
    i += 1;
  }

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Search via SearXNG and optionally fetch top page contents.
 */
export async function searchAndProcess(
  query: string,
  config: WebSearchConfig,
  options: {
    profile?: "web" | "code";
    fetchPages?: boolean;
    maxFetchPages?: number;
    minRelevance?: number;
    attribution?: WebSearchAttribution;
  } = {},
): Promise<SearchResult[]> {
  if (!config.enabled || !config.url) return [];
  const started = performance.now();

  const profile = options.profile ?? "web";
  const fetchPages = options.fetchPages ?? true;
  const maxFetchPages = options.maxFetchPages ?? 3;
  const minRelevance = options.minRelevance ?? 0.5;

  const params: Record<string, string> =
    profile === "code"
      ? { engines: "github,stackoverflow" }
      : { categories: "general" };

  const raw = await querySearxng(query, config, params);

  const results: SearchResult[] = raw.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
    engine: r.engine ?? "",
    score: r.score ?? 0,
    relevance: 0,
    fetched_content: "",
    authority: "external",
    origin_type: "external",
    is_trusted: false,
    source_id: "",
  }));

  if (fetchPages) {
    const toFetch = results.slice(0, maxFetchPages);
    const pages = await Promise.allSettled(toFetch.map((r) => fetchPage(r.url)));
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].status === "fulfilled") {
        toFetch[i].fetched_content = (pages[i] as PromiseFulfilledResult<string>).value;
      }
    }
  }

  classifyTrust(results, config.engineAuthorityMap);

  for (const r of results) {
    const body = r.fetched_content || r.snippet;
    if (!body) continue;
    const scan = scanWebContent(body, `web:${r.url.slice(0, 80)}`);
    if (scan.detected) {
      r.fetched_content = redactPatterns(r.fetched_content || "", true);
      r.snippet = redactPatterns(r.snippet, true);
    }
  }

  const filtered = scoreAndFilter(query, results, minRelevance);
  if (webSearchObserver) {
    try {
      await webSearchObserver({
        query,
        profile,
        results: filtered,
        latencyMs: Math.round((performance.now() - started) * 10) / 10,
        attribution: options.attribution,
      });
    } catch {
      // Keep retrieval path resilient if observer persistence fails.
    }
  }
  return filtered;
}
