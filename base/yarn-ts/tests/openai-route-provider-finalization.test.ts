import { describe, expect, it, vi } from "vitest";
import { finalizeOpenAIProviderRequest } from "../src/pipeline/openai-route-provider-finalization.js";
import type { CachePolicyControllerDecision } from "../src/telemetry/cache-policy-controller.js";
import { OptimizationLedger } from "../src/telemetry/optimization-ledger.js";

function cachePolicy(overrides: Partial<CachePolicyControllerDecision> = {}): CachePolicyControllerDecision {
  return {
    enabled: true,
    action: "observe",
    compactionMode: "minimal",
    allowExplicitCacheMarkers: true,
    cacheUnavailable: false,
    retryLoopRisk: false,
    premiumCacheWriteSuppressed: false,
    provider: "test",
    providerCacheStrategy: "implicit",
    state: {
      cacheMissStreak: 0,
      cacheHitStreak: 0,
      premiumWriteWithoutReadStreak: 0,
      telemetryMissingStreak: 0,
      lastCacheOutcome: "unknown",
      lastRecommendation: "unknown",
      lastProviderCacheStrategy: "unknown",
    },
    providerWindow: null,
    reasons: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof finalizeOpenAIProviderRequest>[0]> = {}) {
  const policy = cachePolicy();
  return {
    request: {
      model: "requested",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: false,
    } as never,
    selectedModel: "selected",
    enrichedMessages: [{ role: "user", content: "hello" }],
    toolResultCount: 2,
    session: {
      history: [],
      toolCallsSinceCheckpoint: 0,
    },
    sessionKey: "session_1",
    requestId: "req_1",
    identity: {
      userId: "user_1",
      orgId: "org_1",
      clientKind: "opencode",
    },
    pathContext: {
      projectRoot: null,
      shellCwd: null,
    },
    governanceDisabled: false,
    volatileSystemBlocks: ["volatile evidence"],
    policyPivotPrompt: "pivot",
    latestUserContent: "hello",
    runtimePreferences: null,
    configuredCompactionMode: "minimal" as const,
    defaultTier: "default-tier",
    prefixHash: "prefix-hash",
    prefixChangeReasons: ["tools_changed"],
    prefixOptimizer: null,
    optimizationLedger: new OptimizationLedger(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    injectSessionContext: vi.fn((messages) => [...messages, { role: "system", content: "session" }]),
    injectArtifactTool: vi.fn((tools) => [...tools, { type: "function", function: { name: "artifact" } }]),
    injectKnowledgeTool: vi.fn((tools) => tools),
    injectWebSearchTool: vi.fn((tools) => tools),
    getTierConfig: vi.fn((modelId: string) => ({ baseUrl: `https://${modelId}.example.test` })),
    resolveEndpointCapabilityId: vi.fn(() => "test-provider"),
    loadProviderCachePolicyWindow: vi.fn(async () => null),
    evaluateCachePolicy: vi.fn(() => policy),
    markerBackendForRequest: vi.fn(() => "none" as const),
    setCurrentRequestContext: vi.fn(),
    setWorkspaceContext: vi.fn(),
    recordSessionEvent: vi.fn(),
    runOpenAIRequest: vi.fn((request) => ({ ok: true, request })),
    ...overrides,
  };
}

describe("finalizeOpenAIProviderRequest", () => {
  it("builds normalized provider request, session history, cache policy, and resolve result", async () => {
    const input = baseInput();

    const result = await finalizeOpenAIProviderRequest(input);

    expect(result.normalizedRequest.model).toBe("selected");
    expect(result.normalizedRequest.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "system", content: "session" },
      { role: "system", content: "volatile evidence" },
    ]);
    expect(result.normalizedRequest.tools).toContainEqual({ type: "function", function: { name: "artifact" } });
    expect(input.session).toMatchObject({
      toolCallsSinceCheckpoint: 2,
      history: [
        { role: "system", content: "pivot" },
        { role: "user", content: "hello" },
      ],
    });
    expect(input.loadProviderCachePolicyWindow).toHaveBeenCalledWith("org_1", "test-provider", "opencode");
    expect(input.evaluateCachePolicy).toHaveBeenCalledWith(
      input.session,
      "test-provider",
      "minimal",
      null,
      null,
    );
    expect(input.setCurrentRequestContext).toHaveBeenCalledWith({
      sessionKey: "session_1",
      requestId: "req_1",
      clientKind: "opencode",
    });
    expect(input.runOpenAIRequest).toHaveBeenCalledWith(result.normalizedRequest);
    expect(result.resolveResult).toEqual({ ok: true, request: result.normalizedRequest });
    expect(input.optimizationLedger.finalize().cacheDiagnostics).toMatchObject({
      policyAction: "observe",
      policyProvider: "test-provider",
      prefixHash: "prefix-hash",
      prefixChangeReasons: ["tools_changed"],
    });
  });

  it("records cache policy events and prefix optimizer metadata backfill", async () => {
    const optimizedMessages = [{ role: "system", content: "optimized" }];
    const input = baseInput({
      evaluateCachePolicy: vi.fn(() => cachePolicy({
        action: "preserve_cache",
        reasons: ["miss_streak"],
      })),
      prefixOptimizer: {
        optimize: vi.fn(() => ({
          messages: optimizedMessages,
          tools: [{ type: "function", function: { name: "optimized_tool" } }],
          markerIndices: [],
          diagnostics: { prefixStableBytes: 123 },
          clientMetadata: {
            projectRoot: "/repo",
            shellCwd: "/repo/app",
            shell: "zsh",
            platform: "darwin",
            osVersion: "arm64",
          },
        })),
      } as never,
    });

    const result = await finalizeOpenAIProviderRequest(input);

    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "cache_policy_controller_decision_v1",
      "cache-policy-controller",
      "action=preserve_cache compaction=minimal provider=test-provider",
      "req_1",
      expect.objectContaining({ action: "preserve_cache" }),
    );
    expect(input.markerBackendForRequest).toHaveBeenCalledWith(
      "selected",
      "default-tier",
      "session_1",
      expect.objectContaining({ action: "preserve_cache" }),
    );
    expect(result.normalizedRequest.messages).toBe(optimizedMessages);
    expect(result.pathContext).toMatchObject({
      projectRoot: "/repo",
      shellCwd: "/repo/app",
      shell: "zsh",
      platform: "darwin",
      osVersion: "arm64",
    });
    expect(input.setWorkspaceContext).toHaveBeenCalledWith(
      input.session,
      "ready",
      "req_1",
      expect.objectContaining({
        reason: "Extracted from client system message",
        projectRoot: "/repo",
        cwd: "/repo/app",
      }),
    );
    expect(input.optimizationLedger.finalize()).toMatchObject({
      prefixStableBytes: 123,
    });
  });
});
