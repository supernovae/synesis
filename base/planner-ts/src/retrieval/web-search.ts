/**
 * SearXNG web search client.
 *
 * Ports the Python search_and_process() and multi-source fan-out from web_search.py.
 */

import type { SearchResult } from "./types.js";
import { scanWebContent, redactPatterns } from "../security/scanner.js";

export interface WebSearchConfig {
  url: string;
  enabled: boolean;
  timeoutMs: number;
  maxResults: number;
  engineAuthorityMap?: Record<string, { authority: string; origin_type: string }>;
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
    if (!resp.ok) return [];
    const data = (await resp.json()) as SearxngResponse;
    return (data.results ?? []).slice(0, config.maxResults);
  } catch {
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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  } = {},
): Promise<SearchResult[]> {
  if (!config.enabled || !config.url) return [];

  const profile = options.profile ?? "web";
  const fetchPages = options.fetchPages ?? true;
  const maxFetchPages = options.maxFetchPages ?? 2;
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

  return scoreAndFilter(query, results, minRelevance);
}
