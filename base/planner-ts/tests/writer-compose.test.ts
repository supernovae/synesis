import { describe, expect, it } from "vitest";
import { composeWriterDraft } from "../src/nodes/writer-compose.js";

describe("composeWriterDraft", () => {
  it("renders plan and evidence sections", async () => {
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
    expect(draft).toContain("## Plan");
    expect(draft).toContain("## Evidence");
    expect(draft).toContain("[Source: doc - https://docs.example.com]");
  });

  it("supports precise style mode", async () => {
    const draft = await composeWriterDraft({
      task_description: "Answer quickly",
      style_contract_locked: { precise: true },
      execution_plan: { steps: [] },
      evidence_packets: []
    });
    expect(draft.startsWith("# Response")).toBe(true);
    expect(draft).toContain("Direct answer:");
  });
});
