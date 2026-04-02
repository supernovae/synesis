/**
 * Truncate and redact planner plan step actions before they appear in writer prompts.
 * Delegates pattern list to redactPatterns (core tier) — single source of truth with scanText.
 */

import { redactPatterns } from "./scanner.js";

/** Max characters of a step action string embedded in the writer outline. */
export const MAX_PLAN_STEP_ACTION_CHARS = 300;

export function sanitizePlanStepAction(action: string): string {
  const truncated = action.slice(0, MAX_PLAN_STEP_ACTION_CHARS);
  return redactPatterns(truncated, false);
}
