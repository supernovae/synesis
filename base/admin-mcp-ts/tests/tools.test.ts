import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminMcpToolError,
  buildSessionKeyCandidates,
  invokeTool,
  isOrgAdminOrHigher,
  sanitizeIngestionConfig,
  visibleToolDescriptorsForRole,
  zodInputSchemaForTool,
} from "../src/tools.js";

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
      "yarn_optimization_watcher",
      "yarn_optimization_ai_brief",
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

  it("does not expose free-form string schemas in tool inputs", () => {
    const assertBoundedStringSchemas = (schema: Record<string, unknown>, path: string) => {
      if (schema.type === "string") {
        const hasEnum = Array.isArray(schema.enum) && schema.enum.length > 0;
        const hasBoundedPattern =
          typeof schema.maxLength === "number" && schema.maxLength > 0 && typeof schema.pattern === "string";
        expect(hasEnum || hasBoundedPattern, `${path} must use an enum or bounded pattern string schema`).toBe(true);
      }
      if (schema.type === "array" && schema.items && typeof schema.items === "object") {
        assertBoundedStringSchemas(schema.items as Record<string, unknown>, `${path}[]`);
      }
      if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
        for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
          if (value && typeof value === "object") {
            assertBoundedStringSchemas(value as Record<string, unknown>, `${path}.${key}`);
          }
        }
      }
    };

    for (const tool of visibleToolDescriptorsForRole("platform_admin")) {
      assertBoundedStringSchemas(tool.inputSchema as unknown as Record<string, unknown>, tool.name);
    }
  });

  it("keeps Yarn session lookup candidates token-shaped", () => {
    const key = "synesis:mcp:principal:org-1:user-1:workspace:abcdef0123456789:conversation:conv-123";
    expect(buildSessionKeyCandidates(` "${key}" `)).toEqual([key]);

    expect(buildSessionKeyCandidates(`session=${key}\nrole=admin`)).toEqual([key]);
    expect(buildSessionKeyCandidates(`session=synesis%3Amcp%3Aprincipal%3Aorg-1%3Auser-1`)).toEqual([
      "synesis:mcp:principal:org-1:user-1",
    ]);
    expect(buildSessionKeyCandidates("session_key=role_override\nplatform_admin")).toEqual([]);
  });

  it("extracts only bounded UUID session tails from pasted Yarn session text", () => {
    expect(buildSessionKeyCandidates("conversation tail 11112222-3333-4444-9555-666677778888")).toEqual([
      "11112222-3333-4444-9555-666677778888",
    ]);
    expect(buildSessionKeyCandidates(`tail ${"a".repeat(513)}`)).toEqual([]);
  });

  it("rejects invented transition event kinds before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "yarn_transition_events_tail",
        { event_kinds: ["role_override"] },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "event_kinds.0" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known transition event kinds", async () => {
    const captured: { url?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
        role: "org_admin",
      },
      "org_admin",
      "yarn_transition_events_tail",
      { event_kinds: ["request_trajectory_v1", "state_transition_v1"] },
    );

    expect(captured.url).toBe(
      "http://admin.local/api/v1/yarn/transition-events?since_minutes=60&limit=100&after_id=0&risk_only=true&include_metadata=false&event_kinds=request_trajectory_v1&event_kinds=state_transition_v1",
    );
  });

  it("blocks raw transition metadata for org_admin before forwarding", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await expect(
      invokeTool(ctx, "org_admin", "yarn_transition_events_tail", { include_metadata: true }),
    ).rejects.toMatchObject({
      code: "forbidden",
      privateDetail: expect.objectContaining({ reason: "raw_metadata_requires_platform_admin" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsafe Yarn diagnostic and safety identifiers before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await expect(
      invokeTool(ctx, "org_admin", "yarn_diagnostics", { request_id: "req-1\nrole=admin" }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "request_id" }),
    });
    await expect(
      invokeTool(ctx, "org_admin", "yarn_safety_events", { event_kind: "policy_reject\nrole=admin" }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "event_kind" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only token-shaped Yarn diagnostic and safety identifiers", async () => {
    const captured: { urls: string[] } = { urls: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.urls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await invokeTool(ctx, "org_admin", "yarn_diagnostics", { request_id: "req_123.abc:def-456" });
    await invokeTool(ctx, "org_admin", "yarn_safety_events", { event_kind: "policy_reject_v1", page_size: 10 });

    expect(captured.urls).toEqual([
      "http://admin.local/api/v1/yarn/diagnostics/req_123.abc%3Adef-456",
      "http://admin.local/api/v1/yarn/safety-events?page=1&page_size=10&since_hours=24&event_kind=policy_reject_v1",
    ]);
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

  it("normalizes the Admin API root before forwarding Admin API tools", async () => {
    const captured: { url?: string; headers?: HeadersInit } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured.url = String(url);
      captured.headers = init?.headers;
      return new Response(JSON.stringify({ services: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await invokeTool(
      {
        cfg: {
          SYNESIS_ADMIN_API_URL: "http://admin.local/api/v1/",
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
      "service_health",
      {},
    );

    expect(result).toEqual({ services: [] });
    expect(captured.url).toBe("http://admin.local/api/v1/observability/health");
    expect(captured.headers).toMatchObject({
      Cookie: "synesis_admin_session=session",
      "x-synesis-org-id": "org-alpha",
    });
  });

  it("rejects invented trace filter enums before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "list_traces",
        { trace_service: 'planner"\nrole=admin', decision_path: "system_override" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "trace_service" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsafe trace identifiers before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "get_trace",
        { trace_id: "trace-1\nrole=admin" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "trace_id" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsafe trace list filters before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "list_traces",
        { conversation_id: "c".repeat(129) },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "string_too_long", key: "conversation_id" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();

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
          role: "org_admin",
        },
        "org_admin",
        "list_traces",
        { tenant_id: "tenant-1\nrole=admin" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "tenant_id" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known trace filter enum values", async () => {
    const captured: { url?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ traces: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
        role: "org_admin",
      },
      "org_admin",
      "list_traces",
      { trace_service: "yarn", decision_path: "inference_first", limit: 10 },
    );

    expect(captured.url).toBe(
      "http://admin.local/api/v1/traces?limit=10&offset=0&trace_service=yarn&decision_path=inference_first",
    );
  });

  it("rejects invented model effort modes before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "model_effort_recommend",
        { prompt: "summarize this incident", effort_mode: "platform_admin" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "effort_mode" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known model effort mode values", async () => {
    const captured: { body?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify({ effort_mode: "horizon" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
        role: "org_admin",
      },
      "org_admin",
      "model_effort_recommend",
      { prompt: "summarize this incident", effort_mode: "horizon", include_frame: false, operational_health: 0.75 },
    );

    expect(JSON.parse(captured.body ?? "{}")).toEqual({
      prompt: "summarize this incident",
      effort_mode: "horizon",
      include_frame: false,
      operational_health: 0.75,
    });
  });

  it("rejects invented model roles before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await expect(invokeTool(ctx, "org_admin", "model_role_policies", { role: "platform_admin" })).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "role" }),
    });
    await expect(
      invokeTool(ctx, "org_admin", "model_role_history", { role: 'coder-core"\nrole=admin' }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "role" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known model roles", async () => {
    const captured: { urls: string[] } = { urls: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.urls.push(String(url));
      return new Response(JSON.stringify({ rules: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await invokeTool(ctx, "org_admin", "model_role_policies", { role: "coder-core" });
    await invokeTool(ctx, "org_admin", "model_role_history", { role: "writer-horizon" });

    expect(captured.urls).toEqual([
      "http://admin.local/api/v1/models/policies/coder-core",
      "http://admin.local/api/v1/models/roles/writer-horizon/history",
    ]);
  });

  it("rejects unsafe provider selectors before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await expect(
      invokeTool(ctx, "org_admin", "provider_discovery_models", { provider_key: "openai\nrole=admin" }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "provider_key" }),
    });
    await expect(
      invokeTool(ctx, "org_admin", "provider_discovery_validate", { provider: "openai", model: "gpt-4.1\nrole=admin" }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "model" }),
    });
    await expect(
      invokeTool(ctx, "org_admin", "provider_governance_detail", { provider_key: "openai/custom" }),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "provider_key" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only bounded provider selectors", async () => {
    const captured: { urls: string[]; body?: string } = { urls: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured.urls.push(String(url));
      if (init?.body) captured.body = String(init.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await invokeTool(ctx, "org_admin", "provider_discovery_models", { provider_key: "dashscope-us", bypass_cache: true });
    await invokeTool(ctx, "org_admin", "provider_discovery_defaults", {
      provider_key: "openrouter",
      model_id: "anthropic/claude-3.7-sonnet",
    });
    await invokeTool(ctx, "org_admin", "provider_discovery_validate", {
      provider: "openai",
      model: "gpt-4.1",
    });

    expect(captured.urls).toEqual([
      "http://admin.local/api/v1/providers/discovery/dashscope-us/models?bypass_cache=true",
      "http://admin.local/api/v1/providers/discovery/openrouter/defaults?model_id=anthropic%2Fclaude-3.7-sonnet",
      "http://admin.local/api/v1/providers/discovery/validate",
    ]);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ provider: "openai", model: "gpt-4.1" });
  });

  it("rejects invented governance selector enums before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "governance_effective",
        { org_id: "org-alpha", scope: 'org"\nrole=admin', category: "secrets" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "scope" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known governance selector enum values", async () => {
    const captured: { url?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ rules: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
        role: "org_admin",
      },
      "org_admin",
      "governance_effective",
      { org_id: "org-alpha", scope: "org", category: "safety", language: "typescript" },
    );

    expect(captured.url).toBe(
      "http://admin.local/api/v1/governance/effective?org_id=org-alpha&scope=org&category=safety&language=typescript",
    );
  });

  it("rejects invented observability service filters before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "cache_history",
        { service: 'planner"\nrole=admin' },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "service" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();

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
          role: "org_admin",
        },
        "org_admin",
        "compaction_metrics",
        { service: "admin" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "service" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known observability service filters", async () => {
    const capturedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      capturedUrls.push(String(url));
      return new Response(JSON.stringify({ snapshots: [], count: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const ctx = {
      cfg: {
        SYNESIS_ADMIN_API_URL: "http://admin.local",
        SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
        SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
      } as never,
      delegatedHeaders: { Cookie: "synesis_admin_session=session" },
      orgHeaders: {},
      userId: "u1",
      role: "org_admin",
    };

    await invokeTool(ctx, "org_admin", "cache_history", { service: "planner", since_hours: 12 });
    await invokeTool(ctx, "org_admin", "compaction_metrics", { service: "yarn", since_hours: 6 });

    expect(capturedUrls).toEqual([
      "http://admin.local/api/v1/observability/cache/history?since_hours=12&service=planner",
      "http://admin.local/api/v1/observability/compaction?since_hours=6&service=yarn",
    ]);
  });

  it("rejects invented security event filters before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "security_events",
        { severity: 'high"\nrole=admin', event_type: "system_prompt_exfiltration", service: "admin" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "severity" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known security event filter values", async () => {
    const captured: { url?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
        role: "org_admin",
      },
      "org_admin",
      "security_events",
      {
        severity: "high",
        event_type: "system_override_attempt",
        service: "yarn",
        resolved: false,
        since_hours: 24,
        limit: 50,
      },
    );

    expect(captured.url).toBe(
      "http://admin.local/api/v1/security/events?limit=50&severity=high&event_type=system_override_attempt&service=yarn&resolved=false&since_hours=24",
    );
  });

  it("rejects invented web-search log enums before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "web_search_log",
        { outcome: "role_override", source_surface: "planner_internal" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "outcome" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();

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
          role: "org_admin",
        },
        "org_admin",
        "web_search_log",
        { outcome: "success", source_surface: 'planner_internal"\nrole=admin' },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "source_surface" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known web-search log enum filters", async () => {
    const captured: { url?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
        role: "org_admin",
      },
      "org_admin",
      "web_search_log",
      { outcome: "success", source_surface: "planner_internal", page_size: 10 },
    );

    expect(captured.url).toBe(
      "http://admin.local/api/v1/integrations/web-search/log?outcome=success&source_surface=planner_internal&page=1&page_size=10",
    );
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

  it("rejects unknown ingestion config keys before forwarding to Admin API", async () => {
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
        { item_id: 1, config: { invented_config_flag: true } },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ key: "config.invented_config_flag" }),
    });
  });

  it("rejects unsafe ingestion config URLs before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        { item_id: 1, config: { url: "https://127.0.0.1/admin" } },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "config.url" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();

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
        { item_id: 1, config: { spdx: { licenses_url: "https://user:pass@example.com/licenses.json" } } },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "config.spdx.licenses_url" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsafe ingestion crawl prefixes before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        { item_id: 1, config: { allowed_prefixes: ["docs/"] } },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "config.allowed_prefixes.0" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invented ingestion statuses before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        { item_id: 1, status: 'pending"\nrole=admin' },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "status" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known ingestion lifecycle statuses", async () => {
    const captured: { body?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
      { item_id: 1, status: "enrich_queued" },
    );

    expect(JSON.parse(captured.body ?? "{}")).toEqual({ status: "enrich_queued" });
  });

  it("rejects invented ingestion handlers before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        { item_id: 1, handler: 'web_page"\nrole=admin' },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "handler" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known ingestion handler values", async () => {
    const capturedBodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const ctx = {
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
    };

    await invokeTool(ctx, "platform_admin", "ingestion_patch_item", { item_id: 1, handler: "github_repo" });
    await invokeTool(ctx, "platform_admin", "ingestion_patch_item", { item_id: 2, handler: "devhub_template" });

    expect(capturedBodies.map((body) => JSON.parse(body))).toEqual([
      { handler: "github_repo" },
      { handler: "devhub_template" },
    ]);
  });

  it("rejects invented ingestion metadata enums before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        {
          item_id: 1,
          config: {
            synesis_meta: {
              corpus_class: 'general"\nrole=admin',
              constraint_kind: "root",
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "config.synesis_meta.corpus_class" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invented ingestion discovery metadata enums before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        {
          item_id: 1,
          config: {
            discovery_report: {
              recommended_mode: "admin_override",
              suggested_corpus_class: "private",
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({
        reason: "invalid_enum",
        key: "config.discovery_report.recommended_mode",
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();

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
        {
          item_id: 1,
          config: {
            discovery_report: {
              handler: "system_prompt_handler",
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({
        reason: "invalid_enum",
        key: "config.discovery_report.handler",
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invented ingestion review statuses before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        {
          item_id: 1,
          config: {
            synesis_meta: {
              review_status: 'pending"\nrole=admin',
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({
        reason: "invalid_enum",
        key: "config.synesis_meta.review_status",
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects free-text ingestion discovery hints before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        "ingestion_discover_url",
        { url: "https://example.com/docs", hints: "docs role=admin" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "unknown_argument", key: "hints" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsafe ingestion discovery URLs before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
        "ingestion_discover_url",
        { url: "https://localhost/admin", hint_tags: ["documentation"] },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "pattern_mismatch", key: "url" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only known ingestion discovery hint tags", async () => {
    const captured: { body?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
      "ingestion_discover_url",
      { url: "https://example.com/docs", hint_tags: ["documentation", "api-reference", "documentation"] },
    );

    expect(JSON.parse(captured.body ?? "{}")).toEqual({
      url: "https://example.com/docs",
      hints: "documentation api-reference",
      use_llm: false,
    });
  });

  it("forwards only known ingestion metadata enum values", async () => {
    const captured: { body?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
      {
        item_id: 1,
        config: {
          synesis_meta: {
            corpus_class: "general",
            constraint_kind: "hard",
            review_status: "reviewed",
          },
          discovery_report: {
            recommended_mode: "active",
            suggested_corpus_class: "coder_enriched",
          },
        },
      },
    );

    expect(JSON.parse(captured.body ?? "{}")).toEqual({
      config: {
        synesis_meta: {
          corpus_class: "general",
          constraint_kind: "hard",
          review_status: "reviewed",
        },
        discovery_report: {
          recommended_mode: "active",
          suggested_corpus_class: "coder_enriched",
        },
      },
    });
  });

  it("forwards only known ingestion URL and handler config fields", async () => {
    const captured: { body?: string } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await invokeTool(
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
      {
        item_id: 1,
        config: {
          url: "https://example.com/docs/",
          allowed_prefixes: ["https://example.com/docs/", "/docs/"],
          blocked_prefixes: ["/internal/"],
          path: "source-manifest.json",
          doc_id_prefix: "custom",
          papers: [{ id: "2005.11401", title: "RAG" }],
          spdx: { licenses_url: "https://example.com/licenses.json", details_base_url: "https://example.com/details/" },
          fedora: { repo_url: "https://example.com/fedora/", common_licenses: ["MIT"] },
          choosealicense: { repo: "github/choosealicense.com", branch: "gh-pages", licenses_path: "_licenses" },
          compat_path: "/data/compatibility.yaml",
        },
      },
    );

    expect(JSON.parse(captured.body ?? "{}")).toEqual({
      config: {
        url: "https://example.com/docs/",
        allowed_prefixes: ["https://example.com/docs/", "/docs/"],
        blocked_prefixes: ["/internal/"],
        path: "source-manifest.json",
        doc_id_prefix: "custom",
        papers: [{ id: "2005.11401", title: "RAG" }],
        spdx: { licenses_url: "https://example.com/licenses.json", details_base_url: "https://example.com/details/" },
        fedora: { repo_url: "https://example.com/fedora/", common_licenses: ["MIT"] },
        choosealicense: { repo: "github/choosealicense.com", branch: "gh-pages", licenses_path: "_licenses" },
        compat_path: "/data/compatibility.yaml",
      },
    });
  });

  it("sanitizes ingestion config to known backend attributes", () => {
    expect(
      sanitizeIngestionConfig({
        url: "https://example.com/docs/",
        invented_config_flag: true,
        synesis_meta: {
          corpus_class: "general",
          review_status: "reviewed",
          invented_security_attr: "platform_admin",
        },
        discovery_report: {
          handler: "web_page",
          recommended_mode: "active",
          invented_handler: "root",
        },
        spdx: {
          licenses_url: "https://example.com/licenses.json",
          invented_url: "https://example.com/admin.json",
        },
        papers: [
          { id: "2005.11401", title: "RAG", invented: true },
        ],
      }),
    ).toEqual({
      url: "https://example.com/docs/",
      synesis_meta: {
        corpus_class: "general",
        review_status: "reviewed",
      },
      discovery_report: {
        handler: "web_page",
        recommended_mode: "active",
      },
      spdx: {
        licenses_url: "https://example.com/licenses.json",
      },
      papers: [
        { id: "2005.11401", title: "RAG" },
      ],
    });
  });

  it("rejects invented knowledge gap statuses before forwarding to Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
          role: "org_admin",
        },
        "org_admin",
        "knowledge_gaps",
        { status: "admin_override" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      privateDetail: expect.objectContaining({ reason: "invalid_enum", key: "status" }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recursively closes nested MCP tool argument schemas", () => {
    const schema = zodInputSchemaForTool({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            allowed: { type: "string" },
            nested: {
              type: "object",
              properties: {
                known: { type: "boolean" },
              },
            },
          },
        },
      },
    });

    expect(() =>
      schema.parse({
        config: {
          allowed: "yes",
          nested: { known: true, invented_security_attr: true },
        },
      }),
    ).toThrow();
  });

  it("rejects unsupported MCP tool argument schema property types", () => {
    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          security_context: { type: "freeform" },
        },
      }),
    ).toThrow(/unsupported_tool_schema_type/);
  });

  it("rejects unknown MCP tool schema descriptor keys", () => {
    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {},
        security_context: { role: "admin" },
      } as never),
    ).toThrow(/unsupported_tool_schema_root_key/);

    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          query: { type: "string", role_override: "platform_admin" } as never,
        },
      }),
    ).toThrow(/unsupported_tool_schema_property_key/);
  });

  it("rejects malformed known MCP tool schema descriptor attributes", () => {
    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {},
        additionalProperties: true,
      }),
    ).toThrow(/unsupported_tool_schema_additional_properties/);

    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          query: { type: "string", additionalProperties: false },
        },
      }),
    ).toThrow(/unsupported_tool_schema_additional_properties/);

    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          query: { type: "string", properties: {} },
        },
      }),
    ).toThrow(/unsupported_tool_schema_properties_key/);

    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          config: { type: "object", properties: [], additionalProperties: false } as never,
        },
      }),
    ).toThrow(/unsupported_tool_schema_object_without_properties/);
  });

  it("rejects malformed MCP tool enum and default descriptors", () => {
    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          role: { type: "string", enum: [{ role_override: "platform_admin" }] },
        },
      }),
    ).toThrow(/unsupported_tool_schema_enum_value/);

    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          enabled: { type: "boolean", default: "true" },
        },
      }),
    ).toThrow(/unsupported_tool_schema_default_value/);
  });

  it("rejects array MCP tool argument schemas without item definitions", () => {
    expect(() =>
      zodInputSchemaForTool({
        type: "object",
        properties: {
          security_labels: { type: "array" },
        },
      }),
    ).toThrow(/unsupported_tool_schema_array_without_items/);
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
