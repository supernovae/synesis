import {
  formatUpperHarnessDecisionSummary,
  type UpperHarnessDecision,
} from "./bridge.js";

export interface UpperHarnessDecisionRecorderOptions {
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventType: string,
    source: string,
    summary: string,
    requestId: string,
    metadata?: Record<string, unknown>,
  ): void;
}

export function createUpperHarnessDecisionRecorder(
  options: UpperHarnessDecisionRecorderOptions,
): (
  sessionKey: string,
  userId: string,
  orgId: string,
  requestId: string,
  source: string,
  decision: UpperHarnessDecision | undefined,
  recordOptions?: { recordAllow?: boolean },
) => void {
  return (sessionKey, userId, orgId, requestId, source, decision, recordOptions) => {
    if (!decision || (decision.action === "allow" && !recordOptions?.recordAllow)) return;
    options.recordSessionEvent(
      sessionKey,
      userId,
      orgId,
      "upper_harness_decision_v1",
      source,
      formatUpperHarnessDecisionSummary(decision),
      requestId,
      decision as unknown as Record<string, unknown>,
    );
  };
}
