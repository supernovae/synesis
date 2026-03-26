import { describe, expect, it } from "vitest";
import { runRouter, LOW_CONFIDENCE_THRESHOLD, MAX_DOCS_PER_QUERY, MAX_SNIPPETS_PER_PACKET } from "../src/nodes/router.js";
import type { RetrievalClient } from "../src/retrieval/client.js";
import type { UnifiedResult } from "../src/retrieval/types.js";

class FakeRetrievalClient implements RetrievalClient {
  constructor(private readonly results: UnifiedResult[]) {}
  async retrieve(): Promise<UnifiedResult[]> {
    return this.results;
  }
}

describe("router node", () => {
  it("exports retrieval discipline constants", () => {
    expect(MAX_DOCS_PER_QUERY).toBe(5);
    expect(MAX_SNIPPETS_PER_PACKET).toBe(20);
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.4);
  });

  it("builds fallback packet when summarizer output is invalid", async () => {
    const state = await runRouter(
      {
        task_description: "Design migration plan"
      },
      {
        retrievalClient: new FakeRetrievalClient([
          {
            retrieval_source: "web",
            source_url: "https://example.com/doc",
            title: "Doc",
            text: "Evidence text from source",
            score: 0.9
          }
        ]),
        summarizerOutput: "not json"
      }
    );
    expect(state.evidence_packets?.length).toBe(1);
    expect(state.evidence_packets?.[0]?.sources[0]?.uri).toBe("https://example.com/doc");
    expect(state.next_node).toBe("writer");
  });

  it("respects summarizer structured output", async () => {
    const state = await runRouter(
      {
        task_description: "Design migration plan"
      },
      {
        retrievalClient: new FakeRetrievalClient([]),
        summarizerOutput: JSON.stringify({
          query: "migration query",
          sources: [{ uri: "https://docs", type: "doc", metadata: {} }],
          snippets: [{ text: "snippet", relevance: 0.75, source_uri: "https://docs" }],
          summary: "summary",
          confidence: 0.8,
          retrieval_notes: "ok"
        })
      }
    );
    expect(state.evidence_packets?.[0]?.query).toBe("migration query");
    expect(state.need_more_evidence).toBe(false);
  });
});
