import { describe, expect, it, vi } from "vitest";

vi.mock("../src/pipeline/openai-route-provider-finalization.js", () => ({
  finalizeOpenAIProviderRequestForRoute: vi.fn(),
}));

vi.mock("../src/pipeline/openai-chat-provider-preparation.js", () => ({
  prepareOpenAIChatProviderRuntime: vi.fn(),
}));

import { prepareOpenAIChatProviderRuntime } from "../src/pipeline/openai-chat-provider-preparation.js";
import { prepareOpenAIProviderRuntimeForRoute } from "../src/pipeline/openai-provider-runtime-preparation.js";
import { finalizeOpenAIProviderRequestForRoute } from "../src/pipeline/openai-route-provider-finalization.js";
import { mergeSessionPathHints } from "../src/state/workspace-session-boundary.js";

function deps() {
  return {
    adapterUsesToolLoopSteering: vi.fn(() => false),
    app: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    applyEditContextMissReadGate: vi.fn(),
    applyMarkdownGuardrail: vi.fn(),
    artifactRetrieval: { injectToolOpenAI: vi.fn((tools) => tools) },
    artifactStore: {},
    buildDefaultPolicy: vi.fn(),
    buildEditContextMissForcedReadPrompt: vi.fn(),
    buildEditContextMissGuardPrompt: vi.fn(),
    buildEvidenceTraceSummary: vi.fn(),
    buildStateRegroundReadPrompt: vi.fn(),
    config: {
      SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED: false,
      SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: false,
      SYNESIS_YARN_WEB_SEARCH_ENABLED: false,
      SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE: "minimal",
      SYNESIS_YARN_DEFAULT_TIER: "default",
      SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE: 0,
      SYNESIS_YARN_GOVERNANCE_DISABLED: false,
    },
    contextAdmissionStats: {},
    deserializeShadow: vi.fn(),
    ensureReadToolAvailabilityForEditMissGuard: vi.fn(),
    evaluateCachePolicyForSession: vi.fn(),
    finalizeCompletionText: vi.fn((text) => text),
    findPreferredReadToolName: vi.fn(),
    forceCheckpoint: vi.fn(),
    formatEvidenceBlock: vi.fn(() => null),
    formatPatternBlock: vi.fn(() => null),
    getMetadataString: vi.fn(() => null),
    inferVerificationSteps: vi.fn(),
    injectSessionContext: vi.fn((messages) => messages),
    isOpenClawProfile: vi.fn(() => false),
    isWriteCapableToolName: vi.fn(() => false),
    knowledgeSearch: { injectToolOpenAI: vi.fn((tools) => tools) },
    loadProviderCachePolicyWindow: vi.fn(),
    markerBackendForRequest: vi.fn(() => "none"),
    mergeSessionPathHints,
    prefixOptimizer: null,
    pushDiagnostic: vi.fn(),
    recordSessionEvent: vi.fn(),
    recordUpperHarnessDecision: vi.fn(),
    resolveEndpointCapabilityId: vi.fn(() => "test-provider"),
    runOpenAIRequest: vi.fn(),
    sessionPersistenceRunner: { persistAndEmitDecisionTelemetry: vi.fn() },
    setSessionWorkspaceContext: vi.fn(),
    shouldRestrictDiscoveryForPlanWork: vi.fn(() => false),
    shouldSampleBySeed: vi.fn(() => false),
    tierRegistry: { setCurrentRequestContext: vi.fn(), getTierConfig: vi.fn() },
    toolArgHardeningStats: {},
    transcriptPruning: {},
    webSearch: { injectToolOpenAI: vi.fn((tools) => tools) },
  };
}

function normalizedRequestContext() {
  return {
    clientToolCapabilities: {},
    clientTaskCue: "build",
    clientKind: "opencode",
    orchestration: {},
    adapterProfile: {},
    openClawStrictGovernance: false,
    phasePolicyEnabledByMatrix: false,
    governorPhase: "edit",
    executionGovernor: { matchedRules: [] },
    editMissGuard: null,
    needsStateReground: false,
    stateConfidence: {},
    clientToolInventory: [],
    workspaceInspection: null,
    latestReadRefresh: {},
    promptIntake: {},
    sensemakingDecision: null,
    chatState: null,
    fileState: null,
    compactionOptions: {},
    reductions: {
      toolResultReduction: null,
      validationNormalization: null,
    },
    reducedToolResults: 0,
    evidencePrefetched: false,
    sensemakingResult: null,
    governorSummaries: {},
    trajectoryDiagnostics: null,
    requirementChecklist: null,
    verificationAssessment: null,
    planGraph: null,
    artifactShadows: null,
  };
}

describe("prepareOpenAIProviderRuntimeForRoute", () => {
  it("reuses workspace context stored by the handshake when finalization drops path hints", async () => {
    const finalizeMock = vi.mocked(finalizeOpenAIProviderRequestForRoute);
    const prepareMock = vi.mocked(prepareOpenAIChatProviderRuntime);
    const session = {
      record: {
        metadata: {
          workspace_context_project_root: "/home/byron/src/test",
          workspace_context_cwd: "/home/byron/src/test",
          workspace_context_shell: "/bin/bash",
          workspace_context_os: "Linux",
          workspace_context_arch: "x86_64",
        },
        requestCount: 1,
      },
      history: [],
      toolCallsSinceCheckpoint: 0,
    };

    finalizeMock.mockResolvedValueOnce({
      ok: true,
      normalizedRequest: { model: "deepseek-v4-pro", messages: [] },
      pathContext: { projectRoot: null, shellCwd: null },
      cachePolicy: { action: "observe" },
      resolveResult: {
        ok: true,
        resolved: { resolvedModelId: "deepseek-v4-pro" },
        messages: [],
        transforms: { systemMessagesReordered: false, toolCallsSanitized: false, messageCountDelta: 0 },
      },
      routePersistence: {},
    } as never);
    prepareMock.mockReturnValueOnce({
      ok: true,
      adapter: {},
      upperHarness: null,
      effectiveTools: [],
      sdkTools: {},
      effectiveToolChoice: undefined,
      providerOptions: {},
      structuredOutput: null,
      samplingOptions: {},
      phasePolicy: {},
      forensicsPhasePolicy: {},
      toolHandlingRouteBase: {},
      finalizerRouteBase: {},
      telemetryRouteBase: {},
      persistDecisionTelemetry: vi.fn(),
    } as never);

    const result = await prepareOpenAIProviderRuntimeForRoute({
      deps: deps() as never,
      request: { model: "deepseek-v4-pro", messages: [] },
      headers: {},
      normalizedOpenAI: { messages: [] },
      enrichedMessages: [],
      toolResultCount: 0,
      session: session as never,
      sessionKey: "session_1",
      requestId: "req_1",
      identity: { userId: "user_1", orgId: "org_1", clientKind: "opencode" },
      pathContext: { projectRoot: null, shellCwd: null },
      selectedModel: "deepseek-v4-pro",
      prefetchResult: null,
      patternResult: null,
      sensemakingBlock: null,
      policyPrecheck: { matchedRules: [] },
      latestUserText: undefined,
      runtimePreferences: null,
      enriched: {},
      normalizedRequestContext: normalizedRequestContext() as never,
      optimizationLedger: { recordCacheDiagnostics: vi.fn() },
    });

    expect(finalizeMock.mock.calls[0]?.[0]).toMatchObject({
      pathContext: {
        projectRoot: "/home/byron/src/test",
        shellCwd: "/home/byron/src/test",
      },
    });
    expect(prepareMock.mock.calls[0]?.[0]).toMatchObject({
      effectivePathContext: {
        projectRoot: "/home/byron/src/test",
        shellCwd: "/home/byron/src/test",
        shell: "/bin/bash",
        platform: "Linux",
        osVersion: "x86_64",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      pathContext: {
        projectRoot: "/home/byron/src/test",
        shellCwd: "/home/byron/src/test",
      },
    });
  });
});
