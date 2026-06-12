import { describe, expect, it } from "vitest";
import {
  clampBudgetToTierCeiling,
  computeScaledCriticBudget,
  computeScaledWriterBudget,
  computeWriterEffectiveMaxTokens,
  budgetSpanMetadata,
  budgetUtilization,
} from "../src/budgets.js";
import { loadConfig } from "../src/config.js";

describe("budget scaling", () => {
  it("uses trivial writer cap when task is trivial", () => {
    const cfg = loadConfig(process.env);
    expect(computeScaledWriterBudget(cfg, 0.99, true)).toBe(cfg.SYNESIS_PLANNER_TS_TRIVIAL_WRITER_BUDGET);
  });

  it("scales writer linearly: d=0 -> base, d=1 -> max", () => {
    const cfg = loadConfig(process.env);
    expect(computeScaledWriterBudget(cfg, 0, false)).toBe(cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_BASE);
    expect(computeScaledWriterBudget(cfg, 1, false)).toBe(cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MAX);
  });

  it("clamps critic to CRITIC_MAX_TOKENS", () => {
    const cfg = loadConfig(process.env);
    const atFullDifficulty = computeScaledCriticBudget(cfg, 1);
    expect(atFullDifficulty).toBeLessThanOrEqual(cfg.SYNESIS_PLANNER_TS_CRITIC_MAX_TOKENS);
    expect(atFullDifficulty).toBe(
      Math.min(cfg.SYNESIS_PLANNER_TS_CRITIC_BUDGET_MAX, cfg.SYNESIS_PLANNER_TS_CRITIC_MAX_TOKENS),
    );
  });

  it("clamps scaled budget to tier ceiling", () => {
    expect(clampBudgetToTierCeiling(50000, 8192)).toBe(8192);
    expect(clampBudgetToTierCeiling(1000, 8192)).toBe(1000);
  });
});

describe("computeWriterEffectiveMaxTokens", () => {
  it("enforced mode uses target capped by safety and tier", () => {
    const cfg = loadConfig({
      ...process.env,
      SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE: "enforced",
      SYNESIS_PLANNER_TS_WRITER_BUDGET_AUDIT_FLOOR: "4096",
      SYNESIS_PLANNER_TS_WRITER_OUTPUT_SAFETY_CEILING: "32768",
    });
    expect(computeWriterEffectiveMaxTokens(cfg, 2048, 16384)).toBe(2048);
    expect(computeWriterEffectiveMaxTokens(cfg, 50000, 8192)).toBe(8192);
  });

  it("audit mode applies floor below tier and safety", () => {
    const cfg = loadConfig({
      ...process.env,
      SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE: "audit",
      SYNESIS_PLANNER_TS_WRITER_BUDGET_AUDIT_FLOOR: "4096",
      SYNESIS_PLANNER_TS_WRITER_OUTPUT_SAFETY_CEILING: "32768",
    });
    expect(computeWriterEffectiveMaxTokens(cfg, 2048, 32768)).toBe(4096);
    expect(computeWriterEffectiveMaxTokens(cfg, 2048, 8192)).toBe(4096);
    expect(computeWriterEffectiveMaxTokens(cfg, 8000, 8192)).toBe(8000);
  });
});

describe("budgetSpanMetadata", () => {
  it("returns token breakdown and utilization", () => {
    const meta = budgetSpanMetadata(4096, {
      prompt_tokens: 200,
      completion_tokens: 1000,
      total_tokens: 1200,
      cached_prompt_tokens: 0,
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
    });
    expect(meta).toEqual({
      max_output_tokens: 4096,
      prompt_tokens: 200,
      completion_tokens: 1000,
      total_tokens: 1200,
      budget_utilization: 0.2441,
    });
  });

  it("handles zero budget without utilization", () => {
    const meta = budgetSpanMetadata(0, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_prompt_tokens: 0, estimated_cost_usd: 0, actual_cost_usd: 0 });
    expect(meta.budget_utilization).toBeUndefined();
    expect(meta.max_output_tokens).toBe(0);
  });

  it("handles undefined usage", () => {
    const meta = budgetSpanMetadata(1024, undefined);
    expect(meta.prompt_tokens).toBe(0);
    expect(meta.completion_tokens).toBe(0);
    expect(meta.total_tokens).toBe(0);
    expect(meta.budget_utilization).toBe(0);
  });

});

describe("budgetUtilization", () => {
  it("returns ratio of completion to budget", () => {
    expect(budgetUtilization(500, 1000)).toBe(0.5);
    expect(budgetUtilization(1000, 1000)).toBe(1);
  });

  it("returns undefined for zero budget", () => {
    expect(budgetUtilization(100, 0)).toBeUndefined();
  });
});
