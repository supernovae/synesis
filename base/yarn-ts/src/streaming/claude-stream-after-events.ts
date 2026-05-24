import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { ClaudeStreamDiscoveryState } from "./claude-stream-components.js";
import type { ClaudeStreamState } from "./claude-stream-state.js";

export interface ClaudeStreamAfterEventsInput {
  adapter: Pick<ModelAdapter, "family">;
  localLikeBaseUrl: boolean;
  requestId: string;
  resolvedModelId: string;
  baseUrl?: string;
  sessionKey: string;
  streamState: ClaudeStreamState;
  discovery: ClaudeStreamDiscoveryState;
  blockedDetails: BlockedDiscoveryDetail[];
  toolRepairs: number;
  validationFailures: number;
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

export interface ClaudeStreamAfterEventsRouteInput {
  adapter: Pick<ModelAdapter, "family">;
  localLikeBaseUrl: boolean;
  requestId: string;
  resolvedModelId: string;
  baseUrl?: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  streamState: ClaudeStreamState;
  discovery: ClaudeStreamDiscoveryState;
  blockedDetails: BlockedDiscoveryDetail[];
  stats: Pick<ToolArgHardeningStats, "qwenParserMismatchSuspectCount">;
  logger: {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  recordBlockedDiscovery(sessionKey: string, count: number): void;
  getBlockedDiscoveryCount(sessionKey: string): number;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId: string,
    metadataJson?: Record<string, unknown>,
  ): void;
}

export interface ClaudeStreamAfterEventsCounters {
  toolRepairs: number;
  validationFailures: number;
}

export function createClaudeStreamAfterEventsHandler(
  input: ClaudeStreamAfterEventsRouteInput,
): (counters: ClaudeStreamAfterEventsCounters) => void {
  return (counters) => runClaudeStreamAfterEvents({
    adapter: input.adapter,
    localLikeBaseUrl: input.localLikeBaseUrl,
    requestId: input.requestId,
    resolvedModelId: input.resolvedModelId,
    baseUrl: input.baseUrl,
    sessionKey: input.sessionKey,
    streamState: input.streamState,
    discovery: input.discovery,
    blockedDetails: input.blockedDetails,
    toolRepairs: counters.toolRepairs,
    validationFailures: counters.validationFailures,
    stats: input.stats,
    logger: input.logger,
    recordBlockedDiscovery: input.recordBlockedDiscovery,
    getBlockedDiscoveryCount: input.getBlockedDiscoveryCount,
    recordSessionEvent: (event) => input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      event.eventKind,
      event.component,
      event.detail,
      input.requestId,
      event.metadataJson,
    ),
  });
}

export function runClaudeStreamAfterEvents(input: ClaudeStreamAfterEventsInput): void {
  if (
    input.adapter.family === "qwen3-coder"
    && input.localLikeBaseUrl
    && input.validationFailures > 0
    && input.toolRepairs >= 2
  ) {
    input.stats.qwenParserMismatchSuspectCount += 1;
    input.logger.warn(
      {
        reqId: input.requestId,
        resolvedModel: input.resolvedModelId,
        baseUrl: input.baseUrl,
        validationFailures: input.validationFailures,
        repairs: input.toolRepairs,
      },
      "qwen3_parser_mismatch_suspected: repeated tool arg repairs/validation failures on local endpoint; verify vLLM uses --tool-call-parser=qwen3_coder",
    );
  }

  input.streamState.normalizedStopReason();

  if (input.discovery.blockedBroadDiscovery > 0) {
    input.recordBlockedDiscovery(input.sessionKey, input.discovery.blockedBroadDiscovery);
    input.recordSessionEvent({
      eventKind: "tool_call_blocked_broad_discovery",
      component: "tool-guardrails",
      detail: `blocked=${input.discovery.blockedBroadDiscovery};sessionTotal=${input.getBlockedDiscoveryCount(input.sessionKey)}`,
      metadataJson: {
        blockedDetails: input.blockedDetails.slice(0, 5),
        recoveryMode: input.discovery.recoveryMode,
        topLevelPreview: input.discovery.recoveryPreviewEntries,
        sessionBlockedTotal: input.getBlockedDiscoveryCount(input.sessionKey),
      },
    });
    input.recordSessionEvent({
      eventKind: "blocked_broad_discovery_then_recovery",
      component: "tool-guardrails",
      detail: `mode=${input.discovery.recoveryMode ?? "unknown"};top_level_preview=${input.discovery.recoveryPreviewEntries}`,
      metadataJson: {
        recoveryMode: input.discovery.recoveryMode,
        topLevelPreview: input.discovery.recoveryPreviewEntries,
      },
    });
  }

  if (input.discovery.collapsedBroadDiscovery > 0) {
    input.recordSessionEvent({
      eventKind: "duplicate_broad_call_collapsed",
      component: "tool-guardrails",
      detail: `collapsed=${input.discovery.collapsedBroadDiscovery}`,
    });
  }
}
