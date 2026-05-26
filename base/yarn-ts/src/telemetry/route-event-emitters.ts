import type { AppConfig } from "../config.js";
import type { PolicyDecision, PolicyEvent } from "../policy/deterministic-policy-engine.js";
import type { PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { DecisionSnapshot } from "./decision-snapshot.js";
import type { SafetyEventInsert } from "../state/usage-writer.js";

type RecordSessionEventFn = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId?: string,
  metadataJson?: Record<string, unknown>,
) => void;

export interface RouteEventEmitters {
  logAndPersistSafetyEvent(decision: PolicyDecision, sessionKey: string, sessionTokensIn: number): void;
  emitPlanWriteAuditEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    audit: PlanWriteAuditRecord,
  ): void;
  emitDecisionEvents(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    snapshot: DecisionSnapshot | undefined,
  ): void;
}

export function createRouteEventEmitters(input: {
  config: Pick<AppConfig, "SYNESIS_YARN_DECISION_MATRIX_ENABLED" | "SYNESIS_YARN_SENSEMAKING_ENABLED">;
  policyEvents: { getRecentEvents(): PolicyEvent[] };
  usageWriter: { enqueueSafetyEventInsert(event: SafetyEventInsert): void };
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
  recordSessionEvent: RecordSessionEventFn;
}): RouteEventEmitters {
  function logAndPersistSafetyEvent(
    _decision: PolicyDecision,
    sessionKey: string,
    sessionTokensIn: number,
  ): void {
    for (const event of input.policyEvents.getRecentEvents().slice(-1)) {
      input.logger.warn({
        safetyEvent: event.kind,
        sessionKey,
        detail: event.detail,
        repeatCount: event.repeatCount,
        tokensBurned: event.tokensBurned ?? sessionTokensIn,
        consecutiveToolCalls: event.consecutiveToolCalls,
      }, `policy_safety_event: ${event.kind}`);
      input.usageWriter.enqueueSafetyEventInsert({
        sessionKey,
        userId: "",
        orgId: "",
        eventKind: event.kind,
        detail: event.detail,
        repeatCount: event.repeatCount,
        tokensBurned: event.tokensBurned ?? sessionTokensIn,
        consecutiveToolCalls: event.consecutiveToolCalls,
      });
    }
  }

  function emitPlanWriteAuditEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    audit: PlanWriteAuditRecord,
  ): void {
    const eventKind = audit.allowed ? "plan_file_write_allowed" : "plan_file_write_blocked";
    input.recordSessionEvent(
      sessionKey,
      userId,
      orgId,
      eventKind,
      "tool_call_governance",
      audit.reason ?? "ok",
      requestId,
      {
        path: audit.path,
        allowed: audit.allowed,
        reason: audit.reason,
        proposedContentHash: audit.proposedContentHash,
        shadowContentHash: audit.shadowContentHash,
      },
    );
  }

  function emitDecisionEvents(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    snapshot: DecisionSnapshot | undefined,
  ): void {
    if (!snapshot || !input.config.SYNESIS_YARN_DECISION_MATRIX_ENABLED) return;
    input.recordSessionEvent(sessionKey, userId, orgId, "decision_routing", "phase-model-orchestrator",
      `${snapshot.decisionPath} → ${snapshot.tier} (${snapshot.phase})`, requestId, {
        decisionPath: snapshot.decisionPath,
        tier: snapshot.tier,
        phase: snapshot.phase,
        escalated: snapshot.escalated,
        recallRouting: snapshot.recallRouting,
        recallConfidence: snapshot.recallConfidence,
      });
    if (snapshot.escalated) {
      input.recordSessionEvent(sessionKey, userId, orgId, "escalation", "phase-model-orchestrator",
        snapshot.escalationReason ?? "escalated", requestId, {
          tier: snapshot.tier,
          phase: snapshot.phase,
          recallRouting: snapshot.recallRouting,
          verificationRound: snapshot.verificationRound,
          verificationStalled: snapshot.verificationStalled,
        });
    }
    if (snapshot.sensemakingTriggered && input.config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
      input.recordSessionEvent(sessionKey, userId, orgId, "sensemaking_triggered", "sensemaking-engine",
        snapshot.sensemakingReason ?? "sensemaking", requestId, {
          phase: snapshot.phase,
          decisionPath: snapshot.decisionPath,
          reason: snapshot.sensemakingReason,
        });
    }
  }

  return {
    logAndPersistSafetyEvent,
    emitPlanWriteAuditEvent,
    emitDecisionEvents,
  };
}
