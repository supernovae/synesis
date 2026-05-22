import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMcpToolError, invokeTool, isOrgAdminOrHigher, visibleToolDescriptorsForRole } from "../src/tools.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin MCP tool catalog", () => {
  it("exposes only user-safe tools below org_admin", () => {
    const userNames = new Set(visibleToolDescriptorsForRole("user").map((t) => t.name));
    expect(userNames.has("synesis_search")).toBe(true);
    expect(userNames.has("synesis_classify_intent")).toBe(true);
    expect(userNames.has("synesis_retrieval_gaps")).toBe(true);
    expect(userNames.has("yarn_user_usage")).toBe(true);
    expect(userNames.has("list_traces")).toBe(false);
    expect(userNames.has("cache_metrics")).toBe(false);
    expect(visibleToolDescriptorsForRole("readonly")).toHaveLength(0);
    expect(visibleToolDescriptorsForRole("org_admin").length).toBeGreaterThan(10);
  });

  it("covers the curated current admin API surfaces", () => {
    const names = new Set(visibleToolDescriptorsForRole("platform_admin").map((t) => t.name));
    for (const name of [
      "cache_token_economics",
      "cache_canary_report",
      "compaction_metrics",
      "failure_stats",
      "knowledge_gaps",
      "yarn_runtime_telemetry",
      "yarn_reducer_telemetry_history",
      "model_performance_detailed",
      "model_costs_by_model",
      "provider_governance_list",
      "governance_effective",
      "security_summary",
      "web_search_log",
      "synesis_search",
      "synesis_classify_intent",
      "synesis_retrieval_gaps",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("includes transition-quality tools for org_admin", () => {
    const names = new Set(visibleToolDescriptorsForRole("org_admin").map((t) => t.name));
    expect(names.has("yarn_transition_quality")).toBe(true);
    expect(names.has("yarn_transition_events_tail")).toBe(true);
    expect(names.has("yarn_transition_watch")).toBe(true);
    expect(names.has("yarn_transition_incident_brief")).toBe(true);
  });

  it("keeps platform-admin tools restricted", () => {
    const orgNames = new Set(visibleToolDescriptorsForRole("org_admin").map((t) => t.name));
    const platformNames = new Set(visibleToolDescriptorsForRole("platform_admin").map((t) => t.name));
    expect(orgNames.has("refresh_model_routes")).toBe(false);
    expect(platformNames.has("refresh_model_routes")).toBe(true);
  });

  it("treats admin aliases as admin", () => {
    expect(isOrgAdminOrHigher("admin")).toBe(true);
    expect(isOrgAdminOrHigher("platform_admin")).toBe(true);
    expect(isOrgAdminOrHigher("user")).toBe(false);
  });

  it("classifies developer intent without forwarding to Admin API", async () => {
    const result = await invokeTool(
      {
        cfg: {
          SYNESIS_ADMIN_API_URL: "http://admin.local",
          SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
          SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
          SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
        } as never,
        delegatedHeaders: { Cookie: "synesis_admin_session=session" },
        orgHeaders: {},
        userId: "u1",
        role: "user",
      },
      "user",
      "synesis_classify_intent",
      { query: "Fix this Kubernetes deployment test failure" },
    );
    expect(result).toMatchObject({ complexity: "simple" });
    expect((result as { categories: string[] }).categories).toContain("debugging");
    expect((result as { categories: string[] }).categories).toContain("operations");
    expect((result as { categories: string[] }).categories).toContain("testing");
  });

  it("forwards caller identity headers for synesis_search", async () => {
    const captured: { url?: string; headers?: HeadersInit; body?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured.url = String(url);
      captured.headers = init?.headers;
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await invokeTool(
      {
        cfg: {
          SYNESIS_ADMIN_API_URL: "http://admin.local",
          SYNESIS_PLANNER_URL: "http://planner.local",
          SYNESIS_INTERNAL_SERVICE_TOKEN: "internal-secret",
          SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "",
          SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
          SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
          SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
        } as never,
        delegatedHeaders: { Cookie: "synesis_admin_session=session" },
        orgHeaders: { "x-synesis-org-id": "org-alpha" },
        userId: "orgadm-1",
        role: "org_admin",
      },
      "org_admin",
      "synesis_search",
      { query: "test query", top_k: 3 },
    );

    expect(result).toEqual({ results: [] });
    expect(captured.url).toBe("http://planner.local/v1/knowledge/search");
    const headers = captured.headers as Record<string, string>;
    expect(headers["x-openwebui-user-id"]).toBe("orgadm-1");
    expect(headers["x-synesis-org-id"]).toBe("org-alpha");
    expect(headers["x-synesis-service-name"]).toBe("synesis-admin-mcp-ts");
    expect(headers.Authorization).toBe("Bearer internal-secret");
    expect(JSON.parse(captured.body ?? "{}")).toMatchObject({ query: "test query", top_k: 3 });
  });

  it("rejects extra tool arguments before forwarding to Admin API", async () => {
    await expect(
      invokeTool(
        {
          cfg: {
            SYNESIS_ADMIN_API_URL: "http://admin.local",
            SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
          } as never,
          delegatedHeaders: { Cookie: "synesis_admin_session=session" },
          orgHeaders: {},
          userId: "u1",
          role: "platform_admin",
        },
        "platform_admin",
        "ingestion_patch_item",
        { item_id: 1, unexpected: true },
      ),
    ).rejects.toBeInstanceOf(AdminMcpToolError);
  });

  it("rejects overly long transition watches", async () => {
    await expect(
      invokeTool(
        {
          cfg: {
            SYNESIS_ADMIN_API_URL: "http://admin.local",
            SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 1000,
            SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
          } as never,
          delegatedHeaders: { Cookie: "synesis_admin_session=session" },
          orgHeaders: {},
          userId: "u1",
          role: "org_admin",
        },
        "org_admin",
        "yarn_transition_watch",
        { polls: 2, interval_seconds: 2 },
      ),
    ).rejects.toMatchObject({ code: "watch_duration_exceeded" });
  });
});
