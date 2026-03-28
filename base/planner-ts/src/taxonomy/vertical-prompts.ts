/**
 * Vertical prompt helpers — ports Python taxonomy_prompt_factory.py vertical functions.
 *
 * Reads vertical_prompts from the MergedOntologySnapshot (already merged by
 * merge-plugins.ts). No separate file scan.
 */

import type { VerticalPrompt } from "../ontology/merge-plugins.js";

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
    const refList = (vp.active_domain_refs ?? []).map((r) => r.trim().toLowerCase());
    let score = refs.filter((r) => refList.includes(r)).length;

    const aliases = (vp.platform_context_aliases ?? []).map((a) => a.trim().toLowerCase());
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
  let base = (vp.worker_persona_block ?? "").trim();

  const signals = vp.compliance_signals;
  const triggers = vp.compliance_trigger_keywords;
  if (signals && triggers && taskDesc) {
    const lower = taskDesc.toLowerCase();
    const matched: string[] = [];
    for (const [key, keywords] of Object.entries(triggers)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        const text = signals[key];
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
    return vp.planner_decomposition_rules.trim();
  }

  if (taxonomyMetadata) {
    const rules = String(taxonomyMetadata.planner_decomposition_rules ?? "").trim();
    if (rules) return rules;
  }

  if (taxonomyKey && taxonomyKey !== vertical && taxonomyMetadata) {
    const rules = String(taxonomyMetadata.planner_decomposition_rules ?? "").trim();
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
  const mode = (vp.critic_mode ?? "advisory").trim().toLowerCase();
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
  return (vp.critic_tiers[tier] ?? "").trim();
}

/**
 * Pick critic tier from difficulty (matching Python heuristic).
 */
export function selectCriticTier(difficulty: number): "basic" | "advanced" | "research" {
  if (difficulty >= 0.7) return "research";
  if (difficulty >= 0.4) return "advanced";
  return "basic";
}
