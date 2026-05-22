import type {
  ClassificationResult,
  ComplexityAssessment,
  ProjectKind,
} from "@synesis/manifest";
import { getAllTemplates } from "@synesis/manifest";

// ---------------------------------------------------------------------------
// Language detection (keyword -> language string)
// ---------------------------------------------------------------------------

const LANGUAGE_SIGNALS: ReadonlyArray<[RegExp, string]> = [
  [/\b(go\.mod|golang|\.go\b)/i, "go"],
  [/\b(python|\.py\b|pyproject|requirements\.txt|pip|uv run)/i, "python"],
  [/\b(typescript|\.ts\b|tsconfig|\.tsx\b)/i, "typescript"],
  [/\b(javascript|\.js\b|\.jsx\b|node)/i, "javascript"],
  [/\b(rust|cargo|\.rs\b)/i, "rust"],
  [/\b(java|\.java\b|maven|gradle)/i, "java"],
  [/\b(terraform|\.tf\b|hcl|tfvars)/i, "hcl"],
  [/\b(ansible|playbook\.ya?ml)/i, "yaml"],
  [/\b(helm|chart\.ya?ml)/i, "yaml"],
];

function detectLanguage(text: string): string {
  for (const [re, lang] of LANGUAGE_SIGNALS) {
    if (re.test(text)) return lang;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Project kind classification via template signal matching
// ---------------------------------------------------------------------------

interface ScoredKind {
  kind: ProjectKind;
  score: number;
  signals: string[];
}

export function classifyProject(text: string): ClassificationResult {
  const lower = text.toLowerCase();
  const language = detectLanguage(lower);
  const templates = getAllTemplates();
  const scored: ScoredKind[] = [];

  for (const tpl of templates) {
    let score = 0;
    const matched: string[] = [];
    for (const sig of tpl.classificationSignals) {
      if (lower.includes(sig.keyword.toLowerCase())) {
        score += sig.weight;
        matched.push(sig.keyword);
      }
    }
    if (score > 0) {
      scored.push({ kind: tpl.kind, score, signals: matched });
    }
  }

  if (scored.length === 0) {
    return { language, projectKind: "unknown", confidence: 0, signals: [] };
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const maxPossible = getAllTemplates()
    .find((t) => t.kind === best.kind)!
    .classificationSignals.reduce((s, sig) => s + sig.weight, 0);
  const confidence = Math.min(1, best.score / Math.max(maxPossible, 1));

  return {
    language,
    projectKind: best.kind,
    confidence: Math.round(confidence * 100) / 100,
    signals: best.signals,
  };
}

// ---------------------------------------------------------------------------
// Complexity assessment — determines how much manifest machinery to engage
// ---------------------------------------------------------------------------

const TINY_PATTERNS = [
  /^(hello|hi|hey)\b/i,
  /\b(explain|what is|how does|describe)\b/i,
  /\b(one.?liner|single file|quick fix|typo)\b/i,
];

const LARGE_PATTERNS = [
  /\b(architect|migration|multi.?service|monorepo|platform)\b/i,
  /\b(redesign|rewrite|overhaul)\b/i,
];

const MEDIUM_PATTERNS = [
  /\b(scaffold|create.*project|new.*project|bootstrap)\b/i,
  /\b(multi.?file|refactor.*across|add.*feature)\b/i,
];

export function assessComplexity(text: string, fileCount?: number): ComplexityAssessment {
  const signals: string[] = [];

  for (const re of TINY_PATTERNS) {
    if (re.test(text)) signals.push(`tiny:${re.source.slice(0, 30)}`);
  }
  if (signals.length > 0 && (fileCount ?? 0) <= 1) {
    return { complexity: "tiny", planRequired: false, signals };
  }

  const largeSignals: string[] = [];
  for (const re of LARGE_PATTERNS) {
    if (re.test(text)) largeSignals.push(`large:${re.source.slice(0, 30)}`);
  }
  if (largeSignals.length > 0) {
    return { complexity: "large", planRequired: true, signals: largeSignals };
  }

  const mediumSignals: string[] = [];
  for (const re of MEDIUM_PATTERNS) {
    if (re.test(text)) mediumSignals.push(`medium:${re.source.slice(0, 30)}`);
  }
  if (mediumSignals.length > 0 || (fileCount ?? 0) >= 5) {
    if (fileCount !== undefined && fileCount >= 5) mediumSignals.push("medium:file_count");
    return { complexity: "medium", planRequired: false, signals: mediumSignals };
  }

  return { complexity: "small", planRequired: false, signals: ["default"] };
}

// ---------------------------------------------------------------------------
// Combined classification + complexity in one call
// ---------------------------------------------------------------------------

export interface FullClassification {
  classification: ClassificationResult;
  complexity: ComplexityAssessment;
}

export function classify(text: string, fileCount?: number): FullClassification {
  return {
    classification: classifyProject(text),
    complexity: assessComplexity(text, fileCount),
  };
}
