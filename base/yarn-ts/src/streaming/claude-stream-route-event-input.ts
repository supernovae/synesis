import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { ClaudeStreamRequestForensicsResult } from "./claude-stream-telemetry.js";
import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { ClaudeStreamRouteRunInput } from "./claude-stream-route-orchestrator.js";
import type { OpenAIStreamToolCallRecovery } from "./openai-stream-tool-call-handler.js";
import type { RouteToolCallSideEffects } from "./route-tool-call-side-effects.js";

type ClaudeStreamRouteEventHandlersInput = ClaudeStreamRouteRunInput<
  ClaudeStreamProviderMessage,
  ClaudeStreamRequestForensicsResult | null | undefined,
  unknown,
  unknown,
  unknown
>["pipeline"]["eventHandlers"];

export interface ClaudeStreamRouteEventHandlersBuilderInput {
  base: Omit<
    ClaudeStreamRouteEventHandlersInput,
    | keyof RouteToolCallSideEffects
    | "recentToolNames"
    | "normalizedMessageCount"
    | "recordRedirectedDiscovery"
    | "buildBlockedDiscoveryRecovery"
  >;
  toolSideEffects: RouteToolCallSideEffects;
  recentCalls: Array<{ toolName: string }>;
  normalizedMessages: Array<{ role: string }>;
  route: {
    sessionKey: string;
    resolvedModelId: string;
    projectRoot?: string | null;
  };
  recordBlockedDiscovery(sessionKey: string, count: number): void;
  buildBlockedDiscoveryRecoverySnapshot(
    model: string,
    blockedDetails: BlockedDiscoveryDetail[],
    projectRoot?: string | null,
  ): Promise<OpenAIStreamToolCallRecovery>;
}

export function buildClaudeStreamRouteEventHandlersInput(
  input: ClaudeStreamRouteEventHandlersBuilderInput,
): ClaudeStreamRouteEventHandlersInput {
  return {
    ...input.base,
    ...input.toolSideEffects,
    recentToolNames: input.recentCalls.map((call) => call.toolName),
    normalizedMessageCount: input.normalizedMessages.length,
    recordRedirectedDiscovery: (count) => {
      input.recordBlockedDiscovery(input.route.sessionKey, count);
    },
    buildBlockedDiscoveryRecovery: (blockedDetails: BlockedDiscoveryDetail[]) =>
      input.buildBlockedDiscoveryRecoverySnapshot(
        input.route.resolvedModelId,
        blockedDetails,
        input.route.projectRoot,
      ),
  };
}
