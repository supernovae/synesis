/**
 * Re-export plan-step sanitization from @synesis/context-trust (same patterns as redactPatterns / scanText).
 * `sanitizeStepAction` is the historical planner name used by writer-compose.
 */

export {
  sanitizePlanStepAction,
  sanitizePlanStepAction as sanitizeStepAction,
  MAX_PLAN_STEP_ACTION_CHARS,
} from "@synesis/context-trust";
