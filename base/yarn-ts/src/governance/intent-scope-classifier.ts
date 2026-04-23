/**
 * Intent Scope Classifier — Proportionality Governance Layer 1
 *
 * Classifies the user's prompt into a scope envelope that determines how
 * aggressively the proportionality governor watches for oversized changes.
 *
 * Runs once per genuine user message (cheap regex heuristics, no LLM call).
 * The envelope is stored on ChatState and persists across turns until a new
 * user message arrives.
 */

export type ScopeEnvelope =
  | "narrow_fix"         // "fix", "patch", "resolve" + security/bug context
  | "targeted_refactor"  // "refactor", "clean up", "modernize"
  | "broad_refactor"     // "rewrite", "replace entirely", "rebuild"
  | "removal_ok"         // user explicitly asked to remove/delete
  | "unconstrained";     // default — no proportionality constraints

export interface IntentScopeClassification {
  envelope: ScopeEnvelope;
  signals: string[];
  /** 0.0–1.0 risk modifier that feeds proportionality threshold scaling. */
  riskModifier: number;
}

export interface ScopeThresholds {
  maxFilesModified: number;
  maxNetLinesRemoved: number;
  maxFilesDeleted: number;
}

const NARROW_FIX_PATTERNS = [
  /\b(?:fix|patch|resolve|address|repair|correct)\b.*\b(?:security|vulnerab|CVE|bug|issue|error|defect|flaw|exploit|injection|XSS|CSRF|auth)/i,
  /\b(?:security|vulnerab|CVE|bug|issue|error|defect|flaw|exploit)\b.*\b(?:fix|patch|resolve|address|repair|correct)\b/i,
  /\b(?:fix|patch|resolve)\b.*\b(?:typo|lint|warning|deprecat)/i,
];

const TARGETED_REFACTOR_PATTERNS = [
  /\b(?:refactor|clean\s*up|tidy|modernize|simplify|improve|optimize|upgrade|update|migrate)\b/i,
  /\b(?:extract|split|reorganize|restructure|consolidate)\b/i,
];

const BROAD_REFACTOR_PATTERNS = [
  /\b(?:rewrite|rebuild|replace\s+entirely|redo|overhaul|rearchitect|redesign)\b/i,
  /\b(?:from\s+scratch|ground\s+up|complete\s+rewrite)\b/i,
];

const REMOVAL_PATTERNS = [
  /\b(?:remove|delete|drop|deprecate|eliminate|strip\s+out|get\s+rid\s+of)\b.*\b(?:feature|module|component|functionality|support|capability|code|file)\b/i,
  /\b(?:feature|module|component|functionality|support)\b.*\b(?:remove|delete|drop|deprecate|eliminate|strip)\b/i,
];

export function classifyIntentScope(userText: string): IntentScopeClassification {
  if (!userText || userText.trim().length < 5) {
    return { envelope: "unconstrained", signals: [], riskModifier: 0 };
  }

  const text = userText.trim();
  const signals: string[] = [];

  // Check removal first — if user explicitly asks to remove, don't constrain
  for (const pat of REMOVAL_PATTERNS) {
    if (pat.test(text)) {
      signals.push(`removal_match: ${pat.source.slice(0, 40)}`);
      return { envelope: "removal_ok", signals, riskModifier: 0 };
    }
  }

  // Broad refactor is wider than narrow fix
  for (const pat of BROAD_REFACTOR_PATTERNS) {
    if (pat.test(text)) {
      signals.push(`broad_refactor_match: ${pat.source.slice(0, 40)}`);
      return { envelope: "broad_refactor", signals, riskModifier: 0.2 };
    }
  }

  // Narrow fix — security/bug fix language
  for (const pat of NARROW_FIX_PATTERNS) {
    if (pat.test(text)) {
      signals.push(`narrow_fix_match: ${pat.source.slice(0, 40)}`);
      return { envelope: "narrow_fix", signals, riskModifier: 0.8 };
    }
  }

  // Targeted refactor
  for (const pat of TARGETED_REFACTOR_PATTERNS) {
    if (pat.test(text)) {
      signals.push(`targeted_refactor_match: ${pat.source.slice(0, 40)}`);
      return { envelope: "targeted_refactor", signals, riskModifier: 0.4 };
    }
  }

  return { envelope: "unconstrained", signals: ["no_scope_match"], riskModifier: 0 };
}

/**
 * Get proportionality thresholds for a given scope envelope.
 * Breaching these triggers the proportionality critic check.
 */
export function getScopeThresholds(
  envelope: ScopeEnvelope,
  overrides?: Partial<Record<ScopeEnvelope, Partial<ScopeThresholds>>>,
): ScopeThresholds | null {
  const defaults: Record<string, ScopeThresholds> = {
    narrow_fix: { maxFilesModified: 3, maxNetLinesRemoved: 50, maxFilesDeleted: 0 },
    targeted_refactor: { maxFilesModified: 10, maxNetLinesRemoved: 200, maxFilesDeleted: 2 },
    broad_refactor: { maxFilesModified: 25, maxNetLinesRemoved: 500, maxFilesDeleted: 5 },
  };

  if (envelope === "removal_ok" || envelope === "unconstrained") return null;

  const base = defaults[envelope];
  if (!base) return null;

  const envOverrides = overrides?.[envelope];
  if (!envOverrides) return base;

  return {
    maxFilesModified: envOverrides.maxFilesModified ?? base.maxFilesModified,
    maxNetLinesRemoved: envOverrides.maxNetLinesRemoved ?? base.maxNetLinesRemoved,
    maxFilesDeleted: envOverrides.maxFilesDeleted ?? base.maxFilesDeleted,
  };
}
