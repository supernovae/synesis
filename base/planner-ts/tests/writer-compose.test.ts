import { describe, expect, it } from "vitest";
import { composeWriterDraft } from "../src/nodes/writer-compose.js";

describe("composeWriterDraft", () => {
  it("deterministic fallback does not leak internal plan/evidence headers", async () => {
    const draft = await composeWriterDraft({
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
    expect(draft).not.toContain("## Plan");
    expect(draft).not.toContain("## Evidence");
    expect(draft).toContain("Migrate planner to TypeScript");
  });

  it("produces a user-friendly fallback message", async () => {
    const draft = await composeWriterDraft({
      task_description: "Answer quickly",
      style_contract_locked: { precise: true },
      execution_plan: { steps: [] },
      evidence_packets: []
    });
    expect(draft).toContain("Answer quickly");
    expect(draft).toContain("unable to generate");
    expect(draft).not.toContain("## Plan");
    expect(draft).not.toContain("## Evidence");
  });
});
