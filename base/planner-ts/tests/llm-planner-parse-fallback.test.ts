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
    chatCompletionMock
      .mockResolvedValueOnce({
        content: "{\"title\":\"Enterprise AI Assistant\"}",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 80,
          total_tokens: 200,
          cached_prompt_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
        },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ambiguity_level: 0.82,
          can_proceed_without_clarification: false,
          material_gaps: [{
            missing_information: "cloud provider",
            impact_on_outcome: "changes concrete architecture recommendations",
            suggested_question: "Which cloud provider should this target?",
          }],
          clarification_questions: ["Which cloud provider should this target?"],
          rationale: "Material deployment ambiguity detected.",
        }),
        usage: {
          prompt_tokens: 90,
          completion_tokens: 50,
          total_tokens: 140,
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
    chatCompletionMock
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ambiguity_level: 0.9,
          can_proceed_without_clarification: false,
          material_gaps: [{
            missing_information: "cloud provider",
            impact_on_outcome: "drives provider-specific recommendations",
            suggested_question: "You mention cloud but not a specific provider. Do you prefer AWS, Azure, GCP, on-prem, or cloud-agnostic?",
          }],
          clarification_questions: [
            "You mention cloud but not a specific provider. Do you prefer AWS, Azure, GCP, on-prem, or cloud-agnostic?",
          ],
          rationale: "Provider ambiguity is material.",
        }),
        usage: {
          prompt_tokens: 95,
          completion_tokens: 60,
          total_tokens: 155,
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
    const numbered = question.split("\n").filter((line) => /^\d+\.\s/.test(line));
    const providerLike = numbered.filter((line) => /cloud provider|cloud-agnostic|on-prem|keep it cloud/i.test(line));
    expect(providerLike.length).toBe(1);
  });

  it("falls back to planner-only epistemic checks when ambiguity scorer fails", async () => {
    chatCompletionMock
      .mockResolvedValueOnce({
        content: JSON.stringify({
          steps: [{ id: 1, action: "Draft architecture recommendation", dependencies: [] }],
          open_questions: ["Which deployment environment should this target?"],
          assumptions: [],
          confidence: 0.42,
          reasoning: "Need deployment context.",
        }),
        usage: {
          prompt_tokens: 130,
          completion_tokens: 90,
          total_tokens: 220,
          cached_prompt_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
        },
      })
      .mockRejectedValueOnce(new Error("scorer timeout"));

    const out = await runLlmPlanner({
      task_description: "Design an enterprise deployment architecture.",
      difficulty: 0.7,
      iteration_count: 0,
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.8 }],
        frameCoherence: "focused",
      },
      taxonomy_metadata: {
        output_controls: { clarify_first: true },
      },
    });
    expect(out.clarification).toBeDefined();
    expect(out.result.ambiguity_scorer_error).toContain("scorer timeout");
  });
});
