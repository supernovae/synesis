import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AdminMcpConcurrencyLimiter } from "../src/concurrency-limiter.js";
import {
  buildAdminMcpAuditFields,
  createApp,
  invokeAdminMcpToolWithControls,
  parseAdminMcpToolName,
} from "../src/index.js";

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    ...loadConfig(),
    SYNESIS_INTERNAL_SERVICE_TOKEN: "internal-secret",
    SYNESIS_ADMIN_API_URL: "http://admin.local",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin MCP internal auth", () => {
  function mockUser(role = "user") {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          username: role,
          role,
          user_id: "u1",
          org_id: "o1",
          org_name: "Org",
          org_roles: role === "org_admin" ? ["admin"] : [],
          tenant_ids: [],
          token_scopes: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  const delegatedHeaders = {
    "x-synesis-service-token": "internal-secret",
    "x-synesis-delegated-cookie": "synesis_admin_session=session",
  };

  it("reports ready from local configuration without probing the Admin API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should_not_probe"));
    const app = createApp(cfg());
    const res = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ready",
      checks: {
        internal_service_token_configured: true,
        admin_api_url_configured: true,
        mcp_http_path_configured: true,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not ready when the internal service token is not configured", async () => {
    const app = createApp(cfg({ SYNESIS_INTERNAL_SERVICE_TOKEN: "" }));
    const res = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "not_ready",
      checks: { internal_service_token_configured: false },
    });
  });

  it("rejects direct user bearer calls without the internal service token", async () => {
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: { authorization: "Bearer user-token" },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("allows Admin API mediated calls with service token and delegated cookie", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          username: "admin",
          role: "org_admin",
          user_id: "u1",
          org_id: "o1",
          org_name: "Org",
          org_roles: ["admin"],
          tenant_ids: [],
          token_scopes: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        "x-synesis-service-token": "internal-secret",
        "x-synesis-delegated-cookie": "synesis_admin_session=session",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().tools.length).toBeGreaterThan(10);
  });

  it("normalizes the Admin API root before validating delegated sessions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "admin", role: "org_admin", user_id: "u1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createApp(cfg({ SYNESIS_ADMIN_API_URL: "http://admin.local/api/v1" }));
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        "x-synesis-service-token": "internal-secret",
        "x-synesis-delegated-cookie": "synesis_admin_session=session",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://admin.local/api/v1/auth/me",
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: "synesis_admin_session=session" }) }),
    );
  });

  it("allows trusted non-admin sessions but only returns user-safe tools", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "user", role: "user", user_id: "u1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        "x-synesis-service-token": "internal-secret",
        "x-synesis-delegated-cookie": "synesis_admin_session=session",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const names = new Set(res.json().tools.map((tool: { name: string }) => tool.name));
    expect(names.has("synesis_classify_intent")).toBe(true);
    expect(names.has("get_trace")).toBe(false);
  });

  it("rejects unknown security attributes in Admin API session responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          username: "admin",
          role: "org_admin",
          user_id: "u1",
          role_override: "platform_admin",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: delegatedHeaders,
    });
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "bad_gateway" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown Admin API session roles", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "admin", role: "super_admin", user_id: "u1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: delegatedHeaders,
    });
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "bad_gateway" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed active org headers before validating delegated sessions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should_not_validate_session"));
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        ...delegatedHeaders,
        "x-synesis-org-id": "org alpha",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_org_header" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects active org headers that do not match the validated session org", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "admin", role: "org_admin", user_id: "u1", org_id: "org-real" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        ...delegatedHeaders,
        "x-synesis-org-id": "org-attacker",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("advertises closed input schemas for visible tools", async () => {
    mockUser("user");
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: delegatedHeaders,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const tools = res.json().tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    const classify = tools.find((tool) => tool.name === "synesis_classify_intent");
    expect(classify?.inputSchema.additionalProperties).toBe(false);
  });

  it("rejects unknown direct tool arguments before invocation", async () => {
    const fetchSpy = mockUser("user");
    const app = createApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin-tools/invoke",
      headers: delegatedHeaders,
      payload: {
        name: "synesis_classify_intent",
        arguments: { query: "debug this", invented_flag: true },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_arguments", tool: "synesis_classify_intent" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong-typed direct tool arguments before invocation", async () => {
    const fetchSpy = mockUser("user");
    const app = createApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin-tools/invoke",
      headers: delegatedHeaders,
      payload: {
        name: "synesis_classify_intent",
        arguments: { query: 42 },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_arguments", tool: "synesis_classify_intent" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown direct tool invoke envelope fields", async () => {
    const fetchSpy = mockUser("user");
    const app = createApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin-tools/invoke",
      headers: delegatedHeaders,
      payload: {
        name: "synesis_classify_intent",
        arguments: { query: "debug this" },
        role_override: "platform_admin",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request", detail: "invalid request body" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid direct tool names before lookup", async () => {
    const fetchSpy = mockUser("user");
    const app = createApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin-tools/invoke",
      headers: delegatedHeaders,
      payload: {
        name: "synesis_classify_intent;role=platform_admin",
        arguments: { query: "debug this" },
      },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request", detail: "invalid tool name" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent direct tool invocations per validated user", async () => {
    let healthCalls = 0;
    let releaseHealth: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl.endsWith("/api/v1/auth/me")) {
        return new Response(
          JSON.stringify({
            username: "admin",
            role: "org_admin",
            user_id: "u1",
            org_id: "o1",
            org_name: "Org",
            org_roles: ["admin"],
            tenant_ids: [],
            token_scopes: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (textUrl.endsWith("/api/v1/observability/health")) {
        healthCalls += 1;
        return await new Promise<Response>((resolve) => {
          releaseHealth = resolve;
        });
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    });

    const app = createApp(cfg({ SYNESIS_ADMIN_MCP_TOOL_MAX_CONCURRENT_PER_USER: 1 }));
    const first = app.inject({
      method: "POST",
      url: "/v1/admin-tools/invoke",
      headers: delegatedHeaders,
      payload: { name: "service_health", arguments: {} },
    });

    for (let i = 0; i < 20 && healthCalls === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(healthCalls).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/v1/admin-tools/invoke",
      headers: delegatedHeaders,
      payload: { name: "service_health", arguments: {} },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "rate_limit_exceeded" });

    releaseHealth?.(new Response(JSON.stringify({ services: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const firstRes = await first;
    await app.close();

    expect(firstRes.statusCode).toBe(200);
    expect(healthCalls).toBe(1);
  });

  it("rejects malformed MCP JSON-RPC envelopes before transport dispatch", async () => {
    const fetchSpy = mockUser("org_admin");
    const app = createApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: delegatedHeaders,
      payload: {
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "synesis_classify_intent" },
        role_override: "platform_admin",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_mcp_request" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("authenticates MCP requests before JSON-RPC preflight details are exposed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("should_not_validate_session"));
    const app = createApp(cfg());
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: { name: "synesis_classify_intent" },
        role_override: "platform_admin",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("admin MCP direct invoke security helpers", () => {
  const authCtx = {
    delegatedHeaders: { Cookie: "synesis_admin_session=session" },
    orgHeaders: {},
    user: {
      username: "user",
      role: "user" as const,
      user_id: "u1",
      org_id: "o1",
      org_name: "Org",
      org_roles: [],
      tenant_ids: [],
      token_scopes: [],
    },
  };

  const toolContext = {
    cfg: {
      SYNESIS_ADMIN_API_URL: "http://admin.local",
      SYNESIS_ADMIN_MCP_TOOL_TIMEOUT_MS: 1000,
      SYNESIS_ADMIN_MCP_WATCH_MAX_MS: 30000,
      SYNESIS_ADMIN_MCP_WATCH_MAX_CONCURRENT_PER_USER: 1,
    } as never,
    delegatedHeaders: authCtx.delegatedHeaders,
    orgHeaders: authCtx.orgHeaders,
    userId: "u1",
    role: "user",
    user: authCtx.user,
  };

  it("accepts only bounded tool identifiers", () => {
    expect(parseAdminMcpToolName("synesis_classify_intent")).toBe("synesis_classify_intent");
    expect(parseAdminMcpToolName(" audit.events ")).toBe("audit.events");
    expect(parseAdminMcpToolName("bad tool")).toBeNull();
    expect(parseAdminMcpToolName("tool;role=admin")).toBeNull();
    expect(parseAdminMcpToolName("x".repeat(129))).toBeNull();
    expect(parseAdminMcpToolName({ name: "service_health" })).toBeNull();
  });

  it("emits uniform direct invoke audit fields", () => {
    expect(buildAdminMcpAuditFields({
      user: {
        username: "admin",
        role: "org_admin",
        user_id: "u1",
        org_id: "o1",
        org_name: "Org",
        org_roles: ["admin"],
        tenant_ids: [],
        token_scopes: [],
      },
      toolName: "service_health",
      requestId: "req-1",
      outcome: "denied",
      reason: "user_concurrency_exceeded",
      statusCode: 429,
      elapsedMs: 7,
      limitMeta: {
        userActive: 1,
        userLimit: 1,
        globalActive: 3,
        globalLimit: 100,
      },
    })).toMatchObject({
      surface: "admin_mcp_direct",
      action: "admin_tool_invoke",
      outcome: "denied",
      reason: "user_concurrency_exceeded",
      statusCode: 429,
      tool: "service_health",
      userId: "u1",
      username: "admin",
      orgId: "o1",
      role: "org_admin",
      requestId: "req-1",
      elapsed_ms: 7,
      userActive: 1,
      userLimit: 1,
      globalActive: 3,
      globalLimit: 100,
    });
  });

  it("invokes streamable MCP tools through controlled audit logging", async () => {
    const audit: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
    const result = await invokeAdminMcpToolWithControls({
      authCtx,
      toolContext,
      role: "user",
      toolName: "synesis_classify_intent",
      args: { query: "Fix this Kubernetes deployment test failure" },
      requestId: "req-stream",
      surface: "admin_mcp_streamable",
      limiter: new AdminMcpConcurrencyLimiter({ maxPerUser: 1, maxGlobal: 10 }),
      auditLog: (level, fields, message) => audit.push({ level, fields, message }),
    });

    expect(result).toMatchObject({ complexity: "simple" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      level: "info",
      message: "admin_tools_invoke",
      fields: {
        surface: "admin_mcp_streamable",
        outcome: "allowed",
        reason: "ok",
        tool: "synesis_classify_intent",
        userId: "u1",
        orgId: "o1",
      },
    });
  });

  it("limits streamable MCP tool invocations before execution", async () => {
    const limiter = new AdminMcpConcurrencyLimiter({ maxPerUser: 1, maxGlobal: 10 });
    const held = limiter.tryAcquire({ orgId: "o1", userId: "u1" });
    expect(held.allowed).toBe(true);
    const audit: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];

    await expect(invokeAdminMcpToolWithControls({
      authCtx,
      toolContext,
      role: "user",
      toolName: "synesis_classify_intent",
      args: { query: "should not execute" },
      requestId: "req-stream-limit",
      surface: "admin_mcp_streamable",
      limiter,
      auditLog: (level, fields, message) => audit.push({ level, fields, message }),
    })).rejects.toMatchObject({ code: "rate_limit_exceeded", statusCode: 429 });

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      level: "warn",
      message: "admin_tools_invoke_denied",
      fields: {
        surface: "admin_mcp_streamable",
        outcome: "denied",
        reason: "user_concurrency_exceeded",
        statusCode: 429,
        userActive: 1,
        userLimit: 1,
      },
    });
    if (held.allowed) held.release();
  });
});
