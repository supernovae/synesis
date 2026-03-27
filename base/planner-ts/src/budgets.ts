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

export function budgetUtilization(completionTokens: number, maxOutputTokens: number): number | undefined {
  if (maxOutputTokens <= 0) return undefined;
  return Number((completionTokens / maxOutputTokens).toFixed(4));
}

/** Metadata merged into writer/critic span `metadata` for budget observability. */
export function writerBudgetSpanMetadata(
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
