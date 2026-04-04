import { ZERO_USAGE, type LlmUsage } from "@synesis/telemetry";
import type { AppConfig } from "./config.js";

/** Difficulty is expected in [0, 1]; values outside are clipped. */
export function clipDifficulty01(d: number): number {
  return Math.max(0, Math.min(1, d));
}

/**
 * Writer output budget: trivial fast-path uses a fixed small budget; otherwise
 * linear in difficulty between base and max (parity with Python `config.py`).
 */
export function computeScaledWriterBudget(
  cfg: AppConfig,
  difficulty: number,
  taskIsTrivial: boolean,
): number {
  if (taskIsTrivial) return cfg.SYNESIS_PLANNER_TS_TRIVIAL_WRITER_BUDGET;
  const d = clipDifficulty01(difficulty);
  const base = cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE;
  const max = cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MAX;
  return Math.round(base + d * (max - base));
}

/**
 * Critic budget scales with difficulty, then clamps to `CRITIC_MAX_TOKENS`.
 */
export function computeScaledCriticBudget(cfg: AppConfig, difficulty: number): number {
  const d = clipDifficulty01(difficulty);
  const base = cfg.SYNESIS_PLANNER_TS_CRITIC_BUDGET_BASE;
  const max = cfg.SYNESIS_PLANNER_TS_CRITIC_BUDGET_MAX;
  const scaled = Math.round(base + d * (max - base));
  return Math.min(scaled, cfg.SYNESIS_PLANNER_TS_CRITIC_MAX_TOKENS);
}

/** Apply model-tier ceiling: scaled budget cannot exceed the tier's writer/critic cap. */
export function clampBudgetToTierCeiling(scaled: number, tierCeiling: number): number {
  return Math.min(scaled, tierCeiling);
}

/**
 * Maps policy target to the writer LLM `max_tokens` (effective cap).
 * - `enforced`: effective equals target (clamped by tier and safety ceiling).
 * - `audit`: effective is at least `AUDIT_FLOOR` so low targets do not truncate output,
 *   while `writer_budget_target` still records the policy intent.
 */
export function computeWriterEffectiveMaxTokens(
  cfg: AppConfig,
  target: number,
  tierCeiling: number,
): number {
  const safety = Math.min(
    cfg.SYNESIS_PLANNER_TS_WRITER_OUTPUT_SAFETY_CEILING,
    tierCeiling,
  );
  if (cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE === "enforced") {
    return Math.min(Math.max(0, target), safety);
  }
  const floored = Math.max(target, cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_AUDIT_FLOOR);
  return Math.min(floored, safety);
}

export function budgetUtilization(completionTokens: number, maxOutputTokens: number): number | undefined {
  if (maxOutputTokens <= 0) return undefined;
  return Number((completionTokens / maxOutputTokens).toFixed(4));
}

/**
 * Budget + usage metadata for any LLM-calling span (writer, critic, planner, router).
 * Merged into `endSpan({ metadata })` so operators can correlate budget caps with actual usage.
 */
export function budgetSpanMetadata(
  maxOutputTokens: number,
  usage: LlmUsage | undefined,
): Record<string, unknown> {
  const u = usage ?? ZERO_USAGE;
  const completion = u.completion_tokens ?? 0;
  const util = budgetUtilization(completion, maxOutputTokens);
  return {
    max_output_tokens: maxOutputTokens,
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    ...(util !== undefined ? { budget_utilization: util } : {}),
  };
}

/** @deprecated Use `budgetSpanMetadata` — renamed for clarity since it applies to all LLM spans. */
export const writerBudgetSpanMetadata = budgetSpanMetadata;
