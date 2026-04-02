/**
 * When to apply destructive user-input mitigations (redact / block) vs log-only.
 * Used by planner-ts; keeps policy testable without Fastify.
 */

export type InjectionContentAction = "reduce" | "block" | "log";

/**
 * @param patternsFound — flattened pattern substrings from scanUserInput (may include duplicates)
 * @param action — configured SYNESIS_INJECTION_ACTION
 * @param requireDualSignal — when true, reduce/block only if at least two pattern hits (fewer false positives for quoted/academic single phrases)
 */
export function shouldApplyUserInjectionMitigation(
  patternsFound: string[],
  action: InjectionContentAction,
  requireDualSignal: boolean,
): boolean {
  if (action === "log") return false;
  const n = patternsFound.length;
  if (n === 0) return false;
  if (!requireDualSignal) return true;
  return n >= 2;
}
