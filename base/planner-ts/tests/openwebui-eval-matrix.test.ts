import { describe, expect, it } from "vitest";
import { resolvePlannerArchitectureMediation } from "../src/context/architecture-mediation.js";
import type { ChatMessage } from "../src/context/session-store.js";

const MODELS = [
  { id: "deepseek-v4", expectedAttention: "mla" },
  { id: "qwen3-coder-plus", expectedAttention: "global_local_hybrid" },
  { id: "kimi-k2.7-code", expectedAttention: "hybrid_compressed_attention" },
  { id: "minimax-abab-7", expectedAttention: "heavily_compressed_attention" },
] as const;

const SCENARIOS: Array<{
  name: string;
  expectedProfile: string;
  evidenceBlock?: string;
  messages: ChatMessage[];
}> = [
  {
    name: "long chat follow-up",
    expectedProfile: "general_assistant",
    messages: [
      { role: "user" as const, content: "I am comparing deployment options for 50 users. Always prefer on-prem options." },
      { role: "assistant" as const, content: "On-prem is the current preference." },
      { role: "user" as const, content: "Expand on that." },
    ],
  },
  {
    name: "roleplay continuity",
    expectedProfile: "roleplay_creative_continuity",
    messages: [
      { role: "user" as const, content: "Roleplay as Mara. Canon: the lighthouse door is sealed. Always stay in scene." },
      { role: "assistant" as const, content: "Mara touches the sealed door." },
      { role: "user" as const, content: "Continue." },
    ],
  },
  {
    name: "tutoring drill",
    expectedProfile: "tutoring_study",
    messages: [
      { role: "user" as const, content: "Quiz me on Spanish verbs and correct me after each answer." },
      { role: "assistant" as const, content: "Translate: I speak." },
      { role: "user" as const, content: "Yo hablo." },
    ],
  },
  {
    name: "rag grounded answer",
    expectedProfile: "rag_grounded_answer",
    evidenceBlock: "Source: doc://policy-1\nThe refund window is 30 days.",
    messages: [
      { role: "user" as const, content: "What is the refund window? Cite the policy." },
    ],
  },
];

describe("OpenWebUI deterministic architecture eval matrix", () => {
  for (const model of MODELS) {
    for (const scenario of SCENARIOS) {
      it(`${model.id} handles ${scenario.name} with active-state mediation`, () => {
        const mediation = resolvePlannerArchitectureMediation({
          requestedModel: "Synesis",
          writerModel: model.id,
          metadata: { synesis: { contextMediation: "adaptive", architectureProfile: "auto" } },
          messages: scenario.messages,
          taskDescription: scenario.messages.at(-1)?.content ?? "",
          evidenceBlock: scenario.evidenceBlock,
        });

        expect(mediation.profile.attention).toBe(model.expectedAttention);
        expect(mediation.chatProfile).toBe(scenario.expectedProfile);
        expect(mediation.policy.multipass.maxRepairPasses).toBe(1);
        expect(mediation.activeStateHeader).toContain("SYNESIS_PLANNER_ACTIVE_STATE");
        expect(mediation.trace.fact_pin_count).toBeGreaterThanOrEqual(0);
        if (scenario.evidenceBlock) {
          expect(mediation.artifacts.evidenceManifest.length).toBeGreaterThan(0);
        }
      });
    }
  }
});
