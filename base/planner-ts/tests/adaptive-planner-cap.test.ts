import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeAdaptivePlannerCap } from "../src/nodes/llm-planner.js";
import type { GraphState } from "../src/state/types.js";

describe("computeAdaptivePlannerCap", () => {
  const BASE = 2000;

  it("returns base cap for low-difficulty clear tasks", () => {
    const state: GraphState = { difficulty: 0.3, cynefin_domain: "clear" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(2000);
  });

  it("returns base cap when difficulty and cynefin are unset", () => {
    const state: GraphState = {};
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(2000);
  });

  it("adds 800 for high difficulty (>=0.7) on clear domain", () => {
    const state: GraphState = { difficulty: 0.7, cynefin_domain: "clear" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(2800);
  });

  it("adds 800 for complex domain with moderate difficulty", () => {
    const state: GraphState = { difficulty: 0.5, cynefin_domain: "complex" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(2800);
  });

  it("adds 1600 for high difficulty + complex domain", () => {
    const state: GraphState = { difficulty: 0.75, cynefin_domain: "complex" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(3600);
  });

  it("adds 1600 for high difficulty + chaotic domain", () => {
    const state: GraphState = { difficulty: 0.7, cynefin_domain: "chaotic" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(3600);
  });

  it("adds extra 400 for very high difficulty (>=0.85)", () => {
    const state: GraphState = { difficulty: 0.92, cynefin_domain: "complex" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(4000);
  });

  it("clamps to 4096 ceiling", () => {
    const state: GraphState = { difficulty: 0.95, cynefin_domain: "chaotic" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(4000);
    // Even with a higher base, cap should not exceed 4096
    expect(computeAdaptivePlannerCap(3000, state)).toBe(4096);
  });

  it("respects complicated domain (no extra budget)", () => {
    const state: GraphState = { difficulty: 0.8, cynefin_domain: "complicated" };
    expect(computeAdaptivePlannerCap(BASE, state)).toBe(2800);
  });
});

const chatCompletionMock = vi.fn();

vi.mock("../src/llm/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/client.js")>("../src/llm/client.js");
  return {
    ...actual,
    isLlmAvailable: () => true,
    chatCompletion: (...args: unknown[]) => chatCompletionMock(...args),
  };
});

import { runLlmPlanner } from "../src/nodes/llm-planner.js";

describe("runLlmPlanner adaptive budget", () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it("passes adaptive max_tokens to the LLM request", async () => {
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({
        steps: [{ id: 1, action: "Design architecture", dependencies: [] }],
        open_questions: [],
        assumptions: ["Kubernetes assumed"],
        confidence: 0.85,
        reasoning: "Detailed plan",
      }),
      usage: {
        prompt_tokens: 500,
        completion_tokens: 1800,
        total_tokens: 2300,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const state: GraphState = {
      task_description: "Design a complex distributed system architecture",
      difficulty: 0.92,
      cynefin_domain: "complex",
      iteration_count: 0,
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.9 }],
        frameCoherence: "focused",
      },
      task_frame: {
        main_question: "Design distributed system",
        goals: [],
        tasks: [],
        global_constraints: [],
      },
      taxonomy_metadata: {},
    };

    const out = await runLlmPlanner(state);

    // Verify the effective cap was raised: 2000 + 800 (d>=0.7) + 800 (complex) + 400 (d>=0.85) = 4000
    expect(out.result.effectiveMaxTokens).toBe(4000);

    // Verify the LLM was actually called with the adaptive cap
    expect(chatCompletionMock).toHaveBeenCalled();
    const firstCallArgs = chatCompletionMock.mock.calls[0][0];
    expect(firstCallArgs.max_tokens).toBe(4000);
  });

  it("uses base cap for trivial tasks", async () => {
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({
        steps: [{ id: 1, action: "Answer question", dependencies: [] }],
        open_questions: [],
        assumptions: [],
        confidence: 0.9,
        reasoning: "Simple question",
      }),
      usage: {
        prompt_tokens: 80,
        completion_tokens: 200,
        total_tokens: 280,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const state: GraphState = {
      task_description: "What is Python?",
      difficulty: 0.15,
      cynefin_domain: "clear",
      iteration_count: 0,
      taxonomy_metadata: {},
    };

    const out = await runLlmPlanner(state);
    expect(out.result.effectiveMaxTokens).toBe(2000);

    const firstCallArgs = chatCompletionMock.mock.calls[0][0];
    expect(firstCallArgs.max_tokens).toBe(2000);
  });

  it("returns effectiveMaxTokens on parse fallback with clarification", async () => {
    chatCompletionMock.mockResolvedValue({
      content: '{"title": "Not a plan"}',
      usage: {
        prompt_tokens: 300,
        completion_tokens: 500,
        total_tokens: 800,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const state: GraphState = {
      task_description: "Design a cloud architecture for an AI platform with model routing.",
      difficulty: 0.92,
      cynefin_domain: "chaotic",
      iteration_count: 0,
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.9 }],
        frameCoherence: "focused",
      },
      task_frame: {
        main_question: "Design AI platform architecture",
        goals: ["Production architecture in cloud"],
        tasks: [{ description: "define cloud and model strategy" }],
        global_constraints: [],
      },
      taxonomy_metadata: {
        output_controls: { clarify_first: true },
      },
    };

    const out = await runLlmPlanner(state);

    // Should still trigger clarification on parse fallback
    expect(out.clarification).toBeDefined();
    // Effective cap should be adaptive: 2000 + 800 + 800 + 400 = 4000
    expect(out.result.effectiveMaxTokens).toBe(4000);
  });
});
