import { resolveWorkspaceRootForCollapse } from "../adapters/session-execution-context.js";
import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { ToolPrefixCache } from "../tool-prefix-cache/ToolPrefixCache.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type {
  OpenAINonStreamDiscoveryGuardrailPassInput,
  OpenAINonStreamDiscoveryRecovery,
} from "./openai-nonstream-discovery-guardrails.js";
import type {
  OpenAINonStreamToolCollapseInput,
  OpenAINonStreamToolCollapseLogger,
} from "./openai-nonstream-tool-collapse.js";

export interface OpenAINonStreamDiscoveryRouteInput {
  projectRoot?: string | null;
  buildBlockedDiscoveryRecovery(
    resolvedModelId: string,
    blockedDetails: BlockedDiscoveryDetail[],
    projectRoot: string | null | undefined,
  ): Promise<OpenAINonStreamDiscoveryRecovery>;
  recordBlockedDiscovery(sessionKey: string, count: number): number;
  getBlockedDiscoveryCount(sessionKey: string): number;
}

export function createOpenAINonStreamDiscoveryRouteInput(
  input: OpenAINonStreamDiscoveryRouteInput,
): Omit<
  OpenAINonStreamDiscoveryGuardrailPassInput<GuardrailToolCall>,
  "calls" | "finalText" | "guardrail" | "recordRecoveryEvent" | "sessionKey" | "userId" | "orgId" | "requestId" | "resolvedModelId" | "recordSessionEvent"
> {
  return {
    projectRoot: input.projectRoot,
    buildBlockedDiscoveryRecovery: input.buildBlockedDiscoveryRecovery,
    recordBlockedDiscovery: input.recordBlockedDiscovery,
    getBlockedDiscoveryCount: input.getBlockedDiscoveryCount,
  };
}

export interface OpenAINonStreamCollapseRouteInput {
  enabled: boolean;
  rewriteNonStream: boolean;
  collapseHeader: unknown;
  headers: Record<string, string | string[] | undefined>;
  bodyMetadata: Record<string, unknown> | null;
  shellAllowlistEnv: string;
  dedupeLayer?: DedupeLayer | null;
  toolPrefixCache?: ToolPrefixCache | null;
  logger: OpenAINonStreamToolCollapseLogger;
  requestId: string;
}

export function createOpenAINonStreamCollapseRouteInput(
  input: OpenAINonStreamCollapseRouteInput,
): Omit<OpenAINonStreamToolCollapseInput, "calls"> {
  return {
    enabled: input.enabled,
    rewriteNonStream: input.rewriteNonStream,
    collapseHeader: input.collapseHeader,
    workspaceRoot: resolveWorkspaceRootForCollapse(input.headers, input.bodyMetadata),
    shellAllowlistEnv: input.shellAllowlistEnv,
    dedupeLayer: input.dedupeLayer,
    toolPrefixCache: input.toolPrefixCache,
    logger: input.logger,
    requestId: input.requestId,
  };
}
