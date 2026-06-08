import { describe, expect, it, vi } from "vitest";
import { registerPreferenceRoutes } from "../src/routes/preference-routes.js";
import type { PlatformRouteDependencies } from "../src/routes/platform-route-support.js";

describe("preference routes", () => {
  it("rejects unknown runtime preference update fields", async () => {
    const { routes, deps } = createPreferenceRouteHarness();
    registerPreferenceRoutes(deps);

    const reply = createReplyProbe();
    const response = await routes.put.get("/v1/user-runtime-preferences/:userId")?.({
      headers: {},
      params: { userId: "u1" },
      query: { org_id: "org1" },
      body: {
        loopBreakMode: "assertive",
        role_override: "admin",
      },
    }, reply);

    expect(reply.statusCode).toBe(400);
    expect(response).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(deps.sessionStore.saveUserRuntimePreferences).not.toHaveBeenCalled();
  });

  it("rejects client-controlled runtime preference timestamps", async () => {
    const { routes, deps } = createPreferenceRouteHarness();
    registerPreferenceRoutes(deps);

    const reply = createReplyProbe();
    await routes.put.get("/v1/user-runtime-preferences/:userId")?.({
      headers: {},
      params: { userId: "u1" },
      query: { org_id: "org1" },
      body: {
        loopBreakMode: "assertive",
        updatedAt: 123,
      },
    }, reply);

    expect(reply.statusCode).toBe(400);
    expect(deps.sessionStore.saveUserRuntimePreferences).not.toHaveBeenCalled();
  });

  it("requires explicit org scope for runtime preference updates", async () => {
    const { routes, deps } = createPreferenceRouteHarness();
    registerPreferenceRoutes(deps);

    const reply = createReplyProbe();
    const response = await routes.put.get("/v1/user-runtime-preferences/:userId")?.({
      headers: {},
      params: { userId: "u1" },
      query: {},
      body: {
        loopBreakMode: "assertive",
      },
    }, reply);

    expect(reply.statusCode).toBe(400);
    expect(response).toMatchObject({ error: { type: "invalid_request_error", message: "org_id is required" } });
    expect(deps.sessionStore.saveUserRuntimePreferences).not.toHaveBeenCalled();
  });

  it("loads runtime preferences with explicit org scope", async () => {
    const { routes, deps } = createPreferenceRouteHarness();
    vi.mocked(deps.loadUserRuntimePreferences).mockResolvedValue({
      loopBreakMode: "standard",
      cachePolicyBias: "auto",
      synesisMemoryMode: "adaptive",
      allowAggressiveCompactionWithoutCacheHits: true,
      maxToolLoopSoftFails: null,
      updatedAt: 1,
    });
    registerPreferenceRoutes(deps);

    const reply = createReplyProbe();
    await routes.get.get("/v1/user-runtime-preferences/:userId")?.({
      headers: {},
      params: { userId: "u1" },
      query: { org_id: "org1" },
    }, reply);

    expect(reply.statusCode).toBe(200);
    expect(deps.loadUserRuntimePreferences).toHaveBeenCalledWith("org1", "u1");
  });

  it("saves validated runtime preferences with server-derived timestamp", async () => {
    const { routes, deps } = createPreferenceRouteHarness();
    registerPreferenceRoutes(deps);

    const before = Date.now();
    const reply = createReplyProbe();
    await routes.put.get("/v1/user-runtime-preferences/:userId")?.({
      headers: {},
      params: { userId: "u1" },
      query: { org_id: "org1" },
      body: {
        loop_break_mode: "assertive",
        cache_policy_bias: "balanced",
        synesis_memory_mode: "safe",
        allow_aggressive_compaction_without_cache_hits: false,
        max_tool_loop_soft_fails: 4,
      },
    }, reply);

    expect(reply.statusCode).toBe(200);
    expect(deps.sessionStore.saveUserRuntimePreferences).toHaveBeenCalledTimes(1);
    const [orgId, userId, preferences, ttlMs] = vi.mocked(deps.sessionStore.saveUserRuntimePreferences).mock.calls[0]!;
    expect(orgId).toBe("org1");
    expect(userId).toBe("u1");
    expect(ttlMs).toBe(60000);
    expect(preferences).toMatchObject({
      loopBreakMode: "assertive",
      cachePolicyBias: "balanced",
      synesisMemoryMode: "safe",
      allowAggressiveCompactionWithoutCacheHits: false,
      maxToolLoopSoftFails: 4,
    });
    expect(preferences.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

interface ReplyProbe {
  statusCode: number;
  body: unknown;
  code(statusCode: number): ReplyProbe;
  send(body: unknown): unknown;
}

function createReplyProbe(): ReplyProbe {
  return {
    statusCode: 200,
    body: undefined,
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return body;
    },
  };
}

function createPreferenceRouteHarness(): {
  routes: {
    get: Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>;
    put: Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>;
  };
  deps: PlatformRouteDependencies;
} {
  const routes = {
    get: new Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>(),
    put: new Map<string, (req: unknown, reply: ReplyProbe) => Promise<unknown>>(),
  };
  const app = {
    get: vi.fn((path: string, handler: (req: unknown, reply: ReplyProbe) => Promise<unknown>) => {
      routes.get.set(path, handler);
    }),
    put: vi.fn((path: string, handler: (req: unknown, reply: ReplyProbe) => Promise<unknown>) => {
      routes.put.set(path, handler);
    }),
    log: { warn: vi.fn() },
  };
  const deps = {
    app,
    config: { SYNESIS_YARN_USER_RUNTIME_PREFERENCES_TTL_MS: 60000 },
    requireInternalToken: vi.fn(() => true),
    sessionStore: {
      saveUserRuntimePreferences: vi.fn().mockResolvedValue(undefined),
    },
    loadUserRuntimePreferences: vi.fn(),
    formatValidationError: (error: { issues?: Array<{ path?: PropertyKey[]; message?: string }>; message: string }) =>
      error.issues?.map((issue) => `${issue.path?.join(".")}: ${issue.message}`).join("; ") || error.message,
  } as unknown as PlatformRouteDependencies;
  return { routes, deps };
}
