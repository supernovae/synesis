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

  it("does not retry structured output when the planner provider returns an auth error", async () => {
    chatCompletionMock.mockRejectedValueOnce(
      new Error('LLM HTTP 400: {"code":"invalid-argument","error":"Incorrect API key provided: xa***ME."}'),
    );

    const out = await runLlmPlanner({
      task_description: "Summarize the deployment approach.",
      difficulty: 0.3,
      iteration_count: 0,
      domain_profile: {
        domains: [{ key: "cloud_infra", weight: 0.8 }],
        frameCoherence: "focused",
      },
      taxonomy_metadata: {
        output_controls: { clarify_first: false },
      },
    });

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    expect(out.clarification).toBeUndefined();
    expect(out.result.plan.assumptions).toContain("LLM planner call failed — using deterministic plan");
    expect(out.result.plan.reasoning).toBe("LLM planner unavailable: LLM provider authentication failed");
    expect(out.result.plan.reasoning).not.toContain("xa***ME");
    expect(out.result.ambiguity_decision_reason).toBe("proceed:planner-call-fallback");
  });

  it("asks clarifying questions from explicit unknowns when the planner call fails", async () => {
    chatCompletionMock.mockRejectedValueOnce(
      new Error('LLM HTTP 400: {"code":"invalid-argument","error":"Incorrect API key provided: xa***ME."}'),
    );

    const out = await runLlmPlanner({
      task_description: [
        "I need help building a Go-based production job orchestration service for Kubernetes/OpenShift.",
        "It should be lightweight but production-grade, horizontally scalable, multi-tenant, secure, durable, restart-safe, auditable, and capable of long workflows.",
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
        "Please proceed with the architecture and implementation plan.",
      ].join("\n"),
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
        output_controls: { clarify_first: false },
      },
    });

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    expect(out.clarification).toBeDefined();
    expect(out.clarification?.question).toContain("What should I assume about expected scale");
    expect(out.clarification?.question).toContain("compact brief");
    expect(out.result.ambiguity_decision_reason).toBe("clarify:explicit-user-uncertainty");
  });

  it("uses scorer-led clarification and a scoping brief for broad explicit unknowns", async () => {
    chatCompletionMock
      .mockResolvedValueOnce({
        content: JSON.stringify({
          steps: [{ id: 1, action: "Design Go job orchestration service", dependencies: [] }],
          open_questions: [],
          assumptions: [
            "Use embedded persistence",
            "Use Kubernetes Lease for single-writer coordination",
            "Use step-level retries",
          ],
          confidence: 0.72,
          reasoning: "Proceed with assumptions.",
        }),
        usage: {
          prompt_tokens: 220,
          completion_tokens: 130,
          total_tokens: 350,
          cached_prompt_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
        },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ambiguity_level: 0.82,
          can_proceed_without_clarification: false,
          material_gaps: [
            {
              missing_information: "durability and coordination model",
              impact_on_outcome: "drives whether embedded state is acceptable or an external database/queue/operator is required",
              suggested_question: "Which durability and coordination tradeoff should take priority if zero extra infrastructure conflicts with restart safety and multi-replica execution?",
            },
          ],
          clarification_questions: [
            "Which durability and coordination tradeoff should take priority if zero extra infrastructure conflicts with restart safety and multi-replica execution?",
            "What scale or SLO target should the initial design optimize for?",
            "Should workflows be fixed service-defined flows or user-defined workflows?",
            "What tenant isolation boundary is required for state, artifacts, and audit logs?",
          ],
          rationale: "The user listed several uncertainties that materially affect the architecture.",
        }),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          cached_prompt_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
        },
      });

    const out = await runLlmPlanner({
      task_description: [
        "I need help building a Go-based production job orchestration service for Kubernetes/OpenShift.",
        "It should be simple and lightweight, but also production-grade, horizontally scalable, multi-tenant, secure, durable, restart-safe, auditable, and capable of running long workflows that last hours.",
        "I want to avoid adding too much infrastructure, so ideally no database, no queue, and no operator. But jobs must survive pod restarts, support retries without duplicate execution, persist artifacts and audit logs, replay UI events after reconnect, and allow multiple worker replicas without race conditions.",
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
        "Please proceed with the architecture and implementation plan.",
      ].join("\n"),
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
        output_controls: { clarify_first: false },
      },
    });

    expect(out.clarification).toBeDefined();
    expect(out.clarification?.question).toContain("durability and coordination tradeoff");
    expect(out.clarification?.question).toContain("compact brief");
    expect(out.clarification?.question).toContain("Allowed infrastructure:");
    const numberedQuestions = (out.clarification?.question ?? "")
      .split("\n")
      .filter((line) => /^\d+\.\s/.test(line));
    expect(numberedQuestions.length).toBeGreaterThan(3);
    expect(numberedQuestions.length).toBeLessThanOrEqual(5);
    expect(out.result.ambiguity_decision_reason).toBe("clarify:explicit-user-uncertainty");
    expect(out.result.ambiguity_assessment?.can_proceed_without_clarification).toBe(false);
    expect(out.result.ambiguity_assessment?.material_gaps.length).toBeGreaterThanOrEqual(8);
    const scorerRequest = chatCompletionMock.mock.calls[1]?.[0];
    const scorerPayload = JSON.parse(String(scorerRequest.messages[1].content));
    expect(scorerPayload.explicit_user_uncertainties).toContain("persistence backend");
  });

  it("asks before proceeding when a complex architecture plan depends on several assumptions", async () => {
    chatCompletionMock
      .mockResolvedValueOnce({
        content: JSON.stringify({
          steps: [{ id: 1, action: "Design internal coding assistant architecture", dependencies: [] }],
          open_questions: [],
          assumptions: [
            "The organization uses GitHub as its primary version-control system.",
            "The documentation corpus is mostly Markdown or HTML rather than PDFs and images.",
            "The assistant will be accessed through a web UI first, with chat integrations later.",
          ],
          confidence: 0.74,
          reasoning: "Proceed with a pragmatic architecture using stated and inferred constraints.",
        }),
        usage: {
          prompt_tokens: 240,
          completion_tokens: 130,
          total_tokens: 370,
          cached_prompt_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
        },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ambiguity_level: 0.22,
          can_proceed_without_clarification: true,
          material_gaps: [],
          clarification_questions: [],
          rationale: "The prompt is sufficiently bounded to proceed with assumptions.",
        }),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          cached_prompt_tokens: 0,
          estimated_cost_usd: 0,
          actual_cost_usd: 0,
        },
      });

    const out = await runLlmPlanner({
      task_description: [
        "You are helping me design a production-ready AI assistant for a small engineering organization.",
        "Propose a practical architecture for an internal coding assistant that can answer company docs, help write and review code, avoid making up facts, escalate when evidence is weak, and keep latency and cost reasonable.",
        "Constraints: Team size is 80 engineers, mix of public and private knowledge, Kubernetes, Terraform, Python, limited budget, security matters, useful within 90 days.",
        "Do not give a generic answer. Make tradeoffs explicit. Separate facts, assumptions, and recommendations.",
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
    });

    expect(out.clarification).toBeDefined();
    expect(out.result.ambiguity_decision_reason).toBe("clarify:material-assumption-load");
    expect(out.clarification?.question).toContain("Is this assumption correct");
    expect(out.clarification?.question).toContain("GitHub");
    const numberedQuestions = (out.clarification?.question ?? "")
      .split("\n")
      .filter((line) => /^\d+\.\s/.test(line));
    expect(numberedQuestions.length).toBeGreaterThanOrEqual(3);
    expect(numberedQuestions.length).toBeLessThanOrEqual(5);
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

  it("falls back to planner-only ambiguity checks when ambiguity scorer fails", async () => {
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
    expect(out.result.ambiguity_scorer_error).toBe("LLM provider request timed out");
  });
});
