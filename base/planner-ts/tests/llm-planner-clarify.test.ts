import { describe, expect, it } from "vitest";
import { detectExplicitUncertaintyGaps, shouldClarify } from "../src/nodes/llm-planner.js";
import type { GraphState } from "../src/state/types.js";

describe("llm planner clarify-first parity", () => {
  const explicitUnknownPrompt = [
    "I need help building a Go-based production job orchestration service for Kubernetes/OpenShift.",
    "",
    "It should be simple and lightweight, but also production-grade, horizontally scalable, multi-tenant, secure, durable, restart-safe, auditable, and capable of running long workflows that last hours.",
    "",
    "I want to avoid adding too much infrastructure, so ideally no database, no queue, and no operator. But jobs must survive pod restarts, support retries without duplicate execution, persist artifacts and audit logs, replay UI events after reconnect, and allow multiple worker replicas without race conditions.",
    "",
    "I am not sure about:",
    "- expected scale",
    "- persistence backend",
    "- whether workflows are fixed or user-defined",
    "- whether execution runs in API pods or workers",
    "- whether the system needs strict tenant isolation",
    "- whether job events need exact ordering and replay",
    "- whether artifacts are small text blobs or large files",
    "- whether cancellation must immediately stop external tools",
    "- whether retries happen at job, phase, or step level",
    "",
    "Please proceed with the architecture and implementation plan.",
  ].join("\n");

  it("extracts explicit user-declared unknowns as material gaps", () => {
    const gaps = detectExplicitUncertaintyGaps(explicitUnknownPrompt);

    expect(gaps.length).toBeGreaterThanOrEqual(8);
    expect(gaps[0].missing_information).toBe("expected scale");
    expect(gaps.some((gap) => gap.missing_information === "persistence backend")).toBe(true);
    expect(gaps.every((gap) => gap.suggested_question.includes("What should I assume about"))).toBe(true);
  });

  it("clarifies when the user declares many material unknowns even if scorer says proceed", () => {
    const state: GraphState = {
      task_description: explicitUnknownPrompt,
      difficulty: 0.78,
      iteration_count: 0,
      domain_profile: {
        domains: [
          { key: "architecture", weight: 0.45 },
          { key: "cloud_infra", weight: 0.35 },
          { key: "backend_api", weight: 0.2 },
        ],
        frameCoherence: "composite",
      },
      taxonomy_metadata: {
        taxonomy_key: "code.architecture",
        output_controls: { clarify_first: false },
      },
    };
    const plan = {
      steps: [{ id: 1, action: "Draft architecture and implementation plan", dependencies: [] }],
      open_questions: [],
      assumptions: [
        "Use bbolt for persistence",
        "Use Kubernetes Lease for leader election",
      ],
      confidence: 0.72,
      reasoning: "Proceed with assumptions",
    };
    const ambiguity = {
      ambiguity_level: 0.2,
      can_proceed_without_clarification: true,
      material_gaps: [],
      clarification_questions: [],
      rationale: "Can proceed with assumptions.",
    };

    expect(shouldClarify(state, plan, ambiguity)).toBe(true);
  });

  it("clarifies for complex architecture plans that rely on several material assumptions", () => {
    const state: GraphState = {
      task_description: [
        "Propose a practical architecture for an internal coding assistant that can answer docs, write and review code, avoid hallucinations, escalate when evidence is weak, and keep latency and cost reasonable.",
        "Constraints: 80 engineers, mixed public/private knowledge, Kubernetes, Terraform, Python, limited budget, useful within 90 days.",
      ].join("\n"),
      difficulty: 0.76,
      cynefin_domain: "complex",
      iteration_count: 0,
      domain_profile: {
        domains: [
          { key: "software_architecture", weight: 0.45 },
          { key: "ml_ai", weight: 0.35 },
          { key: "cloud_infra", weight: 0.2 },
        ],
        frameCoherence: "composite",
      },
      taxonomy_metadata: {
        taxonomy_key: "software_architecture",
        output_controls: { clarify_first: false },
      },
    };
    const plan = {
      steps: [{ id: 1, action: "Draft internal coding assistant architecture", dependencies: [] }],
      open_questions: [],
      assumptions: [
        "The organization uses GitHub as its primary version-control system.",
        "The documentation corpus is mostly Markdown or HTML rather than PDFs and images.",
        "The assistant will be accessed through a web UI first, with chat integrations later.",
      ],
      confidence: 0.74,
      reasoning: "Can proceed with reasonable assumptions.",
    };

    expect(shouldClarify(state, plan, {
      ambiguity_level: 0.2,
      can_proceed_without_clarification: true,
      material_gaps: [],
      clarification_questions: [],
      rationale: "Can proceed with assumptions.",
    })).toBe(true);
  });

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
