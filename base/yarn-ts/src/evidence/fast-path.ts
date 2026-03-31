/**
 * Evidence pre-fetch fast-path — detects patterns in user messages that can
 * be grounded with deterministic corpus evidence before calling the LLM.
 *
 * Runs within a strict latency budget (default 200ms). If the MCP search
 * is slower, the result is dropped and the LLM can use the tool later.
 *
 * Patterns detected:
 *   - Compiler/runtime error codes (TS2345, E0308, go vet errors, Python tracebacks)
 *   - Linter rule references (eslint, ruff, golangci-lint, clippy)
 *   - Language spec / syntax questions
 */

import type { KnowledgeSearchService, KnowledgeSearchResult } from "../state/knowledge-search.js";
import { getLanguagePackRegistry } from "../language-packs/index.js";
import type { FastPathPatternDef } from "../language-packs/types.js";
import { withSpanAsync } from "../telemetry/otel.js";

export interface FastPathMatch {
  pattern: string;
  language: string;
  scope_tags: string[];
  constraint_kind: "hard" | "guiding";
  searchQuery: string;
}

export interface FastPathResult {
  matched: boolean;
  pattern?: string;
  evidence?: KnowledgeSearchResult;
  latencyMs: number;
  timedOut: boolean;
  confidence: number;
  constraintKind?: "hard" | "guiding";
  authoritative: boolean;
}

interface PatternRule {
  name: string;
  regex: RegExp;
  language: (match: RegExpMatchArray) => string;
  scope_tags: string[];
  constraint_kind: "hard" | "guiding";
  queryTransform?: (match: RegExpMatchArray, text: string) => string;
}

const PATTERNS: PatternRule[] = [
  {
    name: "typescript_error",
    regex: /\bTS(\d{4,5})\b/,
    language: () => "typescript",
    scope_tags: ["error-catalog"],
    constraint_kind: "hard",
    queryTransform: (m) => `TypeScript error TS${m[1]}`,
  },
  {
    name: "rust_error",
    regex: /\bE(\d{4})\b.*(?:rust|cargo|rustc)/i,
    language: () => "rust",
    scope_tags: ["error-catalog"],
    constraint_kind: "hard",
    queryTransform: (m) => `Rust compiler error E${m[1]}`,
  },
  {
    name: "go_vet_error",
    regex: /\b(?:go\s+vet|govet)\b.*?:\s*(.+)/i,
    language: () => "go",
    scope_tags: ["error-catalog", "linter-rules"],
    constraint_kind: "hard",
  },
  {
    name: "python_traceback",
    regex: /(?:Traceback \(most recent call last\)|(\w+Error): .+)/,
    language: () => "python",
    scope_tags: ["error-catalog"],
    constraint_kind: "hard",
  },
  {
    name: "eslint_rule",
    regex: /\b(?:eslint|@typescript-eslint)[/-](\S+)/i,
    language: () => "typescript",
    scope_tags: ["linter-rules"],
    constraint_kind: "guiding",
    queryTransform: (m) => `ESLint rule ${m[0]}`,
  },
  {
    name: "ruff_rule",
    regex: /\bruff\s+([A-Z]\d{3,4})\b/i,
    language: () => "python",
    scope_tags: ["linter-rules"],
    constraint_kind: "guiding",
    queryTransform: (m) => `Ruff linter rule ${m[1]}`,
  },
  {
    name: "clippy_lint",
    regex: /\bclippy::(\w+)/,
    language: () => "rust",
    scope_tags: ["linter-rules"],
    constraint_kind: "guiding",
    queryTransform: (m) => `Rust Clippy lint ${m[1]}`,
  },
  {
    name: "golangci_lint",
    regex: /\bgolangci-lint\b.*?\b(\w+)\b/i,
    language: () => "go",
    scope_tags: ["linter-rules"],
    constraint_kind: "guiding",
  },
];

function getRegistryPatterns(): FastPathPatternDef[] {
  const registry = getLanguagePackRegistry();
  if (registry.size === 0) return [];
  return registry.getAllPacks().flatMap((p) => p.fastPathPatterns);
}

export function detectPattern(text: string): FastPathMatch | null {
  const registryPatterns = getRegistryPatterns();
  for (const rp of registryPatterns) {
    const m = rp.regex.exec(text);
    if (m) {
      const pack = getLanguagePackRegistry().getAllPacks().find((p) =>
        p.fastPathPatterns.some((fp) => fp.name === rp.name)
      );
      return {
        pattern: rp.name,
        language: pack?.language ?? "unknown",
        scope_tags: rp.scope_tags,
        constraint_kind: rp.constraint_kind,
        searchQuery: rp.queryTransform ? rp.queryTransform(m, text) : text.slice(0, 200),
      };
    }
  }

  for (const rule of PATTERNS) {
    const m = rule.regex.exec(text);
    if (m) {
      return {
        pattern: rule.name,
        language: rule.language(m),
        scope_tags: rule.scope_tags,
        constraint_kind: rule.constraint_kind,
        searchQuery: rule.queryTransform ? rule.queryTransform(m, text) : text.slice(0, 200),
      };
    }
  }
  return null;
}

export interface EvidencePrefetchOptions {
  timeoutMs?: number;
  confidenceMin?: number;
  retryEnabled?: boolean;
  retryTimeoutMs?: number;
}

export interface EvidencePrefetchStats {
  attempts: number;
  hits: number;
  misses: number;
  timeouts: number;
  retries: number;
  totalConfidence: number;
  totalLatencyMs: number;
}

const _prefetchStats: EvidencePrefetchStats = {
  attempts: 0, hits: 0, misses: 0, timeouts: 0, retries: 0, totalConfidence: 0, totalLatencyMs: 0,
};

export function getEvidencePrefetchStats(): EvidencePrefetchStats {
  return { ..._prefetchStats };
}

export function resetEvidencePrefetchStats(): void {
  _prefetchStats.attempts = 0;
  _prefetchStats.hits = 0;
  _prefetchStats.misses = 0;
  _prefetchStats.timeouts = 0;
  _prefetchStats.retries = 0;
  _prefetchStats.totalConfidence = 0;
  _prefetchStats.totalLatencyMs = 0;
}

async function raceSearch(
  knowledgeService: KnowledgeSearchService,
  searchArgs: Record<string, unknown>,
  timeoutMs: number,
): Promise<KnowledgeSearchResult | null> {
  const searchPromise = knowledgeService.resolve(searchArgs).catch(() => null);
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  );
  return Promise.race([searchPromise, timeoutPromise]);
}

/**
 * Run the evidence pre-fetch within a latency budget.
 * Returns immediately if no pattern matches or if the search exceeds the timeout.
 * When retryEnabled is true, retries once on timeout with a shorter deadline.
 */
export async function runEvidencePrefetch(
  userText: string,
  knowledgeService: KnowledgeSearchService,
  timeoutMs: number = 200,
  confidenceMin: number = 0.3,
  opts?: Pick<EvidencePrefetchOptions, "retryEnabled" | "retryTimeoutMs">,
): Promise<FastPathResult> {
  return withSpanAsync("yarn.evidence.prefetch", { "yarn.evidence.timeout_ms": timeoutMs }, async () => {
    const t0 = performance.now();
    _prefetchStats.attempts++;

    const match = detectPattern(userText);
    if (!match) {
      _prefetchStats.misses++;
      return { matched: false, latencyMs: performance.now() - t0, timedOut: false, confidence: 0, authoritative: false };
    }

    const searchArgs = {
      query: match.searchQuery,
      language: match.language,
      scope_tags: match.scope_tags,
      constraint_kind: match.constraint_kind,
      top_k: 3,
    };

    let result = await raceSearch(knowledgeService, searchArgs, timeoutMs);

    if (result === null && opts?.retryEnabled) {
      _prefetchStats.retries++;
      const retryTimeout = opts.retryTimeoutMs ?? Math.max(Math.floor(timeoutMs / 2), 50);
      result = await raceSearch(knowledgeService, searchArgs, retryTimeout);
    }

    const latencyMs = performance.now() - t0;
    _prefetchStats.totalLatencyMs += latencyMs;

    if (result === null) {
      _prefetchStats.timeouts++;
      return { matched: true, pattern: match.pattern, latencyMs, timedOut: true, confidence: 0, constraintKind: match.constraint_kind, authoritative: false };
    }

    if (result.total === 0) {
      _prefetchStats.misses++;
      return { matched: true, pattern: match.pattern, latencyMs, timedOut: false, confidence: 0, constraintKind: match.constraint_kind, authoritative: false };
    }

    const confidence = computeEvidenceConfidence(result, match.constraint_kind);
    const authoritative = confidence >= 0.8 && match.constraint_kind === "hard";
    _prefetchStats.totalConfidence += confidence;

    if (confidence < confidenceMin) {
      _prefetchStats.misses++;
      return { matched: true, pattern: match.pattern, latencyMs, timedOut: false, confidence, constraintKind: match.constraint_kind, authoritative: false };
    }

    _prefetchStats.hits++;
    return {
      matched: true,
      pattern: match.pattern,
      evidence: result,
      latencyMs,
      timedOut: false,
      confidence,
      constraintKind: match.constraint_kind,
      authoritative,
    };
  });
}

/**
 * Compute a confidence score for evidence results based on:
 * - Number of results returned (more = higher, up to 3)
 * - Best result score (higher = better)
 * - Constraint kind (hard patterns contribute more confidence)
 */
export function computeEvidenceConfidence(
  result: KnowledgeSearchResult,
  constraintKind: "hard" | "guiding",
): number {
  if (result.total === 0) return 0;

  const results = result.results.slice(0, 3);
  const countFactor = Math.min(results.length / 3, 1.0);
  const bestScore = Math.max(...results.map((r) => r.score ?? 0));
  const scoreFactor = Math.min(bestScore, 1.0);
  const constraintBoost = constraintKind === "hard" ? 0.15 : 0;

  return Math.min(1.0, countFactor * 0.3 + scoreFactor * 0.55 + constraintBoost);
}

/**
 * Format evidence results as a structured context block for injection
 * into the system/prefix messages.
 */
export function formatEvidenceBlock(result: FastPathResult): string | null {
  if (!result.evidence || result.evidence.total === 0) return null;

  const attrs = [
    `pattern="${result.pattern}"`,
    `source="rag_prefetch"`,
    `confidence="${result.confidence.toFixed(2)}"`,
  ];
  if (result.constraintKind) attrs.push(`constraint_kind="${result.constraintKind}"`);
  if (result.authoritative) attrs.push(`authoritative="true"`);

  const lines = [`<synesis_evidence ${attrs.join(" ")}>`];

  for (const item of result.evidence.results.slice(0, 3)) {
    lines.push(`[${item.authority}] ${item.document_name || item.source_url}`);
    if (item.chunk_summary) {
      lines.push(item.chunk_summary);
    } else {
      lines.push(item.text.slice(0, 500));
    }
    lines.push("");
  }

  lines.push("</synesis_evidence>");
  return lines.join("\n");
}
