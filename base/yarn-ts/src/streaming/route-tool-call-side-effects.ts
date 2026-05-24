import type { AdapterToolHardeningResult } from "../governance/tool-call-governor-service.js";
import type { GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";

export interface RouteToolCallSideEffectsSession {
  record: {
    requestCount: number;
  };
}

export interface StrictGovernanceRewriteStats {
  strictGovernanceRewrites: number;
}

export interface RouteToolCallSideEffectsLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

export interface RouteToolCallSideEffectsInput<TSession extends RouteToolCallSideEffectsSession> {
  session: TSession;
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  clientKind: string;
  upperHarnessComponent: string;
  logger: RouteToolCallSideEffectsLogger;
  strictGovernanceStats: StrictGovernanceRewriteStats;
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

export interface RouteToolCallSideEffects {
  updateDiffAccumulator(governed: GovernedToolCall): void;
  maybeUpdateTaskLedgerFromToolCall(toolName: string, input: Record<string, unknown>, requestCount: number): void;
  emitPlanWriteAuditEvent(audit: PlanWriteAuditRecord): void;
  maybeLogEnvelopeUnwrapSample(toolName: string, governed: GovernedToolCall, toolCallId: string): void;
  recordUpperHarnessDecision(decision: AdapterToolHardeningResult["upperHarnessDecision"]): void;
  incrementStrictGovernanceRewrites(count: number): void;
}

export function createRouteToolCallSideEffects<TSession extends RouteToolCallSideEffectsSession>(
  input: RouteToolCallSideEffectsInput<TSession>,
): RouteToolCallSideEffects {
  return {
    updateDiffAccumulator: (governed) => {
      input.updateDiffAccumulator(input.session, governed);
    },
    maybeUpdateTaskLedgerFromToolCall: (toolName, toolInput, requestCount) => {
      input.maybeUpdateTaskLedgerFromToolCall(input.session, toolName, toolInput, requestCount);
    },
    emitPlanWriteAuditEvent: (audit) => {
      input.emitPlanWriteAuditEvent(input.sessionKey, input.userId, input.orgId, input.requestId, audit);
    },
    maybeLogEnvelopeUnwrapSample: (toolName, governed, toolCallId) => {
      input.maybeLogEnvelopeUnwrapSample(
        input.logger,
        input.requestId,
        toolName,
        input.clientKind,
        governed,
        toolCallId,
      );
    },
    recordUpperHarnessDecision: (decision) => {
      input.recordUpperHarnessDecision(
        input.sessionKey,
        input.userId,
        input.orgId,
        input.requestId,
        input.upperHarnessComponent,
        decision,
      );
    },
    incrementStrictGovernanceRewrites: (count) => {
      input.strictGovernanceStats.strictGovernanceRewrites += count;
    },
  };
}
