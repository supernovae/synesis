import type { ExecutionGovernorDecision } from "./execution-governor.js";

/**
 * Stalls that are not driven by repeated failing verification; safe to
 * nudge once in implementation (coding) mode before a full soft-fail pause.
 */
export const IMPLEMENTATION_SOFT_STALL_NUDGE_RULES = new Set([
  "exploration_stall_no_edit",
  "no_progress_loop",
]);

export function isOnlyImplementationSoftStallRules(matched: string[]): boolean {
  if (!matched || matched.length === 0) return false;
  if (matched.includes("allow")) return false;
  return matched.every((r) => IMPLEMENTATION_SOFT_STALL_NUDGE_RULES.has(r));
}

export function buildImplementationSoftStallNudgeMessage(decision: Pick<ExecutionGovernorDecision, "suggestedNextStep">): string {
  const next = (decision.suggestedNextStep ?? "").trim();
  return [
    "IMPLEMENTATION NUDGE (governor, non-blocking): This session is in implementation (coding) mode, but the last tool loop resembled exploration or no clear progress without edits.",
    "Take one small concrete step next: pick one file to change, make a single focused Write/StrReplace, or run one narrow test scoped to that change. Skip broad search/read/discovery for this turn unless you must disambiguate.",
    next ? `Reference: ${next.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n\n");
}
