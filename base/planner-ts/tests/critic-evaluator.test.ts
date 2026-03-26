import { describe, expect, it } from "vitest";
import { evaluateCritic } from "../src/nodes/critic-evaluator.js";

describe("evaluateCritic", () => {
  it("flags missing citations when evidence exists", async () => {
    const out = await evaluateCritic({
      generated_code: "# Draft\n\nNo sources here.",
      evidence_packets: [
        {
          query: "q",
          summary: "s",
          confidence: 0.8,
          retrieval_notes: "",
          sources: [{ uri: "https://docs.example.com", type: "doc", metadata: {} }],
          snippets: []
        }
      ]
    });
    expect(out.approved).toBe(false);
    expect(out.blocking_issues.length).toBeGreaterThan(0);
  });

  it("parses critic json when provided", async () => {
    const out = await evaluateCritic({
      critic_raw_json:
        '{"approved":true,"need_more_evidence":false,"blocking_issues":[],"nonblocking":[],"repair_instructions":[],"scores":{"grounding":8,"correctness":8,"actionability":8,"clarity":8,"weighted_overall":8}}'
    });
    expect(out.approved).toBe(true);
    expect(out.scores.weighted_overall).toBe(8);
  });

  it("does not require citations when packets have no usable sources", async () => {
    const out = await evaluateCritic({
      generated_code: "# Draft\n\nSummary without source tags.",
      evidence_packets: [
        {
          query: "q",
          summary: "s",
          confidence: 0.2,
          retrieval_notes: "",
          sources: [],
          snippets: []
        }
      ]
    });
    const blockingIds = out.blocking_issues.map((issue) => issue.item_id);
    expect(blockingIds.includes("missing_citation")).toBe(false);
  });
});
