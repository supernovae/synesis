/**
 * Canonical `target_value` when Prompt Library assignment `target_type` is `model_family`.
 * Must stay in sync with:
 * - `inferModelFamily()` in `base/yarn-ts/src/index.ts`
 * - `inferModelFamily()` in `base/planner-ts/src/prompt-composer.ts`
 * - `ALLOWED_MODEL_FAMILY_VALUES` in `base/admin/app/services/prompt_library.py`
 *
 * Stored value is always the lowercase slug (e.g. `kimi`), not display names like "Kimi / Moonshot".
 */
export const PROMPT_MODEL_FAMILY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "generic", label: "generic — unknown / unmatched backend model id" },
  { value: "qwen3-coder", label: "qwen3-coder — Qwen3 Coder (incl. qwen3-coder-next)" },
  { value: "deepseek", label: "deepseek — DeepSeek" },
  { value: "kimi", label: "kimi — Kimi / Moonshot (Moonshot API ids)" },
  { value: "minimax", label: "minimax — MiniMax / abab" },
] as const;

export const PROMPT_MODEL_FAMILY_VALUE_SET = new Set(PROMPT_MODEL_FAMILY_OPTIONS.map((o) => o.value));
