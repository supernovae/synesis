export const PROMPT_INTAKE_DECISION_SCHEMA_VERSION = "synesis_prompt_intake_decision_v1";

export type PromptScopeDecision = "micro" | "macro" | "unknown";
export type PromptIntakeAction = "allow" | "steer";

export interface PromptIntakeInput {
  prompt: string;
  planningOverride?: boolean;
  customStyle?: string;
}

export interface PromptIntakeDecision {
  schema_version: typeof PROMPT_INTAKE_DECISION_SCHEMA_VERSION;
  scope: PromptScopeDecision;
  action: PromptIntakeAction;
  planning_steered: boolean;
  override: boolean;
  reasons: string[];
  source_hash: string;
  custom_style?: string;
}

interface PatternRule {
  id: string;
  pattern: RegExp;
}

const MACRO_RULES: PatternRule[] = [
  { id: "macro.implement_new", pattern: /\bimplement\s+(?:a\s+|an\s+)?new\b/i },
  { id: "macro.broad_action", pattern: /\b(build|architect|design|scaffold|develop)\b/i },
  { id: "macro.create_macro_object", pattern: /\bcreate\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(app|application|service|system|platform|project|feature|workflow|pipeline|integration|api)\b/i },
  { id: "macro.from_scratch", pattern: /\b(from scratch|end[- ]to[- ]end|production[- ]ready)\b/i },
  { id: "macro.new_system_object", pattern: /\b(new|entire|whole|complete)\s+(app|application|service|system|platform|project|feature|workflow|pipeline|integration|api)\b/i },
  { id: "macro.broad_domain_object", pattern: /\b(auth|authentication|database|backend|frontend|full[- ]stack|payment|billing|multi[- ]tenant)\s+(system|service|workflow|feature|platform|integration|app)\b/i },
  { id: "macro.architecture_language", pattern: /\b(architecture|architectural|data flow|api contract|schema migration|rollout|migration plan)\b/i },
];

const MICRO_RULES: PatternRule[] = [
  { id: "micro.add_import", pattern: /\badd\s+(?:an?\s+)?import\b/i },
  { id: "micro.fix_tweak", pattern: /\b(fix|tweak|adjust|rename|remove|update|change)\b/i },
  { id: "micro.optimize_loop", pattern: /\boptimi[sz]e\s+(?:this\s+)?loop\b/i },
  { id: "micro.scoped_refactor", pattern: /\brefactor\s+(this|the)\s+(helper|function|method|class|file|component)\b/i },
  { id: "micro.named_file", pattern: /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|sh|yaml|yml|json|md|css|scss|html)\b/i },
  { id: "micro.local_scope", pattern: /\b(this|single|one)\s+(line|function|method|helper|file|component|loop|import)\b/i },
];

const NATURAL_LANGUAGE_OVERRIDE_RE = /\b(skip|no|without)\s+(?:the\s+)?plan(?:ning)?\b|\bjust\s+(?:code|do it|implement)\b/i;

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function matchRules(prompt: string, rules: PatternRule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.pattern.test(prompt)) out.push(rule.id);
  }
  return out;
}

export function hashPromptSignal(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i += 1) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function countWhitespaceSeparatedWords(value: string): number {
  let count = 0;
  let inWord = false;
  for (const ch of value) {
    const isWhitespace = ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\v";
    if (isWhitespace) {
      inWord = false;
    } else if (!inWord) {
      count += 1;
      inWord = true;
    }
  }
  return count;
}

function countSimpleWordOccurrences(value: string, words: Set<string>): number {
  let count = 0;
  for (const token of value.split(" ")) {
    const trimmed = token.trim().replaceAll(",", "").replaceAll(".", "").replaceAll(";", "").replaceAll(":", "");
    if (words.has(trimmed)) count += 1;
  }
  return count;
}

function countSentenceBreaks(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\n") {
      count += 1;
      continue;
    }
    if ((ch === "." || ch === ";") && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === " " || next === "\n" || next === "\r" || next === "\t") count += 1;
    }
  }
  return count;
}

function hasListOrMultiPartMarker(value: string): boolean {
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trimStart();
    if (line.length < 3) continue;
    const first = line[0];
    if ((first === "-" || first === "*") && line[1] === " " && line[2]?.trim()) return true;
    let index = 0;
    while (index < line.length && line.charCodeAt(index) >= 48 && line.charCodeAt(index) <= 57) index += 1;
    if (index > 0 && (line[index] === "." || line[index] === ")") && line[index + 1] === " " && line[index + 2]?.trim()) {
      return true;
    }
  }
  return false;
}

function complexPromptReasons(rawPrompt: string, normalized: string): string[] {
  const reasons: string[] = [];
  const words = normalized ? countWhitespaceSeparatedWords(normalized) : 0;
  const conjunctions = countSimpleWordOccurrences(normalized.toLowerCase(), new Set(["and", "also", "plus", "including", "with"]));
  const sentenceBreaks = countSentenceBreaks(rawPrompt);
  if (words >= 90 && conjunctions >= 3) reasons.push("macro.long_multi_clause_prompt");
  if (words >= 140) reasons.push("macro.long_prompt");
  if (hasListOrMultiPartMarker(rawPrompt) && words >= 25) reasons.push("macro.listed_requirements");
  if (sentenceBreaks >= 4 && conjunctions >= 2) reasons.push("macro.multi_sentence_requirements");
  return reasons;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function sanitizePromptIntakeCustomStyle(value: string | undefined): string | undefined {
  const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 500);
}

export function evaluatePromptIntake(input: PromptIntakeInput): PromptIntakeDecision {
  const rawPrompt = String(input.prompt ?? "");
  const normalized = normalizePrompt(rawPrompt);
  const sourceHash = hashPromptSignal(normalized);
  const customStyle = sanitizePromptIntakeCustomStyle(input.customStyle);
  const naturalLanguageOverride = NATURAL_LANGUAGE_OVERRIDE_RE.test(normalized);
  const override = input.planningOverride === true || naturalLanguageOverride;

  if (!normalized) {
    return {
      schema_version: PROMPT_INTAKE_DECISION_SCHEMA_VERSION,
      scope: "unknown",
      action: "allow",
      planning_steered: false,
      override,
      reasons: ["prompt.empty"],
      source_hash: sourceHash,
      ...(customStyle ? { custom_style: customStyle } : {}),
    };
  }

  const macroReasons = [
    ...matchRules(normalized, MACRO_RULES),
    ...complexPromptReasons(rawPrompt, normalized),
  ];
  const microReasons = matchRules(normalized, MICRO_RULES);
  const scope: PromptScopeDecision = macroReasons.length > 0
    ? "macro"
    : microReasons.length > 0
      ? "micro"
      : "unknown";
  const reasons = scope === "macro"
    ? macroReasons
    : scope === "micro"
      ? microReasons
      : ["prompt.no_scope_signal"];

  const shouldSteer = scope === "macro" && !override;
  if (naturalLanguageOverride && scope === "macro") {
    reasons.push("prompt.natural_language_override");
  }

  return {
    schema_version: PROMPT_INTAKE_DECISION_SCHEMA_VERSION,
    scope,
    action: shouldSteer ? "steer" : "allow",
    planning_steered: shouldSteer,
    override,
    reasons: dedupe(reasons),
    source_hash: sourceHash,
    ...(customStyle ? { custom_style: customStyle } : {}),
  };
}

export function buildPromptIntakeSystemBlock(decision: PromptIntakeDecision): string | null {
  if (!decision.planning_steered) return null;
  const reasons = decision.reasons.slice(0, 6).join(",");
  const lines = [
    `<synesis_prompt_intake scope="${decision.scope}" action="planning_suggested" source_hash="${decision.source_hash}">`,
    "This request appears broader than a micro edit. Before coding, suggest creating or approving a short plan, task list, or todos using the client's native task/todo mechanism or a plan file when available.",
    "Keep this advisory: do not claim planning is mandatory, do not block progress, and if the user declines or explicitly says to proceed, continue normally with small scoped steps.",
    "Prefer durable task tracking when the client already supports it, but do not require a new workspace file in this turn.",
    `classifier_reasons=${reasons || "macro"}`,
  ];
  if (decision.custom_style) {
    lines.push(`User style preference: ${decision.custom_style}`);
  }
  lines.push("</synesis_prompt_intake>");
  return lines.join("\n");
}
