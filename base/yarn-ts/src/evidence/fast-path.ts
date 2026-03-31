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

export function detectPattern(text: string): FastPathMatch | null {
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

/**
 * Run the evidence pre-fetch within a latency budget.
 * Returns immediately if no pattern matches or if the search exceeds the timeout.
 */
export async function runEvidencePrefetch(
  userText: string,
  knowledgeService: KnowledgeSearchService,
  timeoutMs: number = 200,
): Promise<FastPathResult> {
  const t0 = performance.now();
  const match = detectPattern(userText);
  if (!match) {
    return { matched: false, latencyMs: performance.now() - t0, timedOut: false };
  }

  const searchPromise = knowledgeService.resolve({
    query: match.searchQuery,
    language: match.language,
    scope_tags: match.scope_tags,
    constraint_kind: match.constraint_kind,
    top_k: 3,
  });

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs),
  );

  const result = await Promise.race([searchPromise, timeoutPromise]);
  const latencyMs = performance.now() - t0;

  if (result === null) {
    return { matched: true, pattern: match.pattern, latencyMs, timedOut: true };
  }

  if (result.total === 0) {
    return { matched: true, pattern: match.pattern, latencyMs, timedOut: false };
  }

  return {
    matched: true,
    pattern: match.pattern,
    evidence: result,
    latencyMs,
    timedOut: false,
  };
}

/**
 * Format evidence results as a structured context block for injection
 * into the system/prefix messages.
 */
export function formatEvidenceBlock(result: FastPathResult): string | null {
  if (!result.evidence || result.evidence.total === 0) return null;

  const lines = [
    `<synesis_evidence pattern="${result.pattern}" source="rag_prefetch">`,
  ];

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
