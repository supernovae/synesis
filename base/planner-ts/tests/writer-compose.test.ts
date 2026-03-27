import { describe, expect, it } from "vitest";
import { composeWriterDraft } from "../src/nodes/writer-compose.js";

describe("composeWriterDraft", () => {
  it("deterministic fallback does not leak internal plan/evidence headers", async () => {
    const result = await composeWriterDraft({
      task_description: "Migrate planner to TypeScript",
      execution_plan: { steps: [{ action: "Port reducers and validators" }] },
      evidence_packets: [
        {
          query: "planner migration",
          summary: "Migration should preserve behavior",
          confidence: 0.8,
          retrieval_notes: "",
          sources: [{ uri: "https://docs.example.com", type: "doc", metadata: { document_name: "doc" } }],
          snippets: []
        }
      ]
    });
    expect(result.content).not.toContain("## Plan");
    expect(result.content).not.toContain("## Evidence");
    expect(result.content).toContain("Migrate planner to TypeScript");
    expect(result.usage).toBeTruthy();
    expect(result.usage.cached_prompt_tokens).toBe(0);
  });

  it("produces a user-friendly fallback message", async () => {
    const result = await composeWriterDraft({
      task_description: "Answer quickly",
      style_contract_locked: { precise: true },
      execution_plan: { steps: [] },
      evidence_packets: []
    });
    expect(result.content).toContain("Answer quickly");
    expect(result.content).toContain("unable to generate");
    expect(result.content).not.toContain("## Plan");
    expect(result.content).not.toContain("## Evidence");
    expect(result.usage.prompt_tokens).toBe(0);
  });
});
