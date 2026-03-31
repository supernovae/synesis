import { describe, it, expect, vi, afterEach } from "vitest";
import { createKnowledgeSearchTools } from "../src/handlers/knowledge-search.js";
import type { McpConfig } from "../src/config.js";
import type { CallerIdentity } from "../src/tool-registry.js";

const baseConfig: McpConfig = {
  PORT: 8100,
  HOST: "0.0.0.0",
  LOG_LEVEL: "info",
  SYNESIS_PLANNER_URL: "http://planner.test:8080",
  SYNESIS_CRITIC_URL: "http://synesis-critic.synesis-models.svc.cluster.local:8080/v1",
  SYNESIS_CRITIC_MODEL: "synesis-critic",
  SYNESIS_INTERNAL_SERVICE_TOKEN: "svc-token",
};

describe("createKnowledgeSearchTools", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function toolByName(name: string) {
    const tools = createKnowledgeSearchTools(baseConfig);
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  }

  it("forwards filters in POST body", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://planner.test:8080/v1/knowledge/search");
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe("hello");
      expect(body.top_k).toBe(7);
      expect(body.language).toBe("python");
      expect(body.artifact_kind).toBe("docs");
      expect(body.domain).toBe("infra");
      expect(body.corpus_class).toBe("c1");
      expect(body.constraint_kind).toBe("k1");
      expect(body.scope_tags).toEqual(["s1", "s2"]);
      expect(body.tags).toBe("tagx");
      expect(body.content_format).toBe("yaml");
      expect(body.repo_path).toBe("org/r");
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const search = toolByName("synesis_search");
    await search.handler(
      {
        query: "hello",
        top_k: 7,
        language: "python",
        artifact_kind: "docs",
        domain: "infra",
        corpus_class: "c1",
        constraint_kind: "k1",
        scope_tags: ["s1", "s2"],
        tags: "tagx",
        content_format: "yaml",
        repo_path: "org/r",
      },
      undefined,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer svc-token");
  });

  it("forwards caller identity as caller_* fields", async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.caller_org_id).toBe("org-9");
      expect(body.caller_tenant_ids).toEqual(["ta", "tb"]);
      expect(body.caller_acl_groups).toEqual(["readers"]);
      expect(body.caller_user_id).toBe("user-1");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const search = toolByName("synesis_search");
    const caller: CallerIdentity = {
      org_id: "org-9",
      tenant_ids: ["ta", "tb"],
      acl_groups: ["readers"],
      user_id: "user-1",
    };
    await search.handler({ query: "q" }, caller);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("synesis_code_search presets artifact_kind=code", async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.artifact_kind).toBe("code");
      expect(body.query).toBe("fn main");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const t = toolByName("synesis_code_search");
    await t.handler({ query: "fn main", language: "rust" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("synesis_docs_search presets artifact_kind=docs", async () => {
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.artifact_kind).toBe("docs");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const t = toolByName("synesis_docs_search");
    await t.handler({ query: "readme" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("handles 404 gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );

    const search = toolByName("synesis_search");
    const out = (await search.handler({ query: "x" })) as Record<string, unknown>;
    expect(out.results).toEqual([]);
    expect(out.note).toBe("Knowledge search endpoint not yet available");
  });
});
