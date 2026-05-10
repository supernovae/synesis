import { CriticOutSchema, type CriticOut } from "../contracts/schemas.js";
import { chatCompletion, isLlmAvailable, ZERO_USAGE, type LlmUsage } from "../llm/client.js";
import type { GraphState } from "../state/types.js";
import { validateWithRepair } from "../validation/json-repair.js";
import { loadConfig } from "../config.js";
import { TRUST_POLICY_COMPACT } from "../security/trust-prompts.js";
import { getCriticRegulatedBlock, getCriticAssistantSystemsBlock } from "../taxonomy/taxonomy-prompt-factory.js";
import { getCriticMode, getCriticTierPrompt, selectCriticTier } from "../taxonomy/vertical-prompts.js";
import { getOntologySnapshot } from "../ontology/merge-plugins.js";
import { composePlannerPrompt } from "../prompt-composer.js";

export type CriticResult = CriticOut & { usage: LlmUsage };

function scoreDraft(state: GraphState): CriticOut["scores"] {
  const draft = state.generated_code ?? "";
  const packets = state.evidence_packets ?? [];
  const hasEvidence = packets.length > 0;
  const hasCitation = draft.includes("[Source:");
  const citationCount = (draft.match(/\[Source:/g) ?? []).length;

  const grounding = hasEvidence && hasCitation ? 8 : hasEvidence ? 6 : 3;
  const correctness = draft.length > 80 ? 7 : 4;
  const hasActionableContent = /```|\d+\.\s|^[-*]\s.{10,}/m.test(draft);
  const actionability = hasActionableContent ? 7 : 4;
  const clarity = draft.length > 200 ? 7 : 5;

  let evidence_utilization = 0;
  if (!hasEvidence) {
    evidence_utilization = 5;
  } else {
    const ratio = Math.min(1, citationCount / packets.length);
    evidence_utilization = Math.round(3 + ratio * 7);
  }

  const weighted_overall = Number(
    ((grounding * 0.3) + (correctness * 0.2) + (actionability * 0.15) + (clarity * 0.15) + (evidence_utilization * 0.2)).toFixed(2)
  );
  return { grounding, correctness, actionability, clarity, evidence_utilization, weighted_overall };
}

function checkAssumptionLabels(state: GraphState): {
  blocking: CriticOut["blocking_issues"];
  nonblocking: CriticOut["nonblocking"];
} {
  const blocking: CriticOut["blocking_issues"] = [];
  const nonblocking: CriticOut["nonblocking"] = [];

  if (!state.show_assumptions) return { blocking, nonblocking };

  const draft = state.generated_code ?? "";
  const assumptions = state.assumptions ?? [];
  const hasAssumptionTags = /\[Assumption[:\]]/.test(draft);
  const hasEstimateTags = /\[Estimate[:\]]/.test(draft);
  const hasTargetTags = /\[Target[:\]]/.test(draft);
  const hasMeasuredTags = /\[Measured[:\]]/.test(draft);
  const hasAnyEpistemicTag = hasAssumptionTags || hasEstimateTags || hasTargetTags || hasMeasuredTags;

  if (assumptions.length > 0 && !hasAssumptionTags) {
    nonblocking.push({
      item_id: "assumption_labels_missing",
      category: "transparency",
      description: `Plan has ${assumptions.length} assumption(s) but response lacks [Assumption] tags.`,
      status: "open" as const,
      evidence_ref: "",
      resolved_by: "",
      reopen_count: 0,
    });
  }

  const hasNumericClaims = /\b\d{2,}[\s%]|\b\d+\.\d+\b/.test(draft);
  if (hasNumericClaims && !hasEstimateTags && !hasTargetTags && !hasMeasuredTags) {
    nonblocking.push({
      item_id: "numeric_labels_missing",
      category: "transparency",
      description: "Response contains numeric claims but lacks [Estimate], [Target], or [Measured] labels.",
      status: "open" as const,
      evidence_ref: "",
      resolved_by: "",
      reopen_count: 0,
    });
  }

  const definitivePhrases = /\b(definitely|certainly|always|never|guaranteed|impossible)\b/i;
  const confidence = state.planner_confidence ?? 0.7;
  if (confidence < 0.6 && definitivePhrases.test(draft) && !hasAnyEpistemicTag) {
    nonblocking.push({
      item_id: "false_certainty",
      category: "transparency",
      description: "Response uses definitive language but planner confidence is low; consider qualifying claims.",
      status: "open" as const,
      evidence_ref: "",
      resolved_by: "",
      reopen_count: 0,
    });
  }

  return { blocking, nonblocking };
}

function deterministicCritic(state: GraphState): CriticOut {
  const scores = scoreDraft(state);
  const blocking_issues: CriticOut["blocking_issues"] = [];
  const nonblocking: CriticOut["nonblocking"] = [];
  const repair_instructions: CriticOut["repair_instructions"] = [];
  const hasUsableSources = (state.evidence_packets ?? []).some((packet) => (packet.sources ?? []).length > 0);

  if (hasUsableSources && !(state.generated_code ?? "").includes("[Source:")) {
    blocking_issues.push({
      item_id: "missing_citation",
      category: "grounding",
      description: "Evidence exists but response does not cite sources.",
      status: "open" as const,
      evidence_ref: "evidence_packets",
      resolved_by: "",
      reopen_count: 0,
    });
    repair_instructions.push({
      priority: 1,
      target: "citations",
      action: "add_source_citations",
      reason: "grounding contract requires explicit source usage",
    });
  }

  if ((state.generated_code ?? "").length < 80) {
    nonblocking.push({
      item_id: "short_response",
      category: "clarity",
      description: "Response is brief; consider expanding key decisions.",
      status: "open" as const,
      evidence_ref: "",
      resolved_by: "",
      reopen_count: 0,
    });
  }

  const draftText = state.generated_code ?? "";
  const describesRoutingSystem = /\b(rout(er?|ing)|escalat(e|ion)|failover|triage|dispatch)\b/i.test(draftText)
    && /\b(request|query|message|ticket)\b/i.test(draftText);
  const mentionsRefusalPolicy = /\b(refus|reject|out[- ]of[- ]scope|decline|unsupported)\b/i.test(draftText);
  if (describesRoutingSystem && !mentionsRefusalPolicy) {
    nonblocking.push({
      item_id: "missing_escalation_refusal_policy",
      category: "completeness",
      description: "Response describes a routing/escalation system but does not state when to refuse, decline, or handle out-of-scope requests.",
      status: "open" as const,
      evidence_ref: "",
      resolved_by: "",
      reopen_count: 0,
    });
  }

  const assumptionChecks = checkAssumptionLabels(state);
  blocking_issues.push(...assumptionChecks.blocking);
  nonblocking.push(...assumptionChecks.nonblocking);

  const noUsableEvidence = !hasUsableSources && scores.evidence_utilization < 4;
  const need_more_evidence = !!(blocking_issues.length > 0 && noUsableEvidence && (state.rag_mode ?? "disabled") !== "disabled");

  let continue_reason: string | undefined;
  if (blocking_issues.length > 0) {
    continue_reason = need_more_evidence ? "needs_evidence" : "needs_revision";
  }

  return {
    approved: blocking_issues.length === 0,
    need_more_evidence,
    continue_reason,
    blocking_issues,
    nonblocking,
    repair_instructions,
    scores,
  };
}

async function llmCritic(state: GraphState): Promise<CriticResult> {
  if (!isLlmAvailable()) {
    throw new Error("LLM critic unavailable");
  }
  const assumptions = state.assumptions ?? [];
  const assumptionContext = assumptions.length > 0 && state.show_assumptions
    ? `\n\nPlanner assumptions: ${assumptions.join("; ")}. Check that material assumptions are tagged with [Assumption] and definitive claims about uncertain topics are qualified.`
    : "";
  // Build taxonomy hints for the critic (matching Python _build_taxonomy_hints)
  const taxonomyMeta = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
  const difficulty = state.difficulty ?? 0;
  const taxonomyHintParts: string[] = [];
  const domain = String(taxonomyMeta.path ?? "General").trim();
  const taxonomyComplexity = Number(taxonomyMeta.complexity_score ?? 0.5);
  const requiredElements = (taxonomyMeta.required_elements ?? []) as string[];
  const depthGuidance = String(taxonomyMeta.depth_instructions ?? "").trim();
  const personaHint = String(taxonomyMeta.persona_instructions ?? "").trim();

  taxonomyHintParts.push(`Domain: ${domain}`, `Complexity: ${taxonomyComplexity.toFixed(1)}`);
  if (requiredElements.length > 0) {
    const joined = requiredElements.join(", ");
    if (taxonomyComplexity >= 0.8) {
      taxonomyHintParts.push(`Expected sections for this domain (flag as insufficient_depth if missing): ${joined}`);
    } else {
      taxonomyHintParts.push(`Typical elements for this domain: ${joined}`);
    }
  }
  if (depthGuidance) taxonomyHintParts.push(`Depth guidance: ${depthGuidance}`);
  if (personaHint) taxonomyHintParts.push(`Tone/persona: ${personaHint}`);
  taxonomyHintParts.push(`Difficulty: ${difficulty.toFixed(2)}`);
  const taxonomyHints = taxonomyHintParts.join("\n");

  // Regulated / assistant-systems blocks
  const regulatedBlock = getCriticRegulatedBlock(taxonomyMeta);
  const assistantBlock = getCriticAssistantSystemsBlock(taxonomyMeta);

  // Vertical critic steering
  const activeVertical = String(taxonomyMeta.active_vertical ?? "generic");
  const snap = getOntologySnapshot();
  const criticMode = getCriticMode(snap.verticalPrompts, activeVertical);
  let verticalCriticBlock = "";
  if (criticMode === "tiered") {
    const tier = selectCriticTier(difficulty);
    const tierPrompt = getCriticTierPrompt(snap.verticalPrompts, activeVertical, tier);
    if (tierPrompt) verticalCriticBlock = `\nCritic tier (${tier}):\n${tierPrompt}`;
  }

  const dynamicSuffix = [taxonomyHints, regulatedBlock, assistantBlock, verticalCriticBlock]
    .filter(Boolean)
    .join("\n\n");

  const criticModel = process.env.SYNESIS_PLANNER_TS_CRITIC_MODEL ?? "synesis-critic";
  const criticSystemPrompt = composePlannerPrompt(
    `You are Synesis Critic. Output only valid JSON matching keys: approved, need_more_evidence, continue_reason, blocking_issues, nonblocking, repair_instructions, scores.\n\n${TRUST_POLICY_COMPACT}`,
    {
      tier: state.model_tier,
      role: "critic",
      node: "critic",
      model: criticModel,
    },
  ).content;
  const result = await chatCompletion({
    model: criticModel,
    temperature: 0,
    max_tokens: state.critic_max_tokens ?? loadConfig().SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE,
    pricingRates: state.pricing_rates_by_role?.critic,
    request_id: state.run_id,
    authz_trace_id: state.authz_trace_id,
    traceparent: state.traceparent,
    messages: [
      {
        role: "system",
        content: criticSystemPrompt,
      },
      {
        role: "user",
        content: `Evaluate this response:\n\n${state.generated_code ?? ""}\n\nEvidence packet count: ${(state.evidence_packets ?? []).length}${assumptionContext}\n\nTaxonomy context:\n${dynamicSuffix}`,
      },
    ],
  });
  const parsed = validateWithRepair(result.content, CriticOutSchema);
  return { ...parsed, usage: result.usage };
}

export async function evaluateCritic(state: GraphState): Promise<CriticResult> {
  const raw = state.critic_raw_json;
  if (typeof raw === "string" && raw.trim()) {
    return { ...validateWithRepair(raw, CriticOutSchema), usage: ZERO_USAGE };
  }
  if (isLlmAvailable()) {
    try {
      return await llmCritic(state);
    } catch {
      // Fall through to deterministic critic.
    }
  }
  return { ...deterministicCritic(state), usage: ZERO_USAGE };
}
