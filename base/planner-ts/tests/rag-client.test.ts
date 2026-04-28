import { afterEach, describe, expect, it, vi } from "vitest";
import { retrieveContext, type RagClientConfig } from "../src/retrieval/rag-client.js";

const baseConfig: RagClientConfig = {
  milvusHost: "milvus.local",
  milvusPort: 19530,
  embedderUrl: "http://embedder.local/v1",
  embedderModel: "BAAI/bge-m3",
  bgeRerankerUrl: "",
  retrievalStrategy: "bm25",
  rrfK: 60,
  scoreThreshold: 0,
  rerankScoreMin: 0,
  timeoutMs: 1000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retrieveContext", () => {
  it("uses sparse BM25 search without embedding when configured for bm25", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.annsField).toBe("sparse_text");
      expect(body.data).toEqual(["terraform force_new drift"]);
      return new Response(
        JSON.stringify({
          code: 0,
          data: [
            {
              chunk_id: "chunk-1",
              doc_id: "doc-1",
              text: "force_new replacement metadata",
              source_url: "https://example.test/provider",
              document_name: "provider schema",
              authority: "vetted",
              pack_id: "terraform-latest",
              symbol_name: "aws_instance",
              module_path: "provider-schemas/aws.json",
              content_format: "json",
              has_code: false,
              score: 0.9,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await retrieveContext("terraform force_new drift", baseConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v2/vectordb/entities/search");
    expect(results[0]?.pack_id).toBe("terraform-latest");
    expect(results[0]?.symbol_name).toBe("aws_instance");
    expect(results[0]?.module_path).toBe("provider-schemas/aws.json");
    expect(results[0]?.content_format).toBe("json");
  });
});
