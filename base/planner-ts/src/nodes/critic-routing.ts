import type { GraphNodeName, GraphState } from "../state/types.js";
import { detectOscillation } from "./oscillation-detector.js";

export function routeAfterCritic(
  state: GraphState,
  opts: { oscillationThreshold?: number; maxIterationsDefault?: number } = {}
): GraphNodeName {
  if (state.error) return "respond";

  const oscillationThreshold = opts.oscillationThreshold ?? 0.35;
  const osc = detectOscillation(state);
  if (osc.total_score > oscillationThreshold) return "final_scrubber";

  const iteration = state.iteration_count ?? 0;
  const maxIterDefault = opts.maxIterationsDefault ?? 4;
  const configuredMax = state.max_iterations ?? maxIterDefault;
  const critiquePasses = Number((state.execution_policy ?? {}).critique_passes ?? 1);
  const maxIter = Math.min(configuredMax, Math.max(1, critiquePasses + 1));

  const approved = state.critic_approved ?? true;
  const needEvidence = state.need_more_evidence ?? false;

  if ((approved && !needEvidence) || iteration >= maxIter) return "final_scrubber";
  if (needEvidence) return "router";
  if (!approved && (state.critic_should_continue ?? false)) return "writer";
  if (state.critic_continue_reason === "blocked_external" || state.critic_continue_reason === "needs_input") {
    return "respond";
  }
  return "respond";
}
