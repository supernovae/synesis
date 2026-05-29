import {
  annotateCacheBreakpoints,
  detectCacheStrategy,
  type CacheStrategy,
} from "../context/provider-cache-hints.js";
import { scrubTaskLedgerOutput } from "../task-ledger/index.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import { ClaudeStreamState } from "./claude-stream-state.js";

export interface ClaudeStreamComponentsInput {
  modelMessages: Array<{ role: string; content: unknown }>;
  tierConfig?: {
    baseUrl?: string;
    backendModel?: string;
    modelCapabilityPreset?: string | null;
  };
  resolvedModelId: string;
  computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  sendSse(event: string, data: unknown): boolean;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
}

export interface ClaudeStreamRouteComponentsInput {
  modelMessages: Array<{ role: string; content: unknown }>;
  tierConfig?: {
    baseUrl?: string;
    backendModel?: string;
    modelCapabilityPreset?: string | null;
  };
  resolvedModelId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  sendSse(event: string, data: unknown): boolean;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId: string,
  ): void;
}

export interface ClaudeStreamGateState {
  applied: boolean;
  missingMust: number;
  missingShould: number;
  blockedVerification: boolean;
  criticBlocked: boolean;
}

export interface ClaudeStreamDiscoveryState {
  recoveryPreviewEntries: number;
  recoveryMode: string | null;
  blockedBroadDiscovery: number;
  collapsedBroadDiscovery: number;
}

export interface ClaudeStreamComponents {
  streamState: ClaudeStreamState;
  modelMessages: Array<{ role: string; content: unknown }>;
  gate: ClaudeStreamGateState;
  guardrailAccepted: GuardrailToolCall[];
  blockedDetails: BlockedDiscoveryDetail[];
  discovery: ClaudeStreamDiscoveryState;
  toolSequence: string[];
  tierConfig?: {
    baseUrl?: string;
    backendModel?: string;
  };
  localLikeBaseUrl: boolean;
  cacheStrategy: CacheStrategy;
  prefixFingerprint: string | undefined;
  closeTextBlock(): void;
  flushTextBlock(text: string): void;
  scrubAndFlushTextBlock(text: string): void;
}

export function createClaudeStreamComponents(
  input: ClaudeStreamComponentsInput,
): ClaudeStreamComponents {
  const streamState = new ClaudeStreamState();
  const cacheStrategy = detectCacheStrategy(
    input.tierConfig?.baseUrl ?? "",
    input.tierConfig?.backendModel ?? input.resolvedModelId,
    input.tierConfig?.modelCapabilityPreset,
  );
  const modelMessages = maybeAnnotateCacheBreakpoints(input.modelMessages, cacheStrategy);

  const flushTextBlock = (text: string): void => {
    if (!text) return;
    const blockIndex = streamState.currentBlockIndex();
    input.sendSse("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
    input.sendSse("content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text },
    });
    input.sendSse("content_block_stop", { type: "content_block_stop", index: blockIndex });
    streamState.advanceBlock();
  };

  return {
    streamState,
    modelMessages,
    gate: {
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedVerification: false,
      criticBlocked: false,
    },
    guardrailAccepted: [],
    blockedDetails: [],
    discovery: {
      recoveryPreviewEntries: 0,
      recoveryMode: null,
      blockedBroadDiscovery: 0,
      collapsedBroadDiscovery: 0,
    },
    toolSequence: [],
    tierConfig: input.tierConfig,
    localLikeBaseUrl: isLocalLikeBaseUrl(input.tierConfig?.baseUrl),
    cacheStrategy,
    prefixFingerprint: input.computePrefixFingerprint(modelMessages),
    closeTextBlock: () => {
      const blockIndex = streamState.closeTextBlock();
      if (blockIndex === null) return;
      input.sendSse("content_block_stop", { type: "content_block_stop", index: blockIndex });
    },
    flushTextBlock,
    scrubAndFlushTextBlock: (text) => {
      const scrubbed = scrubTaskLedgerOutput(text);
      if (scrubbed.scrubbed) {
        input.recordSessionEvent({
          eventKind: "task_ledger_output_scrubbed",
          component: "task-ledger",
          detail: "Removed internal task-ledger governance from streamed Claude output",
        });
      }
      flushTextBlock(scrubbed.text);
    },
  };
}

export function createClaudeStreamRouteComponents(
  input: ClaudeStreamRouteComponentsInput,
): ClaudeStreamComponents {
  return createClaudeStreamComponents({
    modelMessages: input.modelMessages,
    tierConfig: input.tierConfig,
    resolvedModelId: input.resolvedModelId,
    computePrefixFingerprint: input.computePrefixFingerprint,
    sendSse: input.sendSse,
    recordSessionEvent: (event) => input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      event.eventKind,
      event.component,
      event.detail,
      input.requestId,
    ),
  });
}

function maybeAnnotateCacheBreakpoints(
  modelMessages: Array<{ role: string; content: unknown }>,
  cacheStrategy: CacheStrategy,
): Array<{ role: string; content: unknown }> {
  if (cacheStrategy !== "anthropic_explicit") return modelMessages;
  return annotateCacheBreakpoints(modelMessages, "anthropic_explicit").messages;
}

function isLocalLikeBaseUrl(baseUrl: string | undefined): boolean {
  return !!baseUrl
    && (
      baseUrl.includes(".svc.cluster.local")
      || baseUrl.includes("localhost")
      || baseUrl.includes("127.0.0.1")
    );
}
