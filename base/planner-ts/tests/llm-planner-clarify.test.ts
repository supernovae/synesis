import { describe, expect, it } from "vitest";
import { shouldClarify } from "../src/nodes/llm-planner.js";
import type { GraphState } from "../src/state/types.js";

describe("llm planner clarify-first parity", () => {
  it("clarifies when ambiguity scorer reports material gaps", () => {
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
    const ambiguity = {
      ambiguity_level: 0.8,
      can_proceed_without_clarification: false,
      material_gaps: [{
        missing_information: "target deployment environment",
        impact_on_outcome: "changes implementation guidance and risk profile",
        suggested_question: "Which environment should this target?",
      }],
      clarification_questions: ["Which environment should this target?"],
      rationale: "Environment drives architecture choices.",
    };

    expect(shouldClarify(state, plan, ambiguity)).toBe(true);
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

    expect(shouldClarify(state, plan, {
      ambiguity_level: 0.9,
      can_proceed_without_clarification: false,
      material_gaps: [{
        missing_information: "cloud provider",
        impact_on_outcome: "affects concrete implementation",
        suggested_question: "Which cloud provider?",
      }],
      clarification_questions: ["Which cloud provider?"],
      rationale: "Material ambiguity remains.",
    })).toBe(false);
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

    expect(shouldClarify(state, plan, {
      ambiguity_level: 0.85,
      can_proceed_without_clarification: false,
      material_gaps: [{
        missing_information: "exact scale target",
        impact_on_outcome: "changes architecture profile",
        suggested_question: "What scale target should I optimize for?",
      }],
      clarification_questions: ["What scale target should I optimize for?"],
      rationale: "Material ambiguity remains but user already answered a clarification turn.",
    })).toBe(false);
  });
});
