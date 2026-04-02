import { describe, expect, it } from "vitest";
import { shouldClarify } from "../src/nodes/llm-planner.js";
import type { GraphState } from "../src/state/types.js";

describe("llm planner clarify-first parity", () => {
  it("clarifies architecture prompts with generic cloud/model ambiguity", () => {
    const state: GraphState = {
      task_description: "Design a cloud architecture for our AI platform and model routing.",
      difficulty: 0.72,
      iteration_count: 0,
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.8 }],
        frameCoherence: "focused",
      },
      task_frame: {
        main_question: "Design architecture for AI platform",
        goals: ["Deploy in cloud with model routing"],
        tasks: [{ description: "Define cloud and model strategy" }],
        global_constraints: [],
      },
      taxonomy_metadata: {
        taxonomy_key: "software_architecture",
        output_controls: { clarify_first: true },
      },
    };

    const plan = {
      steps: [{ id: 1, action: "Provide architecture design", dependencies: [] }],
      open_questions: [],
      assumptions: [],
      confidence: 0.79,
      reasoning: "initial plan",
    };

    expect(shouldClarify(state, plan)).toBe(true);
  });

  it("does not clarify again after first iteration", () => {
    const state: GraphState = {
      task_description: "Use cloud architecture for AI platform.",
      difficulty: 0.75,
      iteration_count: 1,
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.8 }],
        frameCoherence: "diffuse",
      },
      taxonomy_metadata: { output_controls: { clarify_first: true } },
    };

    const plan = {
      steps: [{ id: 1, action: "Provide architecture design", dependencies: [] }],
      open_questions: ["Which cloud provider?"],
      assumptions: [],
      confidence: 0.4,
      reasoning: "needs clarification",
    };

    expect(shouldClarify(state, plan)).toBe(false);
  });

  it("does not clarify again on a clarification follow-up turn (iteration still 0)", () => {
    const state: GraphState = {
      task_description: "Original request:\n...\nClarification response:\nAWS, 500 concurrent users",
      difficulty: 0.75,
      iteration_count: 0,
      user_answer_to_clarification: "AWS, 500 concurrent users",
      domain_profile: {
        domains: [{ key: "software_architecture", weight: 0.8 }],
        frameCoherence: "diffuse",
      },
      taxonomy_metadata: { output_controls: { clarify_first: true } },
    };

    const plan = {
      steps: [{ id: 1, action: "Provide architecture design", dependencies: [] }],
      open_questions: ["Which cloud provider?"],
      assumptions: [],
      confidence: 0.4,
      reasoning: "needs clarification",
    };

    expect(shouldClarify(state, plan)).toBe(false);
  });
});
