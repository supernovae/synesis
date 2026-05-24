import { describe, expect, it } from "vitest";
import { runOpenAIStreamRoutePipeline } from "../src/pipeline/openai-stream-route-pipeline.js";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";

async function* emptyStream(): AsyncIterable<unknown> {}

describe("runOpenAIStreamRoutePipeline", () => {
  it("runs the assembled stream route pipeline", async () => {
    const writes: string[] = [];
    const lifecycle: string[] = [];
    const streamState = new OpenAIStreamState();
    const writer = new OpenAIStreamResponseWriter({
      raw: { write: (chunk: string) => { writes.push(chunk); return true; } } as never,
      requestId: "req-1",
      model: "model-1",
    });

    const result = await runOpenAIStreamRoutePipeline({
      streamParts: emptyStream(),
      runtime: {
        heartbeat: { stop: () => lifecycle.push("heartbeat") },
        components: {
          streamState,
          guardrailAccepted: [],
          blockedDetails: [],
          accumulator: {
            emittedToolCalls: 0,
            toolRepairs: 0,
            validationFailures: 0,
            blockedBroadDiscovery: 0,
            collapsedBroadDiscovery: 0,
          } as never,
          localLikeBaseUrl: false,
          cacheStrategy: "none",
          prefixFingerprint: "prefix",
          writer,
          scrubAndFlushText: (text) => writer.writeTextDelta(text),
        },
        lifecycle: {
          onEventError: () => lifecycle.push("error"),
          beforeFinalize: () => lifecycle.push("finalize"),
        },
        afterEvents: () => lifecycle.push("after"),
      },
      eventHandlers: {
        scope: { sessionKey: "session-1", userId: "user-1", orgId: "org-1", requestId: "req-1" },
        adapter: {
          family: "openai",
          normalizeToolName: (name: string) => name,
          restoreToolNameForClient: (name: string) => name,
          normalizeToolCallInput: (name: string, input: Record<string, unknown>) => ({ toolName: name, input, repaired: false }),
        } as never,
        resolvedModelId: "model-1",
        clientKind: "opencode",
        effectiveTools: [],
        debugProtocol: false,
        strictGovernance: false,
        recentToolNames: [],
        taskCue: undefined,
        clientPlanModeRequested: false,
        pathContext: {},
        enforcePathRoot: false,
        blockBashPathDrift: false,
        pathSandboxEnabled: false,
        artifactShadows: [],
        normalizedMessageCount: 1,
        session: {
          gitInspectionBlockCount: 0,
          blockBroadVerificationUntilEdit: false,
          blockFailingVerificationUntilEdit: false,
          artifactEditTurns: new Map<string, number>(),
          record: { requestCount: 1, metadata: {} },
        },
        stats: {} as never,
        logger: { info: () => undefined, warn: () => undefined, debug: () => undefined } as never,
        isWriteCapableToolName: () => false,
        shouldRestrictDiscoveryForPlanWork: () => false,
        deserializePlanShadow: () => null,
        buildPathSandboxPolicy: () => ({}) as never,
        sideEffects: {
          updateDiffAccumulator: () => undefined,
          maybeUpdateTaskLedgerFromToolCall: () => undefined,
          emitPlanWriteAuditEvent: () => undefined,
          maybeLogEnvelopeUnwrapSample: () => undefined,
          recordUpperHarnessDecision: () => undefined,
        },
        strictGovernanceStats: { strictGovernanceRewrites: 0 },
        recordBlockedDiscovery: () => undefined,
        getTopLevelDirs: async () => [],
        applyDiscoveryGuardrail: () => ({ calls: [], blockedCount: 0, redirectedCount: 0, collapsedCount: 0, blockedDetails: [] }),
        buildBlockedDiscoveryRecovery: async () => ({ text: "", entryCount: 0, recoveryMode: "no_project_root" }),
      },
      finalizer: {
        scope: { sessionKey: "session-1", userId: "user-1", orgId: "org-1", requestId: "req-1" },
        streamed: { totalUsage: Promise.resolve({}), text: Promise.resolve("") },
        streamOptions: undefined,
        readUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 }),
        session: { history: [], record: { requestCount: 1, sessionKey: "session-1" }, taskCapabilities: null, taskLedger: null },
        checklist: null,
        traceRootPrompt: "",
        latestUserPrompt: "",
        verification: {},
        recentToolNames: [],
        planGraph: null,
        responseStyleMode: "default",
        applyMarkdownGuardrail: (text) => text,
        finalizeCompletionText: async () => ({ finalText: "", missingMust: 0, missingShould: 0, blockedByVerification: false }),
        finalizePostStreamText: () => ({ finalText: "", missingMust: 0, missingShould: 0, blockedByVerification: false }),
        endStream: () => lifecycle.push("end"),
        stopHeartbeat: () => lifecycle.push("stop"),
        recordSessionEvent: () => undefined,
      },
      telemetry: {
        routeBase: {
          scope: { sessionKey: "session-1", userId: "user-1", orgId: "org-1", requestId: "req-1" },
          startedAtMs: Date.now(),
          resolvedModelId: "model-1",
          clientRequestedModel: "client-model",
          reductions: {
            toolResultReduction: {
              getPerRequestDelta: () => 0,
              getPerRequestGuidedTruncationDelta: () => 0,
              getPerRequestTaskPrunedDelta: () => 0,
              getLastRecallDecision: () => null,
              getVerificationTracker: () => ({ getState: () => ({ round: 0, findings: [], stalled: false }) }),
            },
            validationNormalization: { getPerRequestDelta: () => 0 },
          },
          reducedToolResults: 0,
          orchestration: {} as never,
          policyMatchedRules: [],
          normalizedMessages: [],
          inferVerificationSteps: () => [],
          toolDefinitionCount: 0,
          artifactToolInjected: false,
          knowledgeToolInjected: false,
          countMessageRoles: () => ({ systemMessageCount: 0, userMessageCount: 0, toolMessageCount: 0, totalInputChars: 0 }),
          pushDiagnostic: () => undefined,
        },
        optimizationLedger: {
          setUpstreamCachedTokens: () => undefined,
          recordFinal: () => undefined,
          finalize: () => ({}),
          toLogRecord: () => ({}),
        },
        finalizeRequestForensics: () => undefined,
        recordSessionEvent: () => undefined,
        persistDecisionTelemetry: () => lifecycle.push("telemetry"),
        logOptimizationLedger: () => undefined,
      },
    });

    expect(result.finishReason).toBe("stop");
    expect(lifecycle).toEqual(["after", "finalize", "end", "stop", "telemetry"]);
    expect(writes.some((chunk) => chunk.includes("[DONE]"))).toBe(true);
  });
});
