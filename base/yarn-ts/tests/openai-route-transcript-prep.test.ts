import { describe, expect, it, vi } from "vitest";
import { prepareOpenAIRouteTranscript } from "../src/pipeline/openai-route-transcript-prep.js";
import { OptimizationLedger } from "../src/telemetry/optimization-ledger.js";

function baseConfig(overrides: Partial<Parameters<typeof prepareOpenAIRouteTranscript>[0]["config"]> = {}) {
  return {
    SYNESIS_YARN_GOVERNANCE_DISABLED: false,
    SYNESIS_YARN_REDUCERS_ENABLED: false,
    SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED: true,
    SYNESIS_YARN_DEDUPE_ENABLED: true,
    SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED: true,
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof prepareOpenAIRouteTranscript>[0]> = {}) {
  const messages = [{ role: "user", content: "hello" }];
  return {
    request: {
      model: "openai-test",
      messages,
      stream: false,
    } as never,
    requestId: "req_1",
    taskCue: "hello",
    backendModelHint: "openai/backend",
    config: baseConfig(),
    capabilityMatrix: {
      mode: "enforced",
      global_optimizations_enabled: true,
    },
    enrichmentPool: {
      isAvailable: vi.fn(() => false),
    } as never,
    toolResultReduction: {
      reduceMessages: vi.fn(() => ({ messages, reducedCount: 0 })),
      reduceMessagesAsync: vi.fn(),
    } as never,
    validationNormalization: {
      normalizeMessagesAsync: vi.fn(async (inputMessages) => ({ messages: inputMessages, normalizedCount: 0 })),
    } as never,
    transcriptPruning: {
      prune: vi.fn((inputMessages) => ({
        pruned: false,
        messages: inputMessages,
        invocationDelta: {
          commandsDeduped: 0,
          fileDeduped: 0,
          toolResultsEvicted: 0,
          assistantCondensed: 0,
          nearDuplicatesCollapsed: 0,
          artifactsStored: 0,
        },
      })),
    } as never,
    optimizationLedger: new OptimizationLedger(),
    logger: {
      info: vi.fn(),
    },
    ...overrides,
  };
}

describe("prepareOpenAIRouteTranscript", () => {
  it("normalizes messages, resolves capability flags, and preserves stage handles", async () => {
    const endNormalizationStage = vi.fn();
    const endPruningStage = vi.fn();
    const input = baseInput({
      endNormalizationStage,
      startPruningStage: vi.fn(() => endPruningStage),
    });

    const result = await prepareOpenAIRouteTranscript(input);

    expect(result.matrixModelId).toBe("openai-test");
    expect(result.matrixModelPath).toBe("openai/backend");
    expect(result.matrixFamily).toBe("generic");
    expect(result.phasePolicyEnabledByMatrix).toBe(true);
    expect(result.contentDedupeEnabled).toBe(true);
    expect(result.responseDedupeEnabled).toBe(true);
    expect(result.historicalNormalizeEnabled).toBe(true);
    expect(result.toolResultCount).toBe(0);
    expect(input.validationNormalization.normalizeMessagesAsync).toHaveBeenCalledWith(
      input.request.messages,
      undefined,
    );
    expect(input.transcriptPruning.prune).toHaveBeenCalled();
    expect(endNormalizationStage).toHaveBeenCalledOnce();
    expect(endPruningStage).not.toHaveBeenCalled();
    result.endPruningStage?.();
    expect(endPruningStage).toHaveBeenCalledOnce();
  });

  it("bypasses reducers and pruning when governance disables them", async () => {
    const input = baseInput({
      config: baseConfig({
        SYNESIS_YARN_GOVERNANCE_DISABLED: true,
        SYNESIS_YARN_REDUCERS_ENABLED: true,
      }),
    });

    const result = await prepareOpenAIRouteTranscript(input);

    expect(result.reducedOpenAI.reducedCount).toBe(0);
    expect(input.toolResultReduction.reduceMessages).not.toHaveBeenCalled();
    expect(input.transcriptPruning.prune).not.toHaveBeenCalled();
  });

  it("uses the reducer and logs reductions when enabled", async () => {
    const reducedMessages = [{ role: "user", content: "short" }];
    const input = baseInput({
      config: baseConfig({ SYNESIS_YARN_REDUCERS_ENABLED: true }),
      toolResultReduction: {
        reduceMessages: vi.fn(() => ({ messages: reducedMessages, reducedCount: 2 })),
        reduceMessagesAsync: vi.fn(),
      } as never,
    });

    const result = await prepareOpenAIRouteTranscript(input);

    expect(result.reducedOpenAI).toEqual({ messages: reducedMessages, reducedCount: 2 });
    expect(input.toolResultReduction.reduceMessages).toHaveBeenCalledWith(
      input.request.messages,
      "hello",
      undefined,
      expect.objectContaining({
        backendModelHint: "openai/backend",
        jsonCompactionEnabled: true,
      }),
    );
    expect(input.logger.info).toHaveBeenCalledWith(
      { reqId: "req_1", tool_result_reduced: 2 },
      "yarn_harness_tool_result_reduction",
    );
  });
});
