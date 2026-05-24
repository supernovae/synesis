import type { AdapterToolHardeningResult } from "../governance/tool-call-governor-service.js";
import type { StrictGovernanceRewriteStats } from "../streaming/route-tool-call-side-effects.js";
import {
  createRouteToolCallSideEffects,
  type RouteToolCallSideEffectsLogger,
  type RouteToolCallSideEffectsSession,
} from "../streaming/route-tool-call-side-effects.js";
import {
  createOpenAIStreamRouteEventHandlers,
  type OpenAIStreamRouteEventHandlerInput,
  type OpenAIStreamRouteEventSession,
} from "../streaming/openai-stream-route-event-handlers.js";
import type { OpenAIStreamEventHandlers } from "../streaming/openai-stream-event-runner.js";
import type { StreamRouteScope } from "../streaming/stream-route-scope.js";
import type { GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";

type SideEffectKeys =
  | "updateDiffAccumulator"
  | "maybeUpdateTaskLedgerFromToolCall"
  | "emitPlanWriteAuditEvent"
  | "maybeLogEnvelopeUnwrapSample"
  | "recordUpperHarnessDecision"
  | "incrementStrictGovernanceRewrites"
  | "recordRedirectedDiscovery";

export interface OpenAIStreamRouteEventSideEffectCallbacks<TSession extends RouteToolCallSideEffectsSession> {
  updateDiffAccumulator(session: TSession, governed: GovernedToolCall): void;
  maybeUpdateTaskLedgerFromToolCall(
    session: TSession,
    toolName: string,
    input: Record<string, unknown>,
    requestCount: number,
  ): void;
  emitPlanWriteAuditEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    audit: PlanWriteAuditRecord,
  ): void;
  maybeLogEnvelopeUnwrapSample(
    logger: RouteToolCallSideEffectsLogger,
    requestId: string,
    toolName: string,
    clientKind: string,
    governed: GovernedToolCall,
    toolCallId?: string,
  ): void;
  recordUpperHarnessDecision(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    component: string,
    decision: AdapterToolHardeningResult["upperHarnessDecision"],
  ): void;
}

export interface OpenAIStreamRouteEventPipelineInput<
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
> extends Omit<OpenAIStreamRouteEventHandlerInput, SideEffectKeys | "session" | "clientKind" | "logger" | "requestId"> {
  scope: StreamRouteScope;
  session: TSession;
  clientKind: string;
  logger: OpenAIStreamRouteEventHandlerInput["logger"] & RouteToolCallSideEffectsLogger;
  strictGovernanceStats: StrictGovernanceRewriteStats;
  sideEffects: OpenAIStreamRouteEventSideEffectCallbacks<TSession>;
  recordBlockedDiscovery(sessionKey: string, count: number): void;
}

export function createOpenAIStreamRouteEventPipelineHandlers<
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
>(
  input: OpenAIStreamRouteEventPipelineInput<TSession>,
): OpenAIStreamEventHandlers {
  const sideEffects = createRouteToolCallSideEffects({
    session: input.session,
    sessionKey: input.scope.sessionKey,
    userId: input.scope.userId,
    orgId: input.scope.orgId,
    requestId: input.scope.requestId,
    clientKind: input.clientKind,
    upperHarnessComponent: "upper-harness:openai-stream",
    logger: input.logger,
    strictGovernanceStats: input.strictGovernanceStats,
    updateDiffAccumulator: input.sideEffects.updateDiffAccumulator,
    maybeUpdateTaskLedgerFromToolCall: input.sideEffects.maybeUpdateTaskLedgerFromToolCall,
    emitPlanWriteAuditEvent: input.sideEffects.emitPlanWriteAuditEvent,
    maybeLogEnvelopeUnwrapSample: input.sideEffects.maybeLogEnvelopeUnwrapSample,
    recordUpperHarnessDecision: input.sideEffects.recordUpperHarnessDecision,
  });

  return createOpenAIStreamRouteEventHandlers({
    ...input,
    requestId: input.scope.requestId,
    clientKind: input.clientKind,
    session: input.session,
    logger: input.logger,
    ...sideEffects,
    recordRedirectedDiscovery: (count) => {
      input.recordBlockedDiscovery(input.scope.sessionKey, count);
    },
  });
}
