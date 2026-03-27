import { describe, expect, it } from "vitest";
import {
  clampBudgetToTierCeiling,
  computeScaledCriticBudget,
  computeScaledWriterBudget,
} from "../src/budgets.js";
import { loadConfig } from "../src/config.js";

describe("budget scaling (parity with Python config defaults)", () => {
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
