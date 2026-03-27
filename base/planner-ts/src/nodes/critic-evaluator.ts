import { CriticOutSchema, type CriticOut } from "../contracts/schemas.js";
import { chatCompletion, isLlmAvailable } from "../llm/client.js";
import type { GraphState } from "../state/types.js";
import { validateWithRepair } from "../validation/json-repair.js";

function scoreDraft(state: GraphState): CriticOut["scores"] {
  const draft = state.generated_code ?? "";
  const hasEvidence = (state.evidence_packets ?? []).length > 0;
  const hasCitation = draft.includes("[Source:");

  const grounding = hasEvidence && hasCitation ? 8 : hasEvidence ? 6 : 3;
  const correctness = draft.length > 80 ? 7 : 4;
  const actionability = draft.includes("## Plan") ? 7 : 4;
  const clarity = draft.includes("# ") ? 7 : 5;
  const weighted_overall = Number(
    ((grounding * 0.35) + (correctness * 0.25) + (actionability * 0.2) + (clarity * 0.2)).toFixed(2)
  );
  return { grounding, correctness, actionability, clarity, weighted_overall };
}

function deterministicCritic(state: GraphState): CriticOut {
  const scores = scoreDraft(state);
  const blocking_issues = [];
  const nonblocking = [];
  const repair_instructions = [];
  const hasUsableSources = (state.evidence_packets ?? []).some((packet) => (packet.sources ?? []).length > 0);

  if (hasUsableSources && !(state.generated_code ?? "").includes("[Source:")) {
    blocking_issues.push({
      item_id: "missing_citation",
      category: "grounding",
      description: "Evidence exists but response does not cite sources.",
      status: "open" as const,
      evidence_ref: "evidence_packets",
      resolved_by: "",
      reopen_count: 0
    });
    repair_instructions.push({
      priority: 1,
      target: "citations",
      action: "add_source_citations",
      reason: "grounding contract requires explicit source usage"
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
      reopen_count: 0
    });
  }

  return {
    approved: blocking_issues.length === 0,
    need_more_evidence: false,
    continue_reason: blocking_issues.length > 0 ? "needs_revision" : undefined,
    blocking_issues,
    nonblocking,
    repair_instructions,
    scores
  };
}

async function llmCritic(state: GraphState): Promise<CriticOut> {
  if (!isLlmAvailable()) {
    throw new Error("LLM critic unavailable");
  }
  const content = await chatCompletion({
    model: process.env.SYNESIS_PLANNER_TS_CRITIC_MODEL ?? "Synesis",
    temperature: 0,
    max_tokens: state.critic_max_tokens ?? 1200,
    messages: [
      {
        role: "system",
        content:
          "You are Synesis Critic. Output only valid JSON matching keys: approved, need_more_evidence, continue_reason, blocking_issues, nonblocking, repair_instructions, scores."
      },
      {
        role: "user",
        content: `Evaluate this response:\n\n${state.generated_code ?? ""}\n\nEvidence packet count: ${(state.evidence_packets ?? []).length}`
      }
    ]
  });
  return validateWithRepair(content, CriticOutSchema);
}

export async function evaluateCritic(state: GraphState): Promise<CriticOut> {
  const raw = state.critic_raw_json;
  if (typeof raw === "string" && raw.trim()) {
    return validateWithRepair(raw, CriticOutSchema);
  }
  if (isLlmAvailable()) {
    try {
      return await llmCritic(state);
    } catch {
      // Fall through to deterministic critic.
    }
  }
  return deterministicCritic(state);
}
