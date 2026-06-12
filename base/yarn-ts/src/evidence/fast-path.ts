/**
 * Evidence pre-fetch fast-path — detects patterns in user messages that can
 * be grounded with deterministic corpus evidence before calling the LLM.
 *
 * Runs within a strict latency budget (default 200ms). If the MCP search
 * is slower, the result is dropped and the LLM can use the tool later.
 *
 * Patterns detected:
 *   - Compiler/runtime error codes (TS2345, E0308, go vet errors, traceback signatures)
 *   - Linter rule references (eslint, ruff, golangci-lint, clippy)
 *   - Language spec / syntax questions
 */

import type {
  KnowledgeSearchService,
  KnowledgeSearchResult,
  KnowledgeResolveContext,
} from "../state/knowledge-search.js";
import { getLanguagePackRegistry } from "../language-packs/index.js";
import type { FastPathPatternDef } from "../language-packs/types.js";
import { withSpanAsync } from "../telemetry/otel.js";
import { detectCompositionIntent } from "./composition-detector.js";
import type { CompositionIntent } from "./composition-detector.js";

const MAX_EVIDENCE_TEXT_CHARS = 800;
const MAX_EVIDENCE_ATTR_CHARS = 128;

function replaceControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : char;
  }
  return out;
}

function evidenceText(value: unknown, maxChars = MAX_EVIDENCE_TEXT_CHARS): string {
  return replaceControlChars(String(value ?? ""))
    .replace(/=/g, ":")
    .replace(/[<>"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function evidenceAttr(value: unknown, fallback = "unknown"): string {
  const sanitized = evidenceText(value, MAX_EVIDENCE_ATTR_CHARS)
    .replace(/[^A-Za-z0-9_.:/@+-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

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
  quality?: EvidenceQualityTrace;
}

export interface EvidenceQualityTrace {
  source: "rag_prefetch" | "pattern_library";
  matched: boolean;
  timedOut: boolean;
  confidence: number;
  authoritative?: boolean;
  pattern?: string;
  language?: string;
  constraintKind?: string;
  resultCount: number;
  contextCardCount: number;
  exampleCount: number;
  antiPatternCount: number;
  relatedSymbolCount: number;
  freshnessWarningCount: number;
  resolvedPack?: Record<string, unknown>;
  quality?: Record<string, unknown>;
  topEvidence: Array<{
    id?: string;
    kind?: string;
    name?: string;
    source_url?: string;
    score?: number;
    authority?: string;
    pack_id?: string;
    symbol_fqn?: string;
  }>;
  authzTraceId?: string;
  authzMode?: string;
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
  {
    name: "go_cobra_reference",
    regex:
      /\b(?:spf13\/cobra|github\.com\/spf13\/cobra|import\s+["']github\.com\/spf13\/cobra["']|\bcobra\.Command\b)/i,
    language: () => "go",
    scope_tags: ["package-tooling"],
    constraint_kind: "guiding",
    queryTransform: () => "Go Cobra CLI library commands flags persistent flags spf13 cobra",
  },
  {
    name: "go_pflag_reference",
    regex: /\b(?:spf13\/pflag|github\.com\/spf13\/pflag|\bpflag\.\w+)/i,
    language: () => "go",
    scope_tags: ["package-tooling"],
    constraint_kind: "guiding",
    queryTransform: () => "Go spf13 pflag command line flags cobra integration",
  },
  {
    name: "kubectl_reference",
    regex:
      /\bkubectl\b(?:\s+(?:plugin|plugins|completion|subcommand))|\bkubectl\b.{0,80}\b(?:flags?|options?|reference|documentation|source)\b/i,
    language: () => "",
    scope_tags: ["package-tooling"],
    constraint_kind: "guiding",
    queryTransform: (_m, text) => `kubectl CLI reference ${text.slice(0, 160).trim()}`,
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

function evidenceItems(result: KnowledgeSearchResult | undefined): KnowledgeSearchResult["results"] {
  if (!result) return [];
  return result.results ?? [];
}

function qualityTrace(
  source: EvidenceQualityTrace["source"],
  result: KnowledgeSearchResult | undefined,
  opts: {
    matched: boolean;
    timedOut: boolean;
    confidence: number;
    authoritative?: boolean;
    pattern?: string;
    language?: string;
    constraintKind?: string;
  },
): EvidenceQualityTrace {
  const items = evidenceItems(result);
  return {
    source,
    matched: opts.matched,
    timedOut: opts.timedOut,
    confidence: Number(opts.confidence.toFixed(4)),
    authoritative: opts.authoritative,
    pattern: opts.pattern,
    language: opts.language,
    constraintKind: opts.constraintKind,
    resultCount: result?.total ?? items.length,
    contextCardCount: result?.context_cards?.length ?? 0,
    exampleCount: result?.examples?.length ?? 0,
    antiPatternCount: result?.anti_patterns?.length ?? 0,
    relatedSymbolCount: result?.related_symbols?.length ?? 0,
    freshnessWarningCount: result?.freshness_warnings?.length ?? 0,
    resolvedPack: result?.resolved_pack,
    quality: result?.quality,
    topEvidence: items.slice(0, 5).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        id: String(record.id ?? record.chunk_id ?? ""),
        kind: String(record.kind ?? "Chunk"),
        name: String(record.name ?? item.document_name ?? ""),
        source_url: item.source_url,
        score: item.score,
        authority: item.authority,
        pack_id: item.pack_id,
        symbol_fqn: item.symbol_fqn,
      };
    }),
    authzTraceId: result?.authz_trace_id,
    authzMode: result?.authz_mode,
  };
}

export function buildEvidenceTraceSummary(
  prefetch?: FastPathResult,
  pattern?: PatternPrefetchResult,
): Record<string, unknown> | undefined {
  const entries = [prefetch?.quality, pattern?.quality].filter(Boolean) as EvidenceQualityTrace[];
  if (entries.length === 0) return undefined;
  const best = entries.reduce((acc, item) => (item.confidence > acc.confidence ? item : acc), entries[0]);
  return {
    best_source: best.source,
    best_confidence: best.confidence,
    authoritative: entries.some((item) => item.authoritative),
    result_count: entries.reduce((sum, item) => sum + item.resultCount, 0),
    context_card_count: entries.reduce((sum, item) => sum + item.contextCardCount, 0),
    example_count: entries.reduce((sum, item) => sum + item.exampleCount, 0),
    anti_pattern_count: entries.reduce((sum, item) => sum + item.antiPatternCount, 0),
    freshness_warning_count: entries.reduce((sum, item) => sum + item.freshnessWarningCount, 0),
    entries,
  };
}

async function raceSearch(
  knowledgeService: KnowledgeSearchService,
  searchArgs: Record<string, unknown>,
  timeoutMs: number,
  resolveContext?: KnowledgeResolveContext,
): Promise<KnowledgeSearchResult | null> {
  const searchPromise = knowledgeService.resolve(searchArgs, resolveContext).catch(() => null);
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
  resolveContext?: KnowledgeResolveContext,
): Promise<FastPathResult> {
  return withSpanAsync("yarn.evidence.prefetch", { "yarn.evidence.timeout_ms": timeoutMs }, async () => {
    const t0 = performance.now();
    _prefetchStats.attempts++;

    const match = detectPattern(userText);
    if (!match) {
      _prefetchStats.misses++;
      return { matched: false, latencyMs: performance.now() - t0, timedOut: false, confidence: 0, authoritative: false };
    }

    const searchArgs: Record<string, unknown> = {
      query: match.searchQuery,
      mode: "bundle",
      topic: match.pattern,
      task: userText.slice(0, 300),
      scope_tags: match.scope_tags,
      constraint_kind: match.constraint_kind,
      top_k: 3,
      include_examples: true,
      include_antipatterns: true,
      include_context_cards: true,
    };
    if (match.language.trim()) {
      searchArgs.language = match.language;
    }

    let result = await raceSearch(knowledgeService, searchArgs, timeoutMs, resolveContext);

    if (result === null && opts?.retryEnabled) {
      _prefetchStats.retries++;
      const retryTimeout = opts.retryTimeoutMs ?? Math.max(Math.floor(timeoutMs / 2), 50);
      result = await raceSearch(knowledgeService, searchArgs, retryTimeout, resolveContext);
    }

    const latencyMs = performance.now() - t0;
    _prefetchStats.totalLatencyMs += latencyMs;

    if (result === null) {
      _prefetchStats.timeouts++;
      return {
        matched: true,
        pattern: match.pattern,
        latencyMs,
        timedOut: true,
        confidence: 0,
        constraintKind: match.constraint_kind,
        authoritative: false,
        quality: qualityTrace("rag_prefetch", undefined, {
          matched: true,
          timedOut: true,
          confidence: 0,
          pattern: match.pattern,
          language: match.language,
          constraintKind: match.constraint_kind,
        }),
      };
    }

    if (result.total === 0) {
      _prefetchStats.misses++;
      return {
        matched: true,
        pattern: match.pattern,
        latencyMs,
        timedOut: false,
        confidence: 0,
        constraintKind: match.constraint_kind,
        authoritative: false,
        quality: qualityTrace("rag_prefetch", result, {
          matched: true,
          timedOut: false,
          confidence: 0,
          pattern: match.pattern,
          language: match.language,
          constraintKind: match.constraint_kind,
        }),
      };
    }

    const confidence = computeEvidenceConfidence(result, match.constraint_kind);
    const authoritative = confidence >= 0.8 && match.constraint_kind === "hard";
    _prefetchStats.totalConfidence += confidence;

    if (confidence < confidenceMin) {
      _prefetchStats.misses++;
      return {
        matched: true,
        pattern: match.pattern,
        latencyMs,
        timedOut: false,
        confidence,
        constraintKind: match.constraint_kind,
        authoritative: false,
        quality: qualityTrace("rag_prefetch", result, {
          matched: true,
          timedOut: false,
          confidence,
          pattern: match.pattern,
          language: match.language,
          constraintKind: match.constraint_kind,
        }),
      };
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
      quality: qualityTrace("rag_prefetch", result, {
        matched: true,
        timedOut: false,
        confidence,
        authoritative,
        pattern: match.pattern,
        language: match.language,
        constraintKind: match.constraint_kind,
      }),
    };
  });
}

const HIGH_FIDELITY_PROFILES = new Set(["reference", "api_spec", "architecture", "policy"]);

/**
 * Compute a confidence score for evidence results based on:
 * - Number of results returned (more = higher, up to 3)
 * - Best result score (higher = better)
 * - Constraint kind (hard patterns contribute more confidence)
 * - Content profile (reference/api_spec/architecture/policy boost)
 * - Constraint confidence from enrichment (if positive)
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

  let profileBoost = 0;
  for (const r of results) {
    if (HIGH_FIDELITY_PROFILES.has(r.content_profile ?? "")) {
      profileBoost = 0.05;
      break;
    }
  }

  let enrichmentBoost = 0;
  for (const r of results) {
    const cc = r.constraint_confidence ?? -1;
    if (cc > 0.7) {
      enrichmentBoost = 0.05;
      break;
    }
  }

  return Math.min(1.0, countFactor * 0.3 + scoreFactor * 0.45 + constraintBoost + profileBoost + enrichmentBoost);
}

/**
 * Format evidence results as a structured context block for injection
 * into the system/prefix messages.
 */
export function formatEvidenceBlock(result: FastPathResult): string | null {
  if (!result.evidence || result.evidence.total === 0) return null;

  const attrs = [
    `pattern="${evidenceAttr(result.pattern)}"`,
    `source="rag_prefetch"`,
    `confidence="${result.confidence.toFixed(2)}"`,
  ];
  if (result.constraintKind) attrs.push(`constraint_kind="${evidenceAttr(result.constraintKind)}"`);
  if (result.authoritative) attrs.push(`authoritative="true"`);

  const lines = [`<synesis_evidence ${attrs.join(" ")}>`];

  for (const item of result.evidence.results.slice(0, 3)) {
    const profileTag = item.content_profile ? ` (${evidenceAttr(item.content_profile)})` : "";
    lines.push(`[${evidenceAttr(item.authority)}${profileTag}] ${evidenceText(item.document_name || item.source_url, 240)}`);
    if (item.chunk_summary) {
      lines.push(evidenceText(item.chunk_summary, 500));
    } else {
      lines.push(evidenceText(item.text, 500));
    }
    lines.push("");
  }

  lines.push("</synesis_evidence>");
  return lines.join("\n");
}

/* ── Composition pattern recall ──────────────────────────────────── */

export interface PatternPrefetchResult {
  matched: boolean;
  intent?: CompositionIntent;
  evidence?: KnowledgeSearchResult;
  latencyMs: number;
  timedOut: boolean;
  confidence: number;
  quality?: EvidenceQualityTrace;
}

const _patternPrefetchStats = {
  attempts: 0, hits: 0, misses: 0, timeouts: 0,
};

export function getPatternPrefetchStats() {
  return { ..._patternPrefetchStats };
}

/**
 * Pattern-based composition prefetch: when the user wants to build/create
 * something, fetch matching patterns from the corpus.
 */
export async function runPatternPrefetch(
  userText: string,
  knowledgeService: KnowledgeSearchService,
  timeoutMs: number = 200,
  workingPhase?: string,
  resolveContext?: KnowledgeResolveContext,
): Promise<PatternPrefetchResult> {
  return withSpanAsync("yarn.evidence.pattern_prefetch", { "yarn.pattern.timeout_ms": timeoutMs }, async () => {
    const t0 = performance.now();
    _patternPrefetchStats.attempts++;

    const intent = detectCompositionIntent(userText, workingPhase);
    if (!intent) {
      _patternPrefetchStats.misses++;
      return { matched: false, latencyMs: performance.now() - t0, timedOut: false, confidence: 0 };
    }

    const searchArgs = {
      query: intent.searchQuery,
      language: intent.language,
      content_profile: "pattern",
      scope_tags: [intent.skillFamily],
      top_k: 3,
    };

    const result = await raceSearch(knowledgeService, searchArgs, timeoutMs, resolveContext);
    const latencyMs = performance.now() - t0;

    if (result === null) {
      _patternPrefetchStats.timeouts++;
      return {
        matched: true,
        intent,
        latencyMs,
        timedOut: true,
        confidence: 0,
        quality: qualityTrace("pattern_library", undefined, {
          matched: true,
          timedOut: true,
          confidence: 0,
          pattern: intent.skillFamily,
          language: intent.language,
        }),
      };
    }

    if (result.total === 0) {
      _patternPrefetchStats.misses++;
      return {
        matched: true,
        intent,
        latencyMs,
        timedOut: false,
        confidence: 0,
        quality: qualityTrace("pattern_library", result, {
          matched: true,
          timedOut: false,
          confidence: 0,
          pattern: intent.skillFamily,
          language: intent.language,
        }),
      };
    }

    const confidence = computeEvidenceConfidence(result, "guiding");
    _patternPrefetchStats.hits++;
    return {
      matched: true,
      intent,
      evidence: result,
      latencyMs,
      timedOut: false,
      confidence,
      quality: qualityTrace("pattern_library", result, {
        matched: true,
        timedOut: false,
        confidence,
        pattern: intent.skillFamily,
        language: intent.language,
      }),
    };
  });
}

/**
 * Format pattern recall results as a structured block for injection.
 */
export function formatPatternBlock(result: PatternPrefetchResult): string | null {
  if (!result.evidence || result.evidence.total === 0 || !result.intent) return null;

  const attrs = [
    `language="${evidenceAttr(result.intent.language)}"`,
    `skill_family="${evidenceAttr(result.intent.skillFamily)}"`,
    `source="pattern_library"`,
    `confidence="${result.confidence.toFixed(2)}"`,
  ];

  const lines = [`<synesis_pattern_recall ${attrs.join(" ")}>`];

  for (const item of result.evidence.results.slice(0, 3)) {
    lines.push(`[${evidenceAttr(item.authority ?? "vetted")}] ${evidenceText(item.document_name || item.source_url, 240)}`);
    if (item.text) {
      lines.push(evidenceText(item.text, 800));
    }
    lines.push("");
  }

  lines.push("</synesis_pattern_recall>");
  return lines.join("\n");
}
