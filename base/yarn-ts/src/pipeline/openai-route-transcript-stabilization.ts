import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import type { MemoryGovernorTracker } from "../memory/governor-integration.js";
import type { ContentAddressedDedup } from "../reduction/content-addressed-dedup.js";
import type { FileSnapshotRegistry } from "../reduction/file-snapshot-registry.js";
import { normalizeReadSnapshotMessages } from "../reduction/read-snapshot-normalizer.js";
import { normalizeHistoricalContent, stabilizeToolCallIds } from "../reduction/historical-normalizer.js";
import type { TranscriptPruningService } from "../reduction/transcript-pruning.js";
import type { OptimizationLedger } from "../telemetry/optimization-ledger.js";

type RouteMessage = {
  role: string;
  name?: string;
  tool_call_id?: string;
  content: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
};

export interface OpenAITranscriptStabilizationSession {
  lastIncomingMessageCount: number;
  skipToolIdStabilization: boolean;
}

export interface OpenAITranscriptStabilizationIdentity {
  userId: string;
  orgId: string;
}

export interface OpenAITranscriptStabilizationPathContext {
  projectRoot?: string | null;
  shellCwd?: string | null;
}

interface OpenAITranscriptStabilizationLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAITranscriptStabilizationInput {
  messages: RouteMessage[];
  originalMessageCount: number;
  session: OpenAITranscriptStabilizationSession;
  sessionKey: string;
  identity: OpenAITranscriptStabilizationIdentity;
  requestId: string;
  pathContext: OpenAITranscriptStabilizationPathContext;
  governanceDisabled: boolean;
  debugProtocol: boolean;
  contentDedupeEnabled: boolean;
  responseDedupeEnabled: boolean;
  historicalNormalizeEnabled: boolean;
  compactionBackendModelHint?: string;
  yarnDedupeLayer: DedupeLayer | null;
  transcriptPruning: Pick<TranscriptPruningService, "computeKeepFromIndex">;
  optimizationLedger: OptimizationLedger;
  logger: OpenAITranscriptStabilizationLogger;
  getFileSnapshotRegistry(sessionKey: string): FileSnapshotRegistry;
  getContentDedup(sessionKey: string): ContentAddressedDedup;
  getMemoryGovernor(sessionKey: string): Pick<MemoryGovernorTracker, "trackFileRead" | "trackSummaryGenerated">;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId?: string,
    metadataJson?: Record<string, unknown>,
  ): void;
}

export interface OpenAITranscriptStabilizationResult {
  messages: RouteMessage[];
  readSnapshotNormalizedCount: number;
  contentDedupCount: number;
  responseDedupHits: number;
  historicalNormalizedCount: number;
  toolIdRewriteCount: number;
}

function findLastUserPromptIdx(messages: Array<{ role?: string; content?: unknown }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (
      Array.isArray(message.content)
      && message.content.length > 0
      && (message.content as Array<{ type?: string }>).every((block) => block?.type === "tool_result")
    ) {
      continue;
    }
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (!text && !Array.isArray(message.content)) continue;
    return i;
  }
  return -1;
}

function extractToolInputForMessage(messages: RouteMessage[], messageIndex: number): unknown {
  const message = messages[messageIndex];
  if (!message.tool_call_id) return undefined;
  for (let assistantIndex = messageIndex - 1; assistantIndex >= 0; assistantIndex--) {
    const assistantMessage = messages[assistantIndex];
    if (assistantMessage.role !== "assistant" || !assistantMessage.tool_calls) continue;
    const match = assistantMessage.tool_calls.find((toolCall) => toolCall.id === message.tool_call_id);
    if (!match?.function?.arguments) continue;
    try {
      return JSON.parse(match.function.arguments);
    } catch {
      return match.function.arguments;
    }
  }
  return undefined;
}

export async function stabilizeOpenAITranscript(
  input: OpenAITranscriptStabilizationInput,
): Promise<OpenAITranscriptStabilizationResult> {
  let messages = input.messages;
  let readSnapshotNormalizedCount = 0;
  let contentDedupCount = 0;
  let responseDedupHits = 0;
  let historicalNormalizedCount = 0;
  let toolIdRewriteCount = 0;

  const readSnapshotRegistry = input.getFileSnapshotRegistry(input.sessionKey);
  const readSnapshotNormalization = await normalizeReadSnapshotMessages(
    messages,
    readSnapshotRegistry,
    {
      projectRoot: input.pathContext.projectRoot ?? input.pathContext.shellCwd ?? null,
      anchorDir: input.pathContext.shellCwd ?? input.pathContext.projectRoot ?? null,
      lastUserPromptIdx: findLastUserPromptIdx(messages),
    },
  );
  if (readSnapshotNormalization.normalizedCount > 0) {
    messages = readSnapshotNormalization.messages as RouteMessage[];
    readSnapshotNormalizedCount = readSnapshotNormalization.normalizedCount;
    if (input.debugProtocol) {
      input.logger.debug({
        reqId: input.requestId,
        normalized: readSnapshotNormalization.normalizedCount,
        replayed: readSnapshotNormalization.replayedCount,
        fallback: readSnapshotNormalization.fallbackCount,
      }, "read_snapshot_normalization_applied");
    }
  }

  if (input.governanceDisabled) {
    return {
      messages,
      readSnapshotNormalizedCount,
      contentDedupCount,
      responseDedupHits,
      historicalNormalizedCount,
      toolIdRewriteCount,
    };
  }

  const dedup = input.getContentDedup(input.sessionKey);
  if (
    input.contentDedupeEnabled
    && input.session.lastIncomingMessageCount > 0
    && input.originalMessageCount < input.session.lastIncomingMessageCount * 0.6
  ) {
    dedup.reset();
    input.getFileSnapshotRegistry(input.sessionKey).markCompaction("SUMMARY_ONLY");
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "external_compaction_detected",
      "dedup_reset",
      `msgs ${input.session.lastIncomingMessageCount} -> ${input.originalMessageCount}`,
    );
  }
  input.session.lastIncomingMessageCount = input.originalMessageCount;

  if (input.contentDedupeEnabled) {
    const dedupResult = dedup.processMessages(messages);
    if (dedupResult.dedupCount > 0) {
      messages = dedupResult.messages as RouteMessage[];
      contentDedupCount = dedupResult.dedupCount;
      const memTracker = input.getMemoryGovernor(input.sessionKey);
      for (const path of dedupResult.dedupPaths) {
        memTracker.trackFileRead(path);
        if (dedup.getStructuralIndex()?.getFileSummary(path)) {
          memTracker.trackSummaryGenerated(path);
        }
      }
      if (dedupResult.dedupPaths.length > 0 && input.debugProtocol) {
        input.logger.debug({
          reqId: input.requestId,
          dedupCount: dedupResult.dedupCount,
          paths: dedupResult.dedupPaths,
        }, "content_dedup_applied");
      }
    }
  }

  if (input.responseDedupeEnabled && input.yarnDedupeLayer) {
    const nextMessages = [...messages];
    for (let messageIndex = 0; messageIndex < nextMessages.length; messageIndex++) {
      const message = nextMessages[messageIndex];
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      const toolName = message.name ?? "";
      const toolInput = extractToolInputForMessage(nextMessages, messageIndex);
      try {
        const wrapped = input.yarnDedupeLayer.responseDedupe.wrapToolResult(toolName, toolInput, message.content);
        if (wrapped !== message.content) {
          nextMessages[messageIndex] = { ...message, content: wrapped };
          responseDedupHits += 1;
          input.optimizationLedger.addResponseDedupHit();
        } else {
          input.optimizationLedger.addResponseDedupMiss();
        }
      } catch (err) {
        input.logger.warn({ reqId: input.requestId, err: (err as Error).message }, "response_dedupe_bypass");
      }
    }
    if (responseDedupHits > 0) {
      messages = nextMessages;
      if (input.debugProtocol) {
        input.logger.debug({ reqId: input.requestId, hits: responseDedupHits }, "response_dedupe_applied");
      }
    }
  }

  if (input.historicalNormalizeEnabled) {
    const keepFromIdx = input.transcriptPruning.computeKeepFromIndex?.(
      messages as never,
      input.compactionBackendModelHint,
    ) ?? messages.length;
    const histResult = normalizeHistoricalContent(messages as never, keepFromIdx);
    if (histResult.stats.messagesNormalized > 0) {
      messages = histResult.messages as RouteMessage[];
      historicalNormalizedCount = histResult.stats.messagesNormalized;
      input.optimizationLedger.addHistoricalNormReplacements(
        histResult.stats.timestampsReplaced + histResult.stats.pathsNormalized,
      );
    }
    if (!input.session.skipToolIdStabilization) {
      const idResult = stabilizeToolCallIds(messages as never, keepFromIdx);
      if (idResult.rewriteCount > 0) {
        messages = idResult.messages as RouteMessage[];
        toolIdRewriteCount = idResult.rewriteCount;
        input.optimizationLedger.addToolIdRewrites(idResult.rewriteCount);
        if (input.debugProtocol) {
          input.logger.debug({ reqId: input.requestId, rewrites: idResult.rewriteCount }, "tool_id_stabilization_applied");
        }
      }
    } else {
      input.logger.warn({ reqId: input.requestId }, "tool_id_stabilization_skipped_after_missing_tool_results");
      input.session.skipToolIdStabilization = false;
    }
  }

  return {
    messages,
    readSnapshotNormalizedCount,
    contentDedupCount,
    responseDedupHits,
    historicalNormalizedCount,
    toolIdRewriteCount,
  };
}
