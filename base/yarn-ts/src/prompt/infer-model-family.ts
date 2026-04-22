/**
 * Maps admin tier **backend** model id strings to Prompt Library `model_family` slugs.
 * Kept in sync with:
 * - `base/admin/frontend/src/constants/promptModelFamilies.ts` (UI picklist)
 * - `base/admin/app/services/prompt_library.py` (`ALLOWED_MODEL_FAMILY_VALUES`)
 * - `base/planner-ts/src/prompt-composer.ts` (duplicate `inferModelFamily` for chat)
 *
 * Used when composing `promptContext.modelFamily` for `StablePrefixService` so
 * `model_family` prompt assignments (e.g. Kimi, MiniMax) match what the operator configured.
 */
export function inferModelFamily(backendModel: string): string {
  const m = (backendModel || "").toLowerCase();
  if (/qwen3.*coder/.test(m)) return "qwen3-coder";
  if (/deepseek/.test(m)) return "deepseek";
  if (/kimi|moonshot/.test(m)) return "kimi";
  if (/minimax|abab/.test(m)) return "minimax";
  return "generic";
}
