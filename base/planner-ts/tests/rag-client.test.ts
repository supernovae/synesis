import { afterEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const closeMock = vi.fn();
const sessionMock = vi.fn(() => ({ run: runMock, close: closeMock }));
const driverMock = vi.fn(() => ({ session: sessionMock, close: vi.fn() }));

vi.mock("neo4j-driver", () => ({
  default: {
    driver: driverMock,
    auth: { basic: vi.fn((user: string, password: string) => ({ user, password })) },
    isInt: vi.fn(() => false),
  },
}));

const { retrieveContext } = await import("../src/retrieval/rag-client.js");
import type { RagClientConfig } from "../src/retrieval/rag-client.js";

const baseConfig: RagClientConfig = {
  nornicUri: "bolt://nornic.local:7687",
  nornicUser: "neo4j",
  nornicPassword: "secret",
  nornicDatabase: "neo4j",
  nornicVectorIndex: "embeddings",
  nornicRuntimeProfile: "cpu-bge",
  embedderModel: "BAAI/bge-m3",
  retrievalStrategy: "hybrid",
  rrfK: 60,
  scoreThreshold: 0,
  rerankScoreMin: 0,
  graphDepth: 2,
  edgeTypes: ["DEFINES", "CALLS", "IMPORTS"],
  rerankEnabled: true,
  timeoutMs: 1000,
};

afterEach(() => {
  runMock.mockReset();
  closeMock.mockReset();
  sessionMock.mockClear();
});

describe("retrieveContext", () => {
  it("queries NornicDB vector index with graph and metadata filters", async () => {
    runMock.mockResolvedValue({
      records: [
        {
          get(key: string) {
            if (key === "node") {
              return {
                properties: {
                  id: "chunk-1",
                  doc_id: "doc-1",
                  text: "force_new replacement metadata",
                  source_url: "https://example.test/provider",
                  document_name: "provider schema",
                  authority: "vetted",
                  pack: "terraform-latest",
                  symbol_name: "aws_instance",
                  module_path: "provider-schemas/aws.json",
                  content_format: "json",
                  has_code: false,
                },
              };
            }
            if (key === "score") return 0.9;
            if (key === "neighbors") return [{ properties: { id: "symbol-1" } }];
            if (key === "edge_list") return [{ type: "DEFINES", properties: {} }];
            return undefined;
          },
        },
      ],
    });

    const results = await retrieveContext("terraform force_new drift", baseConfig, {
      topK: 5,
      metadata: {
        pack_id: "terraform-latest",
        symbol_name: "aws_instance",
      },
      version: "v1.14.9",
    });

    expect(driverMock).toHaveBeenCalledWith("bolt://nornic.local:7687", expect.anything());
    expect(sessionMock).toHaveBeenCalledWith({ database: "neo4j" });
    expect(runMock).toHaveBeenCalledTimes(1);
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain("CALL db.index.vector.queryNodes($index_name");
    expect(cypher).toContain("node.pack = $pack_id");
    expect(cypher).toContain("node.source_version = $source_version");
    expect(cypher).toContain("[rels:DEFINES|CALLS|IMPORTS*1..2]");
    expect(params).toMatchObject({
      index_name: "embeddings",
      query: "terraform force_new drift",
      pack_id: "terraform-latest",
      symbol_name: "aws_instance",
      source_version: "v1.14.9",
    });
    expect(results[0]?.pack_id).toBe("terraform-latest");
    expect(results[0]?.symbol_name).toBe("aws_instance");
    expect(results[0]?.module_path).toBe("provider-schemas/aws.json");
    expect(results[0]?.content_format).toBe("json");
  });
});
