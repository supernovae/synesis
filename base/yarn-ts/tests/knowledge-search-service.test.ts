import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KnowledgeSearchService,
  KNOWLEDGE_TOOL_NAME,
  KNOWLEDGE_TOOL_SCHEMA_OPENAI,
  KNOWLEDGE_TOOL_SCHEMA_CLAUDE,
} from "../src/state/knowledge-search.js";

describe("KnowledgeSearchService", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolve()", () => {
    it("returns parsed results on successful response", async () => {
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
          },
        ],
        query: "TypeScript error TS2345",
        total: 1,
      };

      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify(mockResult) }],
          }),
          { status: 200 },
        ),
      );

      const service = new KnowledgeSearchService("http://mcp:8080");
      const result = await service.resolve({ query: "TypeScript error TS2345" });

      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].score).toBe(0.92);
      expect(result.query).toBe("TypeScript error TS2345");
    });

    it("passes caller identity when provided", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ content: [{ text: '{"results":[],"query":"q","total":0}' }] }),
          { status: 200 },
        ),
      );

      const service = new KnowledgeSearchService("http://mcp:8080", "org-1", "user-1");
      await service.resolve(
        { query: "q" },
        { orgId: "org-override", userId: "user-override", aclGroups: ["admin"] },
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.caller.org_id).toBe("org-override");
      expect(body.caller.user_id).toBe("user-override");
      expect(body.caller.acl_groups).toEqual(["admin"]);
    });

    it("uses constructor defaults for caller when no overrides", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ content: [{ text: '{"results":[],"query":"q","total":0}' }] }),
          { status: 200 },
        ),
      );

      const service = new KnowledgeSearchService("http://mcp:8080", "default-org", "default-user");
      await service.resolve({ query: "q" });

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.caller.org_id).toBe("default-org");
      expect(body.caller.user_id).toBe("default-user");
    });

    it("returns empty results on HTTP error", async () => {
      fetchSpy.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

      const service = new KnowledgeSearchService("http://mcp:8080");
      const result = await service.resolve({ query: "test" });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(service.getStats().errorCount).toBe(1);
    });

    it("returns empty results on network error", async () => {
      fetchSpy.mockRejectedValue(new Error("Connection refused"));

      const service = new KnowledgeSearchService("http://mcp:8080");
      const result = await service.resolve({ query: "test" });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(service.getStats().errorCount).toBe(1);
    });

    it("returns empty results on malformed JSON", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ content: [{ text: "not-json{{{" }] }),
          { status: 200 },
        ),
      );

      const service = new KnowledgeSearchService("http://mcp:8080");
      const result = await service.resolve({ query: "test" });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(service.getStats().errorCount).toBe(1);
    });

    it("strips trailing slash from MCP URL", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ content: [{ text: '{"results":[],"query":"q","total":0}' }] }),
          { status: 200 },
        ),
      );

      const service = new KnowledgeSearchService("http://mcp:8080/");
      await service.resolve({ query: "test" });

      expect(fetchSpy.mock.calls[0][0]).toBe("http://mcp:8080/mcp/tools/call");
    });
  });

  describe("injectToolOpenAI()", () => {
    it("adds tool to undefined tools list", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const tools = service.injectToolOpenAI(undefined);
      expect(tools).toHaveLength(1);
      expect((tools![0] as typeof KNOWLEDGE_TOOL_SCHEMA_OPENAI).function.name).toBe(KNOWLEDGE_TOOL_NAME);
    });

    it("adds tool to empty tools list", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const tools = service.injectToolOpenAI([]);
      expect(tools).toHaveLength(1);
    });

    it("does not duplicate if already present", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const existing = [KNOWLEDGE_TOOL_SCHEMA_OPENAI];
      const tools = service.injectToolOpenAI(existing);
      expect(tools).toHaveLength(1);
    });

    it("appends alongside existing tools", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const existing = [{ type: "function", function: { name: "other_tool" } }];
      const tools = service.injectToolOpenAI(existing);
      expect(tools).toHaveLength(2);
    });
  });

  describe("injectToolClaude()", () => {
    it("adds tool to undefined tools list", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const tools = service.injectToolClaude(undefined);
      expect(tools).toHaveLength(1);
      expect((tools![0] as typeof KNOWLEDGE_TOOL_SCHEMA_CLAUDE).name).toBe(KNOWLEDGE_TOOL_NAME);
    });

    it("does not duplicate if already present", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const existing = [KNOWLEDGE_TOOL_SCHEMA_CLAUDE];
      const tools = service.injectToolClaude(existing);
      expect(tools).toHaveLength(1);
    });

    it("appends alongside existing tools", () => {
      const service = new KnowledgeSearchService("http://mcp:8080");
      const existing = [{ name: "other_tool" }];
      const tools = service.injectToolClaude(existing);
      expect(tools).toHaveLength(2);
    });
  });

  describe("getStats()", () => {
    it("tracks search and error counts", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ content: [{ text: '{"results":[],"query":"a","total":0}' }] }),
          { status: 200 },
        ),
      );
      fetchSpy.mockRejectedValueOnce(new Error("fail"));

      const service = new KnowledgeSearchService("http://mcp:8080");
      await service.resolve({ query: "a" });
      await service.resolve({ query: "b" });

      const stats = service.getStats();
      expect(stats.searchCount).toBe(2);
      expect(stats.errorCount).toBe(1);
    });
  });
});
