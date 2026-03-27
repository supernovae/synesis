/**
 * Sanitize step actions from the planner before injection into downstream prompts.
 *
 * Port of _step_sanitizer.py — keep in sync.
 */

const MAX_ACTION_LEN = 300;

const ACTION_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /new\s+instructions?\s*:/gi,
  /override\s+(?:your\s+)?(?:instructions?|prompt)/gi,
  /you\s+are\s+now\s+(?:a|an)\s/gi,
  /system\s*:\s*/gi,
  /<\|im_start\|>/gi,
  /\[INST\]/gi,
];

export function sanitizeStepAction(action: string): string {
  let result = action.slice(0, MAX_ACTION_LEN);
  for (const pat of ACTION_INJECTION_PATTERNS) {
    result = result.replace(pat, "[redacted]");
  }
  return result;
}
