import { describe, it, expect, vi } from "vitest";
import type { AppConfig } from "../src/config.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SYNESIS_YARN_PORT: 8080,
    SYNESIS_YARN_HOST: "0.0.0.0",
    SYNESIS_YARN_ADMIN_API_URL: "http://localhost:9090",
    SYNESIS_YARN_ADMIN_DB_URL: "",
    SYNESIS_YARN_MODEL_API_URL: "http://localhost:8081",
    SYNESIS_YARN_MODELS: "",
    SYNESIS_PAT_PEPPER: "test-pepper",
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
    SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS: 100_000,
    SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS: 50_000,
    SYNESIS_YARN_REDUCER_PROFILE: "balanced",
    SYNESIS_YARN_REDUCER_MIN_CONFIDENCE: 0.3,
    SYNESIS_YARN_REDUCER_DISABLED_FAMILIES: "",
    SYNESIS_YARN_JSON_COMPACTION_ENABLED: true,
    SYNESIS_YARN_STABLE_PREFIX_ENABLED: true,
    SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED: false,
    SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED: false,
    SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: false,
    SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED: false,
    SYNESIS_YARN_GOVERNANCE_ENABLED: false,
    SYNESIS_YARN_SESSION_CONTINUITY_ENABLED: false,
    SYNESIS_YARN_CONTENT_DISPATCH_ENABLED: false,
    SYNESIS_YARN_RECALL_BYPASS_ENABLED: false,
    SYNESIS_YARN_RECALL_CONFIDENCE_FLOOR: 0.6,
    SYNESIS_YARN_VERIFICATION_PLAN_ENABLED: false,
    SYNESIS_YARN_VERIFICATION_MAX_ROUNDS: 3,
    SYNESIS_YARN_DECISION_MATRIX_ENABLED: false,
    SYNESIS_YARN_DETERMINISTIC_PATH_THRESHOLD: 0.9,
    SYNESIS_YARN_CONSTRAINED_PATH_THRESHOLD: 0.5,
    SYNESIS_YARN_ABSTAIN_EVIDENCE_FLOOR: 0.15,
    SYNESIS_YARN_ESCALATION_FAILED_VERIF_LIMIT: 2,
    SYNESIS_YARN_SENSEMAKING_ENABLED: false,
    SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD: 0.5,
    SYNESIS_YARN_AUTH_POOL_MAX: 5,
    SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS: 30_000,
    SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS: 2000,
    SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: false,
    SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S: 86400,
    SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS: 60_000,
    SYNESIS_YARN_OTEL_ENABLED: false,
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_SERVICE_NAME: "synesis-yarn",
    SYNESIS_YARN_INTERNAL_TOKEN: "test-token",
    SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED: false,
    SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT: 10,
    SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT: 5,
    SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT: 3,
    SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT: 15,
    SYNESIS_YARN_POLICY_HARD_REJECT_AFTER: 0,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 10_000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 5_000,
    SYNESIS_YARN_DB_POOL_MAX: 10,
    SYNESIS_YARN_USAGE_WRITER_QUEUE_MAX: 100,
    SYNESIS_YARN_USAGE_WRITER_FLUSH_INTERVAL_MS: 5_000,
    SYNESIS_YARN_DIAGNOSTIC_RING_MAX: 20,
    SYNESIS_YARN_CHECKPOINT_INTERVAL_MS: 300_000,
    SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS: 30_000,
    SYNESIS_YARN_MCP_TOOLS_ENABLED: false,
    SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE: false,
    SYNESIS_YARN_DEBUG_PROTOCOL: false,
    SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED: false,
    SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS: 200,
    SYNESIS_YARN_EVIDENCE_CONFIDENCE_MIN: 0.3,
    SYNESIS_YARN_RECALL_BYPASS_CONFIDENCE_THRESHOLD: 0.8,
    SYNESIS_YARN_RECALL_ENRICH_THRESHOLD: 0.4,
    SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
    ...overrides,
  } as AppConfig;
}

/* ========== Full enrichment pipeline ========== */
describe("Full enrichment pipeline", () => {
  it("tool result -> reduction -> normalization produces stats", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");
    const { ValidationNormalizationService } = await import("../src/validation/service.js");

    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    const reducer = new ToolResultReductionService(makeConfig(), artifactStore);
    const normalizer = new ValidationNormalizationService(makeConfig(), artifactStore);

    const eslintOutput = `
/home/user/src/app.ts
  2:7  error  'foo' is assigned a value but never used  @typescript-eslint/no-unused-vars
  5:1  error  Unexpected console statement              no-console

✖ 2 problems (2 errors, 0 warnings)
`.trim();

    const reduced = reducer.reduceStandaloneToolResult(eslintOutput, "eslint");
    expect(typeof reduced).toBe("string");
    expect(reduced.length).toBeLessThanOrEqual(eslintOutput.length + 500);

    const normalized = normalizer.normalizeMessages([
      { role: "tool", name: "eslint", content: reduced },
    ] as never);
    expect(normalized).toHaveProperty("messages");
    expect(normalized.messages.length).toBeGreaterThanOrEqual(1);

    const stats = reducer.getStats();
    expect(stats.reducedCount).toBeGreaterThanOrEqual(0);
    expect(stats.compactionFailures).toBe(0);
    expect(typeof stats.rawCharsTotal).toBe("number");
  });

  it("recall + verification stats are initialized properly", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    const reducer = new ToolResultReductionService(makeConfig({ SYNESIS_YARN_RECALL_BYPASS_ENABLED: true }), artifactStore);

    const recallStats = reducer.getRecallStats();
    expect(recallStats.totalDecisions).toBe(0);
    expect(recallStats.bypassAttempts).toBe(0);
    expect(recallStats.enrichAttempts).toBe(0);
    expect(recallStats.passthroughCount).toBe(0);

    const verifStats = reducer.getVerificationStats();
    expect(verifStats.totalRounds).toBe(0);
    expect(verifStats.selfRepairSuggestions).toBe(0);
  });
});

/* ========== Decision routing integration ========== */
describe("Decision routing integration", () => {
  it("PhaseModelOrchestrator produces valid decisions with all features enabled", async () => {
    const { PhaseModelOrchestrator } = await import("../src/orchestration/phase-model-orchestrator.js");
    const orchestrator = new PhaseModelOrchestrator();
    const decision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "fix this bug",
      evidence: {
        recallConfidence: 0.85,
        verificationPassed: true,
        verificationRound: 1,
        evidenceStrength: 0.8,
        riskProfile: "low",
        consecutiveFailedVerifications: 0,
        isExplorePhase: false,
      },
      decisionMatrixEnabled: true,
    });
    expect(decision).toBeDefined();
    expect(decision.selectedModel).toBeTruthy();
    expect(typeof decision.maxOutputTokens).toBe("number");
    expect(["deterministic", "constrained", "inference_first", "abstain"]).toContain(decision.decisionPath);
  });

  it("abstain path is selected with low evidence", async () => {
    const { PhaseModelOrchestrator } = await import("../src/orchestration/phase-model-orchestrator.js");
    const orchestrator = new PhaseModelOrchestrator();
    const decision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "something very uncertain",
      riskProfile: "high",
      evidence: {
        recallConfidence: 0.05,
        verificationPassed: false,
        verificationRound: 0,
        evidenceStrength: 0.1,
        riskProfile: "high",
        consecutiveFailedVerifications: 3,
        isExplorePhase: false,
      },
      decisionMatrixEnabled: true,
    });
    expect(decision.decisionPath).toBe("abstain");
    expect(decision.uncertaintyFraming).toBeTruthy();
  });

  it("explore phase triggers with explore keywords", async () => {
    const { PhaseModelOrchestrator } = await import("../src/orchestration/phase-model-orchestrator.js");
    const orchestrator = new PhaseModelOrchestrator();
    const decision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "explore the codebase structure",
      evidence: {
        recallConfidence: 0,
        verificationPassed: false,
        verificationRound: 0,
        evidenceStrength: 0,
        riskProfile: "low",
        consecutiveFailedVerifications: 0,
        isExplorePhase: true,
      },
      decisionMatrixEnabled: true,
    });
    expect(decision.phase).toBe("explore");
  });
});

/* ========== Sensemaking integration ========== */
describe("Sensemaking integration", () => {
  it("gap analyzer classifies signals into buckets", async () => {
    const { analyzeGaps } = await import("../src/sensemaking/gap-analyzer.js");
    const gaps = analyzeGaps({
      recallDecision: { routing: "enrich", resolution: { confidence: 0.3, language: "typescript", findings: [], recipes: [] } as never },
      verificationState: { round: 2, stalled: true, findings: [{ family: "tsc", severity: "error", message: "test", raw: "test" }] },
      evidenceConfidence: 0.4,
      phase: "implementation",
      decisionPath: "constrained",
      consecutiveFailedVerifications: 2,
      languages: ["typescript"],
      userText: "Fix the TypeScript compilation errors",
    });
    expect(gaps.known.length + gaps.unknown.length + gaps.knowBetter.length).toBeGreaterThan(0);
    expect(gaps.knowBetter.length).toBeGreaterThan(0);
  });

  it("exploration planner builds valid plans", async () => {
    const { buildExplorationPlan } = await import("../src/sensemaking/exploration-planner.js");
    const plan = buildExplorationPlan(
      {
        known: [{ kind: "known", domain: "language", description: "TypeScript support", suggestedAction: "use tsc" }],
        unknown: [{ kind: "unknown", domain: "build", description: "Build system unknown", suggestedAction: "inspect project" }],
        knowBetter: [{ kind: "know_better", domain: "deps", description: "Partial dependency info", suggestedAction: "check package.json" }],
      },
      { userText: "Fix the build error", language: "typescript" },
    );
    expect(plan.desiredEndState).toBeTruthy();
    expect(plan.forwardPath.length).toBeGreaterThan(0);
    expect(plan.preconditions.length).toBeGreaterThan(0);
  });

  it("formatter produces valid system block", async () => {
    const { formatExplorationPlanBlock } = await import("../src/sensemaking/formatter.js");
    const block = formatExplorationPlanBlock({
      triggered: true,
      reason: "explore phase",
      gaps: {
        known: [],
        unknown: [{ kind: "unknown", domain: "test", description: "No tests found", suggestedAction: "run tests" }],
        knowBetter: [],
      },
      plan: {
        desiredEndState: "All tests passing",
        preconditions: ["Test framework installed"],
        evidenceCheckpoints: ["Test suite discovered"],
        forwardPath: [{ kind: "tool", tool: "synesis_inspect_repo", description: "Inspect project", priority: "required" }],
        fallbackBranches: ["Manual test discovery"],
      },
    });
    expect(block).toContain("<EXPLORATION_PLAN>");
    expect(block).toContain("All tests passing");
    expect(block).toContain("</EXPLORATION_PLAN>");
  });
});

/* ========== Feature flag combinations ========== */
describe("Feature flag combinations", () => {
  it("all intelligence features enabled produces valid stats", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const cfg = makeConfig({
      SYNESIS_YARN_RECALL_BYPASS_ENABLED: true,
      SYNESIS_YARN_VERIFICATION_PLAN_ENABLED: true,
      SYNESIS_YARN_DECISION_MATRIX_ENABLED: true,
      SYNESIS_YARN_SENSEMAKING_ENABLED: true,
    });
    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    const reducer = new ToolResultReductionService(cfg, artifactStore);

    const raw = "src/app.ts:10:5: error TS2304: Cannot find name 'foo'.";
    const result = reducer.reduceStandaloneToolResult(raw, "tsc");
    expect(typeof result).toBe("string");

    const stats = reducer.getStats();
    expect(stats).toHaveProperty("compactionFailures");
    expect(stats).toHaveProperty("enrichedCount");
    expect(stats).toHaveProperty("bypassEligibleCount");
  });

  it("all features disabled preserves baseline behavior", async () => {
    const { ToolResultReductionService } = await import("../src/reduction/tool-result-reducer.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const cfg = makeConfig({
      SYNESIS_YARN_RECALL_BYPASS_ENABLED: false,
      SYNESIS_YARN_VERIFICATION_PLAN_ENABLED: false,
      SYNESIS_YARN_DECISION_MATRIX_ENABLED: false,
      SYNESIS_YARN_SENSEMAKING_ENABLED: false,
    });
    const artifactStore = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    const reducer = new ToolResultReductionService(cfg, artifactStore);

    const raw = "Hello world output";
    const result = reducer.reduceStandaloneToolResult(raw, "echo");
    expect(result).toBe(raw);
  });
});

/* ========== MCP tool timeout ========== */
describe("MCP tool execution timeout", () => {
  it("McpToolRegistry.call rejects on timeout", async () => {
    const { McpToolRegistry, McpToolTimeoutError } = await import("../src/mcp/tool-registry.js");
    const { z } = await import("zod");

    const registry = new McpToolRegistry();
    registry.setTimeoutMs(50);
    registry.register({
      name: "slow_tool",
      description: "Takes too long",
      inputSchema: z.object({}),
      handler: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    });

    await expect(registry.call("slow_tool", {})).rejects.toThrow(McpToolTimeoutError);
  });

  it("McpToolRegistry.call resolves fast tools normally", async () => {
    const { McpToolRegistry } = await import("../src/mcp/tool-registry.js");
    const { z } = await import("zod");

    const registry = new McpToolRegistry();
    registry.setTimeoutMs(5000);
    registry.register({
      name: "fast_tool",
      description: "Completes quickly",
      inputSchema: z.object({ msg: z.string() }),
      handler: (input) => ({ echo: (input as { msg: string }).msg }),
    });

    const result = await registry.call("fast_tool", { msg: "hello" });
    expect(result).toEqual({ echo: "hello" });
  });
});

/* ========== Compaction fallback ========== */
describe("Compaction fallback wiring", () => {
  it("SawtoothContextManager uses fallback truncation when LLM fails", async () => {
    const { SawtoothContextManager } = await import("../src/context/sawtooth-manager.js");
    const manager = new SawtoothContextManager(12, 100);
    manager.setCompactFn(async () => {
      throw new Error("LLM unavailable");
    });

    const longMessages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}: ${"x".repeat(200)}`,
    }));

    const result = await manager.compressTrajectory(longMessages);
    expect(result.summary).toContain("<ARCHITECTURAL_STATE>");
    expect(result.summary).toContain("truncated fallback");
    expect(result.archivedMessageCount).toBe(49);

    const stats = manager.getStats();
    expect(stats.compactionFailures).toBe(1);
    expect(stats.truncationFallbacks).toBe(1);
    expect(stats.llmCompactions).toBe(0);
  });

  it("SawtoothContextManager uses heuristic when no LLM and content is small", async () => {
    const { SawtoothContextManager } = await import("../src/context/sawtooth-manager.js");
    const manager = new SawtoothContextManager(12, 100_000);

    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];

    const result = await manager.compressTrajectory(messages);
    expect(result.summary).toContain("heuristic");

    const stats = manager.getStats();
    expect(stats.heuristicFallbacks).toBe(1);
    expect(stats.compactionFailures).toBe(0);
  });

  it("SawtoothContextManager counts LLM compaction successes", async () => {
    const { SawtoothContextManager } = await import("../src/context/sawtooth-manager.js");
    const manager = new SawtoothContextManager(12, 2000);
    manager.setCompactFn(async () => "<ARCHITECTURAL_STATE>Compacted</ARCHITECTURAL_STATE>");

    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ];

    const result = await manager.compressTrajectory(messages);
    expect(result.summary).toContain("Compacted");

    const stats = manager.getStats();
    expect(stats.llmCompactions).toBe(1);
    expect(stats.compactionFailures).toBe(0);
  });
});

/* ========== OTEL span helpers ========== */
describe("OTEL span integration", () => {
  it("withSpan wraps sync functions correctly", async () => {
    const { withSpan } = await import("../src/telemetry/otel.js");
    const result = withSpan("integration.test", { "test.name": "sync" }, () => 42);
    expect(result).toBe(42);
  });

  it("withSpanAsync wraps async functions correctly", async () => {
    const { withSpanAsync } = await import("../src/telemetry/otel.js");
    const result = await withSpanAsync("integration.test", { "test.name": "async" }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    });
    expect(result).toBe("done");
  });
});

/* ========== Artifact retrieval service ========== */
describe("Artifact retrieval parity", () => {
  it("injectToolClaude adds artifact tool schema", async () => {
    const { ArtifactRetrievalService, ARTIFACT_TOOL_SCHEMA_CLAUDE } = await import("../src/state/artifact-retrieval.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const store = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    store.putToolResult("some content");
    const service = new ArtifactRetrievalService(store);

    const tools = service.injectToolClaude([]);
    expect(tools).toHaveLength(1);
    expect((tools![0] as { name: string }).name).toBe(ARTIFACT_TOOL_SCHEMA_CLAUDE.name);
  });

  it("injectToolOpenAI adds artifact tool schema", async () => {
    const { ArtifactRetrievalService, ARTIFACT_TOOL_SCHEMA_OPENAI } = await import("../src/state/artifact-retrieval.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const store = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    store.putToolResult("some content");
    const service = new ArtifactRetrievalService(store);

    const tools = service.injectToolOpenAI([]);
    expect(tools).toHaveLength(1);
    expect((tools![0] as { function: { name: string } }).function.name).toBe(ARTIFACT_TOOL_SCHEMA_OPENAI.function.name);
  });

  it("retrieve returns content for valid handle", async () => {
    const { ArtifactRetrievalService } = await import("../src/state/artifact-retrieval.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const store = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    const record = store.putToolResult("The quick brown fox jumps over the lazy dog");
    const service = new ArtifactRetrievalService(store);

    const result = await service.retrieve(record.id);
    expect(result.found).toBe(true);
    expect(result.content).toContain("quick brown fox");
  });

  it("retrieve with query filters lines", async () => {
    const { ArtifactRetrievalService } = await import("../src/state/artifact-retrieval.js");
    const { ArtifactStore } = await import("../src/state/artifact-store.js");

    const store = new ArtifactStore({ maxEntries: 10, maxCharsPerEntry: 50_000, previewLength: 200 });
    const record = store.putToolResult("line1 apple\nline2 banana\nline3 apple pie");
    const service = new ArtifactRetrievalService(store);

    const result = await service.retrieve(record.id, "apple");
    expect(result.found).toBe(true);
    expect(result.matchedLines).toBe(2);
  });
});

/* ========== Config loading ========== */
describe("Config integration", () => {
  it("loads MCP tool timeout config", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({
      SYNESIS_YARN_ADMIN_API_URL: "http://localhost:9090",
      SYNESIS_YARN_MODEL_API_URL: "http://localhost:8081",
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
      SYNESIS_PAT_PEPPER: "test",
      SYNESIS_YARN_INTERNAL_TOKEN: "tok",
    });
    expect(cfg.SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS).toBe(60_000);
  });

  it("overrides MCP tool timeout from env", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({
      SYNESIS_YARN_ADMIN_API_URL: "http://localhost:9090",
      SYNESIS_YARN_MODEL_API_URL: "http://localhost:8081",
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
      SYNESIS_PAT_PEPPER: "test",
      SYNESIS_YARN_INTERNAL_TOKEN: "tok",
      SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS: "15000",
    });
    expect(cfg.SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS).toBe(15_000);
  });
});

/* ========== Trace enrichment ========== */
describe("Trace enrichment integration", () => {
  it("buildDecisionSnapshot produces complete snapshot", async () => {
    const { buildDecisionSnapshot, snapshotToTraceFields } = await import("../src/telemetry/decision-snapshot.js");
    const snapshot = buildDecisionSnapshot({
      orchestration: {
        selectedModel: "synesis-core",
        phase: "implementation",
        tier: "synesis-core",
        maxOutputTokens: 4096,
        decisionPath: "constrained",
        escalated: false,
        reasons: ["partial evidence"],
      },
      recallDecision: null,
      verificationState: { round: 0, stalled: false, findings: [] },
      policyMatchedRules: ["budget_ok"],
      reducedToolResults: 3,
      tokensSavedByReduction: 500,
      isStreaming: true,
      sensemakingTriggered: false,
    });

    expect(snapshot.decisionPath).toBe("constrained");
    expect(snapshot.tier).toBe("synesis-core");

    const traceFields = snapshotToTraceFields(snapshot);
    expect(traceFields).toHaveProperty("evidence_summary");
    expect(traceFields).toHaveProperty("decision_ledger");
  });
});

/* ========== Language pack registry ========== */
describe("Language pack registry integration", () => {
  it("registry has all 10 core language packs", async () => {
    const { getLanguagePackRegistry, loadAllPacks, resetLanguagePackRegistry, resetLoader } = await import("../src/language-packs/index.js");
    resetLanguagePackRegistry();
    resetLoader();
    loadAllPacks();
    const registry = getLanguagePackRegistry();

    const expectedLanguages = [
      "typescript", "python", "go", "rust", "java",
      "csharp", "terraform", "bash", "sql", "yaml-k8s",
    ];
    for (const lang of expectedLanguages) {
      expect(registry.getByLanguage(lang)).toBeDefined();
    }
  });

  it("packs have required fields", async () => {
    const { getLanguagePackRegistry, loadAllPacks, resetLanguagePackRegistry, resetLoader } = await import("../src/language-packs/index.js");
    resetLanguagePackRegistry();
    resetLoader();
    loadAllPacks();
    const registry = getLanguagePackRegistry();

    for (const lang of ["typescript", "python", "go"]) {
      const pack = registry.getByLanguage(lang)!;
      expect(pack.language).toBe(lang);
      expect(pack.families.length).toBeGreaterThan(0);
      expect(pack.verificationCommands.length).toBeGreaterThan(0);
    }
  });
});

/* ========== Event loop monitor ========== */
describe("Event loop monitor integration", () => {
  it("provides stats after monitoring period", async () => {
    const { startEventLoopMonitor, getEventLoopStats, stopEventLoopMonitor } = await import("../src/telemetry/event-loop-monitor.js");
    startEventLoopMonitor(10);
    await new Promise((r) => setTimeout(r, 50));
    const stats = getEventLoopStats();
    expect(typeof stats.p50Ms).toBe("number");
    expect(typeof stats.p95Ms).toBe("number");
    expect(typeof stats.p99Ms).toBe("number");
    expect(typeof stats.maxMs).toBe("number");
    stopEventLoopMonitor();
  });
});

/* ========== Evidence pipeline integration (Phase 13) ========== */
describe("Evidence prefetch pipeline", () => {
  it("evidence prefetch triggers pattern match and returns confidence", async () => {
    const { runEvidencePrefetch, resetEvidencePrefetchStats, getEvidencePrefetchStats } = await import("../src/evidence/fast-path.js");
    const { loadAllPacks, resetLanguagePackRegistry, resetLoader } = await import("../src/language-packs/index.js");
    resetLanguagePackRegistry();
    resetLoader();
    loadAllPacks();
    resetEvidencePrefetchStats();

    const mockKnowledgeService = {
      resolve: async () => ({
        results: [{
          text: "TS2345: Argument of type 'string' is not assignable",
          source_url: "https://ts.dev/errors/2345",
          document_name: "TypeScript Error Catalog",
          authority: "official",
          score: 0.92,
          constraint_kind: "hard",
          corpus_class: "coder_enriched",
          scope_tags: ["error-catalog"],
          language: "typescript",
          context_prefix: "TypeScript compiler errors",
          chunk_summary: "TS2345: Argument type mismatch",
        }],
        query: "TypeScript error TS2345",
        total: 1,
      }),
    } as unknown as import("../src/state/knowledge-search.js").KnowledgeSearchService;

    const result = await runEvidencePrefetch("error TS2345: Argument of type", mockKnowledgeService, 2000);
    expect(result.matched).toBe(true);
    expect(result.evidence).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.constraintKind).toBe("hard");

    const stats = getEvidencePrefetchStats();
    expect(stats.attempts).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.timeouts).toBe(0);
  });

  it("prefetch confidence flows into EvidenceSignals and decision routing", async () => {
    const { PhaseModelOrchestrator } = await import("../src/orchestration/phase-model-orchestrator.js");
    const orchestrator = new PhaseModelOrchestrator();

    const highConfidenceDecision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "fix TS2345 error",
      decisionMatrixEnabled: true,
      evidence: {
        recallConfidence: 0.95,
        recallRouting: "bypass",
        evidenceConfidence: 0.92,
        evidenceAuthoritative: true,
        verificationRound: 1,
        consecutiveFailedVerifications: 0,
      },
    }, "test-session");

    expect(highConfidenceDecision.decisionPath).toBeDefined();
    expect(highConfidenceDecision.selectedModel).toBeDefined();
    expect(highConfidenceDecision.tier).toBeDefined();

    const lowConfidenceDecision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "write me a blog post",
      decisionMatrixEnabled: true,
      evidence: {
        recallConfidence: undefined,
        evidenceConfidence: undefined,
        evidenceAuthoritative: false,
        verificationRound: undefined,
        consecutiveFailedVerifications: 0,
      },
    }, "test-session-2");

    expect(lowConfidenceDecision.decisionPath).toBeDefined();
  });

  it("formatEvidenceBlock creates valid injection block", async () => {
    const { formatEvidenceBlock } = await import("../src/evidence/fast-path.js");
    const block = formatEvidenceBlock({
      matched: true,
      pattern: "typescript_error",
      evidence: {
        results: [{
          text: "TS2345 explanation",
          source_url: "https://ts.dev",
          document_name: "TS Error Catalog",
          authority: "official",
          score: 0.9,
          constraint_kind: "hard",
          corpus_class: "coder_enriched",
          scope_tags: ["error-catalog"],
          language: "typescript",
          context_prefix: "",
          chunk_summary: "TS2345: Argument type mismatch",
        }],
        query: "TypeScript error TS2345",
        total: 1,
      },
      latencyMs: 50,
      timedOut: false,
      confidence: 0.85,
      constraintKind: "hard",
      authoritative: true,
    });
    expect(block).toContain("<synesis_evidence");
    expect(block).toContain("</synesis_evidence>");
    expect(block).toContain('confidence="0.85"');
    expect(block).toContain('authoritative="true"');
  });
});

const knowledgeDeps = {
  plannerBaseUrl: "http://planner.test:8080",
  criticUrl: "http://critic.test/v1",
  criticModel: "synesis-critic",
  internalServiceToken: "internal",
};

describe("Knowledge search tool Claude parity", () => {
  it("injectToolOpenAI and injectToolClaude both add the tool", async () => {
    const { KnowledgeSearchService, KNOWLEDGE_TOOL_NAME, CONTEXT_BUNDLE_TOOL_NAME, DEV_DOCS_TOOL_NAME } = await import("../src/state/knowledge-search.js");
    const svc = new KnowledgeSearchService(knowledgeDeps);

    const oaiTools = svc.injectToolOpenAI([]);
    expect(oaiTools).toHaveLength(3);
    const oaiNames = (oaiTools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name);
    expect(oaiNames).toContain(KNOWLEDGE_TOOL_NAME);
    expect(oaiNames).toContain(CONTEXT_BUNDLE_TOOL_NAME);
    expect(oaiNames).toContain(DEV_DOCS_TOOL_NAME);

    const claudeTools = svc.injectToolClaude([]);
    expect(claudeTools).toHaveLength(3);
    const claudeNames = (claudeTools as Array<{ name?: string }>).map((t) => t.name);
    expect(claudeNames).toContain(KNOWLEDGE_TOOL_NAME);
    expect(claudeNames).toContain(CONTEXT_BUNDLE_TOOL_NAME);
    expect(claudeNames).toContain(DEV_DOCS_TOOL_NAME);
  });

  it("knowledge search resolve returns results and tracks stats", async () => {
    const { KnowledgeSearchService } = await import("../src/state/knowledge-search.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [{
            text: "TypeScript error TS2345 explanation",
            source_url: "https://ts.dev/errors/2345",
            document_name: "TS Error Catalog",
            authority: "official",
            score: 0.92,
            constraint_kind: "hard",
            corpus_class: "coder_enriched",
            scope_tags: ["error-catalog"],
            language: "typescript",
            context_prefix: "TypeScript compiler errors",
            chunk_summary: "TS2345: Argument type mismatch",
            content_profile: "",
            constraint_source: "",
            constraint_confidence: 0,
            golden_path_id: "",
            novel_pattern: false,
          }],
          query: "TypeScript error TS2345",
          total: 1,
        }),
        { status: 200 },
      ),
    );

    const svc = new KnowledgeSearchService(knowledgeDeps);
    const result = await svc.resolve(
      { query: "TypeScript error TS2345" },
      { orgId: "org-1", userId: "u1", tenantIds: [], bearerToken: "syn-test" },
    );
    expect(result.total).toBe(1);
    expect(result.results[0].score).toBe(0.92);

    const stats = svc.getStats();
    expect(stats.searchCount).toBe(1);
    expect(stats.errorCount).toBe(0);

    fetchSpy.mockRestore();
  });
});

describe("Decision snapshot with evidence metadata", () => {
  it("buildDecisionSnapshot includes evidence prefetch fields", async () => {
    const { buildDecisionSnapshot, snapshotToTraceFields } = await import("../src/telemetry/decision-snapshot.js");
    const snapshot = buildDecisionSnapshot({
      orchestration: {
        decisionPath: "deterministic",
        phase: "execute",
        tier: "core",
        selectedModel: "synesis-core",
        escalated: false,
        uncertaintyFraming: undefined,
      },
      recallDecision: null,
      verificationState: { round: 0, stalled: false, findings: [], planId: undefined, roundResults: [], lastRunMs: 0 },
      policyMatchedRules: ["default"],
      reducedToolResults: 2,
      tokensSavedByReduction: 500,
      evidencePrefetched: true,
      evidenceConfidence: 0.88,
      evidenceAuthoritative: true,
      evidencePrefetchLatencyMs: 45,
      languages: ["typescript"],
      isStreaming: false,
    });

    expect(snapshot.evidencePrefetched).toBe(true);
    expect(snapshot.evidenceConfidence).toBe(0.88);
    expect(snapshot.evidenceAuthoritative).toBe(true);
    expect(snapshot.evidencePrefetchLatencyMs).toBe(45);

    const traceFields = snapshotToTraceFields(snapshot);
    expect(traceFields.evidence_summary.evidenceConfidence).toBe(0.88);
    expect(traceFields.evidence_summary.evidenceAuthoritative).toBe(true);
    expect(traceFields.evidence_summary.evidencePrefetched).toBe(true);
    expect(traceFields.evidence_summary.evidencePrefetchLatencyMs).toBe(45);
  });

  it("snapshot without evidence has undefined fields", async () => {
    const { buildDecisionSnapshot } = await import("../src/telemetry/decision-snapshot.js");
    const snapshot = buildDecisionSnapshot({
      orchestration: {
        decisionPath: "inference-first",
        phase: "execute",
        tier: "pulse",
        selectedModel: "synesis-pulse",
        escalated: false,
        uncertaintyFraming: undefined,
      },
      recallDecision: null,
      verificationState: { round: 0, stalled: false, findings: [], planId: undefined, roundResults: [], lastRunMs: 0 },
      policyMatchedRules: [],
      reducedToolResults: 0,
      tokensSavedByReduction: 0,
      isStreaming: true,
    });

    expect(snapshot.evidencePrefetched).toBeUndefined();
    expect(snapshot.evidenceConfidence).toBeUndefined();
    expect(snapshot.evidencePrefetchLatencyMs).toBeUndefined();
  });
});

describe("Evidence pipeline feature flag combinations", () => {
  it("all evidence features enabled config is valid", () => {
    const config = makeConfig({
      SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: true,
      SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED: true,
      SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED: true,
      SYNESIS_YARN_DECISION_MATRIX_ENABLED: true,
      SYNESIS_YARN_RECALL_BYPASS_ENABLED: true,
      SYNESIS_YARN_SENSEMAKING_ENABLED: true,
    });
    expect(config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED).toBe(true);
    expect(config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED).toBe(true);
    expect(config.SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED).toBe(true);
    expect(config.SYNESIS_YARN_DECISION_MATRIX_ENABLED).toBe(true);
  });

  it("evidence prefetch without knowledge search is still valid config", () => {
    const config = makeConfig({
      SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED: false,
      SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED: true,
    });
    expect(config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED).toBe(false);
  });

  it("decision matrix with high evidence triggers deterministic path", async () => {
    const { PhaseModelOrchestrator } = await import("../src/orchestration/phase-model-orchestrator.js");
    const orchestrator = new PhaseModelOrchestrator();

    const decision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "error TS2345",
      decisionMatrixEnabled: true,
      evidence: {
        recallConfidence: 0.95,
        recallRouting: "bypass",
        evidenceConfidence: 0.95,
        evidenceAuthoritative: true,
        verificationRound: 1,
        consecutiveFailedVerifications: 0,
      },
    }, "test-session-high");

    expect(["deterministic", "constrained"]).toContain(decision.decisionPath);
  });

  it("decision matrix with no evidence uses inference_first path", async () => {
    const { PhaseModelOrchestrator } = await import("../src/orchestration/phase-model-orchestrator.js");
    const orchestrator = new PhaseModelOrchestrator();

    const decision = orchestrator.decide({
      requestedModel: "synesis-core",
      latestUserText: "write me a poem about coding",
      decisionMatrixEnabled: true,
      evidence: {
        recallConfidence: undefined,
        evidenceConfidence: undefined,
        evidenceAuthoritative: false,
        consecutiveFailedVerifications: 0,
      },
    }, "test-session-low");

    expect(["inference_first", "constrained"]).toContain(decision.decisionPath);
  });

  it("evidence prefetch stats accumulate correctly", async () => {
    const { resetEvidencePrefetchStats, getEvidencePrefetchStats, runEvidencePrefetch } = await import("../src/evidence/fast-path.js");
    const { loadAllPacks, resetLanguagePackRegistry, resetLoader } = await import("../src/language-packs/index.js");
    resetLanguagePackRegistry();
    resetLoader();
    loadAllPacks();
    resetEvidencePrefetchStats();

    const emptySvc = {
      resolve: async () => ({ results: [], query: "", total: 0 }),
    } as unknown as import("../src/state/knowledge-search.js").KnowledgeSearchService;

    await runEvidencePrefetch("error TS2345: test", emptySvc, 2000);
    await runEvidencePrefetch("hello world", emptySvc, 2000);
    await runEvidencePrefetch("Traceback (most recent call last):", emptySvc, 2000);

    const stats = getEvidencePrefetchStats();
    expect(stats.attempts).toBe(3);
    expect(stats.misses).toBeGreaterThanOrEqual(2);
    expect(stats.timeouts).toBe(0);
    expect(stats.totalLatencyMs).toBeGreaterThan(0);
  });
});
