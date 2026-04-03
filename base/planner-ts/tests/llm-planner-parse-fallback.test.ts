import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphState } from "../src/state/types.js";

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

describe("runLlmPlanner parse fallback", () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it("still triggers clarification when planner JSON is unparseable", async () => {
    chatCompletionMock.mockResolvedValue({
      content: "{\"title\":\"Enterprise AI Assistant\"}",
      usage: {
        prompt_tokens: 120,
        completion_tokens: 80,
        total_tokens: 200,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const state: GraphState = {
      task_description: "Design a cloud architecture for an AI platform with model routing and workflow agents.",
      difficulty: 0.92,
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
    expect(out.clarification).toBeDefined();
    expect(out.clarification?.question).toContain("clarify");
    expect(out.result.plan.assumptions).toContain("LLM returned unparseable plan — using deterministic plan");
  });

  it("collapses near-duplicate cloud-provider clarification prompts", async () => {
    chatCompletionMock.mockResolvedValue({
      content: JSON.stringify({
        steps: [{ id: 1, action: "Design target architecture", dependencies: [] }],
        open_questions: [
          "What cloud provider(s) is the company standardized on (e.g., AWS, GCP, Azure)?",
          "Are there existing identity providers (e.g., Okta, Azure AD) to integrate with?",
          "Is Kubernetes already in use, or will this be a new cluster deployment?",
        ],
        assumptions: ["Users authenticate via OIDC IdP"],
        confidence: 0.63,
        reasoning: "Need a few scope constraints first",
      }),
      usage: {
        prompt_tokens: 180,
        completion_tokens: 120,
        total_tokens: 300,
        cached_prompt_tokens: 0,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
    });

    const state: GraphState = {
      task_description: "Design a cloud architecture for an AI platform and choose deployment patterns.",
      difficulty: 0.85,
      iteration_count: 0,
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.9 }],
        frameCoherence: "focused",
      },
      task_frame: {
        main_question: "Design AI platform architecture",
        goals: ["Production architecture in cloud"],
        tasks: [{ description: "define cloud and platform strategy" }],
        global_constraints: [],
      },
      taxonomy_metadata: {
        output_controls: { clarify_first: true },
      },
    };

    const out = await runLlmPlanner(state);
    expect(out.clarification).toBeDefined();
    const question = out.clarification?.question ?? "";
    expect(question).toContain("What cloud provider(s) is the company standardized on");
    expect(question).not.toContain("should I keep it cloud-agnostic");
  });
});
