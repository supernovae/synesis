import { CriticOutSchema, type CriticOut } from "../contracts/schemas.js";
import { chatCompletion, isLlmAvailable, ZERO_USAGE, type LlmUsage } from "../llm/client.js";
import type { GraphState } from "../state/types.js";
import { validateWithRepair } from "../validation/json-repair.js";

export type CriticResult = CriticOut & { usage: LlmUsage };

function scoreDraft(state: GraphState): CriticOut["scores"] {
  const draft = state.generated_code ?? "";
  const hasEvidence = (state.evidence_packets ?? []).length > 0;
  const hasCitation = draft.includes("[Source:");

  const grounding = hasEvidence && hasCitation ? 8 : hasEvidence ? 6 : 3;
  const correctness = draft.length > 80 ? 7 : 4;
  const hasActionableContent = /```|\d+\.\s|^[-*]\s.{10,}/m.test(draft);
  const actionability = hasActionableContent ? 7 : 4;
  const clarity = draft.length > 200 ? 7 : 5;
  const weighted_overall = Number(
    ((grounding * 0.35) + (correctness * 0.25) + (actionability * 0.2) + (clarity * 0.2)).toFixed(2)
  );
  return { grounding, correctness, actionability, clarity, weighted_overall };
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

  const definitivePhrases = /\b(definitely|certainly|always|never|guaranteed|impossible)\b/i;
  const confidence = state.planner_confidence ?? 0.7;
  if (confidence < 0.6 && definitivePhrases.test(draft) && !hasAssumptionTags && !hasEstimateTags) {
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

  const assumptionChecks = checkAssumptionLabels(state);
  blocking_issues.push(...assumptionChecks.blocking);
  nonblocking.push(...assumptionChecks.nonblocking);

  return {
    approved: blocking_issues.length === 0,
    need_more_evidence: false,
    continue_reason: blocking_issues.length > 0 ? "needs_revision" : undefined,
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
  const result = await chatCompletion({
    model: process.env.SYNESIS_PLANNER_TS_CRITIC_MODEL ?? "Synesis",
    temperature: 0,
    max_tokens: state.critic_max_tokens ?? 1200,
    messages: [
      {
        role: "system",
        content:
          "You are Synesis Critic. Output only valid JSON matching keys: approved, need_more_evidence, continue_reason, blocking_issues, nonblocking, repair_instructions, scores.",
      },
      {
        role: "user",
        content: `Evaluate this response:\n\n${state.generated_code ?? ""}\n\nEvidence packet count: ${(state.evidence_packets ?? []).length}${assumptionContext}`,
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
