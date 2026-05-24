import type { ModelAdapter } from "../providers/model-adapter.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";
import type { OpenAIStreamToolCallAccumulator } from "./openai-stream-tool-call-handler.js";

export interface OpenAIStreamAfterEventsInput {
  adapter: Pick<ModelAdapter, "family">;
  localLikeBaseUrl: boolean;
  requestId: string;
  resolvedModelId: string;
  baseUrl?: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  streamState: OpenAIStreamState;
  accumulator: OpenAIStreamToolCallAccumulator;
  blockedDetails: BlockedDiscoveryDetail[];
  stats: Pick<ToolArgHardeningStats, "qwenParserMismatchSuspectCount">;
  logger: {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  recordBlockedDiscovery(sessionKey: string, count: number): void;
  getBlockedDiscoveryCount(sessionKey: string): number;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
    metadataJson?: Record<string, unknown>;
  }): void;
}

export type OpenAIStreamAfterEventsHandler = () => void;

export function createOpenAIStreamAfterEventsHandler(
  input: OpenAIStreamAfterEventsInput,
): OpenAIStreamAfterEventsHandler {
  return () => {
    runOpenAIStreamAfterEvents(input);
  };
}

export function runOpenAIStreamAfterEvents(input: OpenAIStreamAfterEventsInput): void {
  if (
    input.adapter.family === "qwen3-coder"
    && input.localLikeBaseUrl
    && input.accumulator.validationFailures > 0
    && input.accumulator.toolRepairs >= 2
  ) {
    input.stats.qwenParserMismatchSuspectCount += 1;
    input.logger.warn(
      {
        reqId: input.requestId,
        resolvedModel: input.resolvedModelId,
        baseUrl: input.baseUrl,
        validationFailures: input.accumulator.validationFailures,
        repairs: input.accumulator.toolRepairs,
      },
      "qwen3_parser_mismatch_suspected: repeated tool arg repairs/validation failures on local endpoint; verify vLLM uses --tool-call-parser=qwen3_coder",
    );
  }

  input.streamState.normalizedFinishReason(input.accumulator.emittedToolCalls);

  if (input.accumulator.blockedBroadDiscovery > 0) {
    input.recordBlockedDiscovery(input.sessionKey, input.accumulator.blockedBroadDiscovery);
    input.recordSessionEvent({
      eventKind: "tool_call_blocked_broad_discovery",
      component: "tool-guardrails",
      detail: `blocked=${input.accumulator.blockedBroadDiscovery};sessionTotal=${input.getBlockedDiscoveryCount(input.sessionKey)}`,
      metadataJson: {
        blockedDetails: input.blockedDetails.slice(0, 5),
        recoveryMode: input.accumulator.recoveryMode,
        topLevelPreview: input.accumulator.recoveryPreviewEntries,
        sessionBlockedTotal: input.getBlockedDiscoveryCount(input.sessionKey),
      },
    });
    input.recordSessionEvent({
      eventKind: "blocked_broad_discovery_then_recovery",
      component: "tool-guardrails",
      detail: `mode=${input.accumulator.recoveryMode ?? "unknown"};top_level_preview=${input.accumulator.recoveryPreviewEntries}`,
      metadataJson: {
        recoveryMode: input.accumulator.recoveryMode,
        topLevelPreview: input.accumulator.recoveryPreviewEntries,
      },
    });
  }

  if (input.accumulator.collapsedBroadDiscovery > 0) {
    input.recordSessionEvent({
      eventKind: "duplicate_broad_call_collapsed",
      component: "tool-guardrails",
      detail: `collapsed=${input.accumulator.collapsedBroadDiscovery}`,
    });
  }
}
