import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";

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
});
