import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerClaudeCompatRoutes } from "../src/routes/claude-compat-routes.js";
import { registerModelRoutes } from "../src/routes/model-routes.js";
import type { PlatformRouteDependencies } from "../src/routes/platform-route-support.js";

function makeDeps(overrides: Partial<PlatformRouteDependencies> = {}): PlatformRouteDependencies {
  const app = Fastify();
  const authUser = {
    userId: "user-1",
    orgId: "org-1",
    tenantIds: [],
    role: "user",
    authMethod: "pat" as const,
    tokenScopes: ["model:readonly"],
  };
  return {
    app,
    config: {} as never,
    authResolver: {
      resolve: vi.fn(async () => authUser),
      requireCoderScope: vi.fn(),
      requireModelReadScope: vi.fn(),
      getPoolStats: vi.fn(() => ({ totalCount: 0, idleCount: 0, waitingCount: 0 })),
    },
    fgaCheck: vi.fn(async () => ({ allowed: true })),
    userRateLimiter: { check: vi.fn(async () => ({ allowed: true })) },
    requireInternalToken: vi.fn(() => false),
    promRegistry: {} as never,
    usagePersistenceEnabled: false,
    usageWriter: { getStats: vi.fn(() => ({})) },
    sessionStore: {} as never,
    sessions: [],
    validationNormalization: { getStats: vi.fn(() => ({})) },
    toolResultReduction: { getStats: vi.fn(() => ({})), getPolicyStats: vi.fn(() => ({})) },
    transcriptPruning: { getStats: vi.fn(() => ({})) },
    contentDedupBySession: new Map(),
    toolArgHardeningStats: {},
    toolSchemaPruningStats: {},
    toolBlobRedisEnabled: false,
    openClawProfileStats: {},
    contextAdmissionStats: {},
    workingFrameService: { getStats: vi.fn(() => ({})) },
    projectManifestService: { getStats: vi.fn(() => ({})) },
    policyEngine: { getStats: vi.fn(() => ({})) },
    governanceClient: null,
    phaseOrchestrator: { getStats: vi.fn(() => ({})) },
    clientAdapterPacks: {
      getStats: vi.fn(() => ({})),
      getCatalog: vi.fn(() => ({ packs: ["opencode"] })),
    },
    stablePrefixService: { getStats: vi.fn(() => ({})) },
    yarnToolPrefixCache: null,
    artifactRetrieval: { getStats: vi.fn(() => ({})) },
    knowledgeSearch: { getStats: vi.fn(() => ({})) },
    getEvidencePrefetchStats: vi.fn(() => ({})),
    getPatternPrefetchStats: vi.fn(() => ({})),
    tierRegistry: {
      getAvailableModels: vi.fn(() => [{ id: "synesis-core", object: "model" }]),
    } as never,
    diagnosticRegistry: {} as never,
    artifactStore: {} as never,
    loadUserRuntimePreferences: vi.fn(),
    getSessionKey: vi.fn(),
    getSessionState: vi.fn(),
    forceCheckpoint: vi.fn(),
    casSessionSave: vi.fn(),
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
}

describe("model and catalog routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("keeps /v1 public while requiring auth for /v1/models", async () => {
    const deps = makeDeps();
    apps.push(deps.app);
    registerModelRoutes(deps);

    const discovery = await deps.app.inject({ method: "GET", url: "/v1" });
    expect(discovery.statusCode).toBe(200);

    vi.mocked(deps.authResolver.resolve).mockRejectedValueOnce(new Error("missing bearer"));
    const unauthorized = await deps.app.inject({ method: "GET", url: "/v1/models" });
    expect(unauthorized.statusCode).toBe(401);
    expect(JSON.parse(unauthorized.body)).toMatchObject({
      error: { type: "auth_error", message: "Authentication required" },
    });

    const authorized = await deps.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer syn-test" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(JSON.parse(authorized.body)).toMatchObject({
      object: "list",
      data: [{ id: "synesis-core" }],
    });
    expect(deps.authResolver.requireModelReadScope).toHaveBeenCalledTimes(1);
  });

  it("requires model catalog auth for model detail lookups", async () => {
    const deps = makeDeps();
    apps.push(deps.app);
    registerModelRoutes(deps);

    const response = await deps.app.inject({
      method: "GET",
      url: "/v1/models/synesis-core",
      headers: { authorization: "Bearer syn-test" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: "synesis-core" });
    expect(deps.authResolver.requireModelReadScope).toHaveBeenCalledTimes(1);
  });

  it("requires model catalog auth for adapter-pack catalog", async () => {
    const deps = makeDeps();
    apps.push(deps.app);
    registerClaudeCompatRoutes(deps);

    const response = await deps.app.inject({
      method: "GET",
      url: "/v1/adapter-packs",
      headers: { authorization: "Bearer syn-test" },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ catalog: { packs: ["opencode"] } });
    expect(deps.authResolver.requireModelReadScope).toHaveBeenCalledTimes(1);
  });
});
