import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpRoutes } from "../src/mcp/index.js";
import type { AuthUser } from "../src/auth.js";

const authUser: AuthUser = {
  userId: "user-1",
  orgId: "org-1",
  tenantIds: [],
  role: "user",
  authMethod: "pat",
  tokenScopes: ["coder"],
  authKeyId: "key-1",
  authKeyPrefix: "syn-test",
};

function createMcpRouteHarness() {
  const app = Fastify();
  (app as unknown as { rateLimit: () => unknown }).rateLimit = () => async () => undefined;
  const authResolver = {
    resolve: vi.fn(async () => authUser),
    requireCoderScope: vi.fn(),
  };
  return { app, authResolver };
}

describe("Yarn MCP route argument validation", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("rejects unknown direct MCP tool-call body fields before dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const { app, authResolver } = createMcpRouteHarness();
    apps.push(app);
    await registerMcpRoutes(app, {
      authResolver: authResolver as never,
      enabled: true,
      openClawProfileEnabled: false,
      openClawMcpAllowlistEnabled: false,
      openClawStrictGovernanceEnabled: false,
      toolMaxConcurrentPerCaller: 4,
      toolMaxConcurrentGlobal: 100,
      synesisMcpDeps: {
        plannerBaseUrl: "http://planner.test:8080",
        internalServiceToken: "svc",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/tools/call",
      headers: { authorization: "Bearer syn-test" },
      payload: {
        name: "synesis_search",
        arguments: { query: "kubernetes" },
        role_override: "admin",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "unknown_tool_call_field",
        message: "Tool call body contains an unknown field",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-object Synesis platform tool arguments before dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const { app, authResolver } = createMcpRouteHarness();
    apps.push(app);
    await registerMcpRoutes(app, {
      authResolver: authResolver as never,
      enabled: true,
      openClawProfileEnabled: false,
      openClawMcpAllowlistEnabled: false,
      openClawStrictGovernanceEnabled: false,
      toolMaxConcurrentPerCaller: 4,
      toolMaxConcurrentGlobal: 100,
      synesisMcpDeps: {
        plannerBaseUrl: "http://planner.test:8080",
        internalServiceToken: "svc",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/tools/call",
      headers: { authorization: "Bearer syn-test" },
      payload: {
        name: "synesis_search",
        arguments: "query=kubernetes",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_tool_arguments",
        message: "Tool arguments must be an object",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects caller-controlled platform attribution fields before dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const { app, authResolver } = createMcpRouteHarness();
    apps.push(app);
    await registerMcpRoutes(app, {
      authResolver: authResolver as never,
      enabled: true,
      openClawProfileEnabled: false,
      openClawMcpAllowlistEnabled: false,
      openClawStrictGovernanceEnabled: false,
      toolMaxConcurrentPerCaller: 4,
      toolMaxConcurrentGlobal: 100,
      synesisMcpDeps: {
        plannerBaseUrl: "http://planner.test:8080",
        internalServiceToken: "svc",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/tools/call",
      headers: { authorization: "Bearer syn-test" },
      payload: {
        name: "synesis_web_search",
        arguments: {
          query: "kubernetes",
          source_surface: "external_api",
          request_id: "attacker-req",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "validation_error",
        message: "Invalid tool arguments",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-object project-bound tool arguments before handler execution", async () => {
    const { app, authResolver } = createMcpRouteHarness();
    apps.push(app);
    await registerMcpRoutes(app, {
      authResolver: authResolver as never,
      enabled: true,
      openClawProfileEnabled: false,
      openClawMcpAllowlistEnabled: false,
      openClawStrictGovernanceEnabled: false,
      toolMaxConcurrentPerCaller: 4,
      toolMaxConcurrentGlobal: 100,
      synesisMcpDeps: {
        plannerBaseUrl: "http://planner.test:8080",
        internalServiceToken: "svc",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/tools/call",
      headers: {
        authorization: "Bearer syn-test",
        "x-synesis-project-root": "/tmp/synesis-route-test",
      },
      payload: {
        name: "read_file",
        arguments: "filePath=README.md",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_tool_arguments",
        message: "Tool arguments must be an object",
      },
    });
  });
});
