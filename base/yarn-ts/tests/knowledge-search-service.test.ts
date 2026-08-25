import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KnowledgeSearchService,
  KNOWLEDGE_TOOL_NAME,
  CONTEXT_BUNDLE_TOOL_NAME,
  DEV_DOCS_TOOL_NAME,
  KNOWLEDGE_TOOL_SCHEMA_OPENAI,
  KNOWLEDGE_TOOL_SCHEMA_CLAUDE,
  CONTEXT_BUNDLE_TOOL_SCHEMA_OPENAI,
  CONTEXT_BUNDLE_TOOL_SCHEMA_CLAUDE,
  DEV_DOCS_TOOL_SCHEMA_OPENAI,
  DEV_DOCS_TOOL_SCHEMA_CLAUDE,
} from "../src/state/knowledge-search.js";

const deps = {
  plannerBaseUrl: "http://planner.test:8080",
  criticUrl: "http://critic.test/v1",
  criticModel: "synesis-critic",
  internalServiceToken: "internal-token",
};

describe("KnowledgeSearchService", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolve()", () => {
    it("returns parsed results on successful planner response", async () => {
      const mockResult = {
        results: [
          {
            text: "TypeScript error TS2345 explanation",
            source_url: "https://ts.dev/errors/2345",
            document_name: "TS Error Catalog",
            authority: "official",
            score: 0.92,
            constraint_kind: "hard",
            corpus_class: "coder_enriched",
            scope_tags: ["error-catalog"],
            language: "typescript",
            context_prefix: "TypeScript compiler errors",
            chunk_summary: "TS2345: Argument type mismatch",
            content_profile: "",
            constraint_source: "",
            constraint_confidence: 0,
            golden_path_id: "",
            novel_pattern: false,
          },
        ],
        query: "TypeScript error TS2345",
        total: 1,
      };

      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify(mockResult), { status: 200 }),
      );

      const service = new KnowledgeSearchService(deps);
      const result = await service.resolve(
        { query: "TypeScript error TS2345" },
        {
          orgId: "o1",
          userId: "u1",
          tenantIds: [],
          bearerToken: "syn-test-pat",
        },
      );

      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].score).toBe(0.92);
      expect(String(fetchSpy.mock.calls[0][0])).toContain("/v1/knowledge/search");
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer internal-token");
      expect((init.headers as Record<string, string>)["x-openwebui-user-id"]).toBe("u1");
      expect((init.headers as Record<string, string>)["x-synesis-org-id"]).toBe("o1");
    });

    it("passes caller identity into planner JSON body", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }));

      const service = new KnowledgeSearchService(deps);
      await service.resolve(
        { query: "q" },
        {
          orgId: "org-override",
          userId: "user-override",
          tenantIds: ["t1"],
          bearerToken: "syn-x",
        },
      );

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body.caller_org_id).toBe("org-override");
      expect(body.caller_user_id).toBe("user-override");
      expect(body.caller_tenant_ids).toEqual(["t1"]);
    });

    it("adapts bundle source_chunks into the standard evidence result shape", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            query: "go shutdown",
            source_chunks: [{ text: "Use Server.Shutdown", source_url: "https://pkg.go.dev/net/http", document_name: "net/http", authority: "canonical", score: 1 }],
            context_cards: [{ title: "Server.Shutdown" }],
            examples: [],
            anti_patterns: [],
          }),
          { status: 200 },
        ),
      );

      const service = new KnowledgeSearchService(deps);
      const result = await service.resolve({ query: "go shutdown", mode: "bundle" });

      expect(result.total).toBe(1);
      expect(result.results[0]?.text).toContain("Server.Shutdown");
      expect(result.context_cards).toHaveLength(1);
    });

    it("falls back to internal service token when no bearer", async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }));

      const service = new KnowledgeSearchService(deps);
      await service.resolve({ query: "q" });

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer internal-token");
    });

    it("returns empty results on HTTP error", async () => {
      fetchSpy.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

      const service = new KnowledgeSearchService(deps);
      const result = await service.resolve({ query: "test" }, {
        orgId: "o",
        userId: "u",
        tenantIds: [],
        bearerToken: "syn-x",
      });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(service.getStats().errorCount).toBe(1);
    });

    it("returns empty results on network error", async () => {
      fetchSpy.mockRejectedValue(new Error("Connection refused"));

      const service = new KnowledgeSearchService(deps);
      const result = await service.resolve({ query: "test" });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(service.getStats().errorCount).toBe(1);
    });
  });

  describe("injectToolOpenAI()", () => {
    it("adds tool to undefined tools list", () => {
      const service = new KnowledgeSearchService(deps);
      const tools = service.injectToolOpenAI(undefined);
      expect(tools).toHaveLength(3);
      const names = (tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name);
      expect(names).toContain(KNOWLEDGE_TOOL_NAME);
      expect(names).toContain(CONTEXT_BUNDLE_TOOL_NAME);
      expect(names).toContain(DEV_DOCS_TOOL_NAME);
    });

    it("does not duplicate if already present", () => {
      const service = new KnowledgeSearchService(deps);
      const existing = [KNOWLEDGE_TOOL_SCHEMA_OPENAI, CONTEXT_BUNDLE_TOOL_SCHEMA_OPENAI, DEV_DOCS_TOOL_SCHEMA_OPENAI];
      const tools = service.injectToolOpenAI(existing);
      expect(tools).toHaveLength(3);
    });

    it("appends alongside existing tools", () => {
      const service = new KnowledgeSearchService(deps);
      const existing = [{ type: "function", function: { name: "other_tool" } }];
      const tools = service.injectToolOpenAI(existing);
      expect(tools).toHaveLength(4);
    });
  });

  describe("injectToolClaude()", () => {
    it("adds tool to undefined tools list", () => {
      const service = new KnowledgeSearchService(deps);
      const tools = service.injectToolClaude(undefined);
      expect(tools).toHaveLength(3);
      const names = (tools as Array<{ name?: string }>).map((t) => t.name);
      expect(names).toContain(KNOWLEDGE_TOOL_NAME);
      expect(names).toContain(CONTEXT_BUNDLE_TOOL_NAME);
      expect(names).toContain(DEV_DOCS_TOOL_NAME);
    });

    it("does not duplicate if already present", () => {
      const service = new KnowledgeSearchService(deps);
      const existing = [KNOWLEDGE_TOOL_SCHEMA_CLAUDE, CONTEXT_BUNDLE_TOOL_SCHEMA_CLAUDE, DEV_DOCS_TOOL_SCHEMA_CLAUDE];
      const tools = service.injectToolClaude(existing);
      expect(tools).toHaveLength(3);
    });
  });

  describe("getStats()", () => {
    it("tracks search and error counts", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ results: [], query: "a", total: 0 }), { status: 200 }));
      fetchSpy.mockRejectedValueOnce(new Error("fail"));

      const service = new KnowledgeSearchService(deps);
      await service.resolve({ query: "a" });
      await service.resolve({ query: "b" });

      const stats = service.getStats();
      expect(stats.searchCount).toBe(2);
      expect(stats.errorCount).toBe(1);
    });
  });
});
