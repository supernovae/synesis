/**
 * Vertical prompt helpers for merged ontology prompt fragments.
 *
 * Reads vertical_prompts from the MergedOntologySnapshot (already merged by
 * merge-plugins.ts). No separate file scan.
 */

import type { VerticalPrompt } from "../ontology/merge-plugins.js";

const TEXT_LIMIT = 2000;
const SHORT_TEXT_LIMIT = 256;
const LIST_ITEM_LIMIT = 120;

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 31 || code === 127 ? " " : char;
  }
  return out;
}

function safeVerticalText(value: unknown, max = TEXT_LIMIT): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return replaceControlCharsWithSpace(String(value))
    .replace(/[<"`=]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function safeVerticalList(value: unknown, maxItems = 32): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = safeVerticalText(item, LIST_ITEM_LIMIT).toLowerCase();
    if (text) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolveActiveVertical
// ---------------------------------------------------------------------------

/**
 * Match active_domain_refs against vertical plugin domain lists.
 * Scores by hit count + optional platform_context alias match.
 * Returns canonical vertical name (e.g. "llm_rag", "medical", "generic").
 */
export function resolveActiveVertical(
  verticalPrompts: Record<string, VerticalPrompt>,
  activeDomainRefs: string[],
  platformContext?: string,
): string {
  const refs = activeDomainRefs.map((r) => r.trim().toLowerCase()).filter(Boolean);
  const ctx = (platformContext ?? "").trim().toLowerCase();

  let bestName = "generic";
  let bestScore = 0;

  for (const [name, vp] of Object.entries(verticalPrompts)) {
    const refList = safeVerticalList(vp.active_domain_refs);
    let score = refs.filter((r) => refList.includes(r)).length;

    const aliases = safeVerticalList(vp.platform_context_aliases);
    if (ctx && aliases.includes(ctx)) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  return bestName;
}

// ---------------------------------------------------------------------------
// Persona / decomposition / critic helpers
// ---------------------------------------------------------------------------

export function getWorkerPersonaBlock(
  verticalPrompts: Record<string, VerticalPrompt>,
  vertical: string,
  taskDesc?: string,
): string {
  const vp = verticalPrompts[vertical];
  if (!vp) return "";
  let base = safeVerticalText(vp.worker_persona_block);

  const signals = vp.compliance_signals;
  const triggers = vp.compliance_trigger_keywords;
  if (signals && triggers && taskDesc) {
    const lower = taskDesc.toLowerCase();
    const matched: string[] = [];
    for (const [key, keywords] of Object.entries(triggers)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        const text = safeVerticalText(signals[key], SHORT_TEXT_LIMIT);
        if (text) matched.push(`- ${text}`);
      }
    }
    if (matched.length > 0) {
      base += "\nAdditional considerations (user context signals these):\n" + matched.join("\n");
    }
  }

  return base;
}

/**
 * Planner decomposition rules: vertical plugin first, then taxonomy YAML by
 * vertical name, then taxonomy YAML by taxonomy_key.
 */
export function getPlannerDecompositionRules(
  verticalPrompts: Record<string, VerticalPrompt>,
  vertical: string,
  taxonomyMetadata?: Record<string, unknown>,
  taxonomyKey?: string,
): string {
  const vp = verticalPrompts[vertical];
  if (vp?.planner_decomposition_rules) {
    return safeVerticalText(vp.planner_decomposition_rules);
  }

  if (taxonomyMetadata) {
    const rules = safeVerticalText(taxonomyMetadata.planner_decomposition_rules);
    if (rules) return rules;
  }

  if (taxonomyKey && taxonomyKey !== vertical && taxonomyMetadata) {
    const rules = safeVerticalText(taxonomyMetadata.planner_decomposition_rules);
    if (rules) return rules;
  }

  return "";
}

export function getCriticMode(
  verticalPrompts: Record<string, VerticalPrompt>,
  vertical: string,
): "safety_ii" | "tiered" | "advisory" {
  const vp = verticalPrompts[vertical];
  if (!vp) return "advisory";
  const mode = safeVerticalText(vp.critic_mode, SHORT_TEXT_LIMIT).toLowerCase() || "advisory";
  if (mode === "safety_ii" || mode === "tiered") return mode;
  return "advisory";
}

/**
 * For tiered critic: select tier based on difficulty/task_size.
 */
export function getCriticTierPrompt(
  verticalPrompts: Record<string, VerticalPrompt>,
  vertical: string,
  tier: "basic" | "advanced" | "research",
): string {
  const vp = verticalPrompts[vertical];
  if (!vp?.critic_tiers) return "";
  return safeVerticalText(vp.critic_tiers[tier]);
}

/**
 * Pick critic tier from difficulty.
 */
export function selectCriticTier(difficulty: number): "basic" | "advanced" | "research" {
  if (difficulty >= 0.7) return "research";
  if (difficulty >= 0.4) return "advanced";
  return "basic";
}
