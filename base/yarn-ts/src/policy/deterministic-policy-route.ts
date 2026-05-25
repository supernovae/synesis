import type { PolicyDecision } from "./deterministic-policy-engine.js";

export interface DeterministicPolicyRouteSession {
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  record: { totalTokensIn: number };
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
}

export interface DeterministicPolicyRouteIdentity {
  userId: string;
  orgId: string;
}

export type DeterministicPolicyRouteAction =
  | { kind: "continue" }
  | { kind: "reject"; decision: PolicyDecision }
  | { kind: "softFail"; content: string; eventType: "tool_loop_soft_fail" | "repeat_loop_soft_fail" };

export interface DeterministicPolicyRouteInput<TSession extends DeterministicPolicyRouteSession> {
  decision: PolicyDecision;
  softFailEnabled: boolean;
  session: TSession;
  sessionKey: string;
  identity: DeterministicPolicyRouteIdentity;
  requestId: string;
  selectedModel: string;
  originalModel: string;
  latestUserHash: string;
  finishReason: string;
  logSafetyEvent: (decision: PolicyDecision, sessionKey: string, sessionTokensIn: number) => void;
  persistSessionAndUsage: (input: {
    state: TSession;
    requestId: string;
    resolvedModelId: string;
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number };
    latencyMs: number;
    finishReason: string;
    tokensSavedByReduction?: number;
    escalated?: boolean;
    clientRequestedModel?: string;
  }) => void;
  maybeCheckpoint: (session: TSession) => void;
  recordSessionEvent: (
    sessionKey: string,
    userId: string,
    orgId: string,
    eventType: string,
    source: string,
    summary: string,
    requestId: string,
  ) => void;
}

export function toolLoopSoftFailMessage(decision: PolicyDecision): string {
  const reason = decision.rejectReason ?? "Tool loop policy triggered before another automated action.";
  return [
    "I paused automated tool execution to avoid getting stuck in a repair loop.",
    reason,
    "If you want me to continue, share one adjustment (for example: install missing local tools, choose a different command, or confirm a narrower fix strategy) and I will resume from here.",
  ].join(" ");
}

export function repeatLoopSoftFailMessage(decision: PolicyDecision): string {
  const reason = decision.rejectReason ?? "Repeated request fingerprint detected without progress.";
  return [
    "I paused this turn because the same request pattern keeps replaying, so continuing automatically is unlikely to make progress.",
    reason,
    "Next step: start a new chat/session (not Resume) and ask me to recover from current files, summarize the last failure, propose two alternatives, then execute one.",
  ].join(" ");
}

export function handleDeterministicPolicyPrecheck<TSession extends DeterministicPolicyRouteSession>(
  input: DeterministicPolicyRouteInput<TSession>,
): DeterministicPolicyRouteAction {
  if (input.decision.allow) {
    return { kind: "continue" };
  }

  input.logSafetyEvent(input.decision, input.sessionKey, input.session.record.totalTokensIn);

  if (input.softFailEnabled && input.decision.softFailClass === "tool_loop") {
    return persistSoftFail(input, {
      content: toolLoopSoftFailMessage(input.decision),
      eventType: "tool_loop_soft_fail",
      eventFallbackSummary: "Tool loop soft fail",
      updateAckState: true,
    });
  }

  if (input.decision.matchedRules.includes("repeat_loop_hard_reject")) {
    return persistSoftFail(input, {
      content: repeatLoopSoftFailMessage(input.decision),
      eventType: "repeat_loop_soft_fail",
      eventFallbackSummary: "Repeat loop soft fail",
      updateAckState: false,
    });
  }

  return { kind: "reject", decision: input.decision };
}

function persistSoftFail<TSession extends DeterministicPolicyRouteSession>(
  input: DeterministicPolicyRouteInput<TSession>,
  softFail: {
    content: string;
    eventType: "tool_loop_soft_fail" | "repeat_loop_soft_fail";
    eventFallbackSummary: string;
    updateAckState: boolean;
  },
): DeterministicPolicyRouteAction {
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };

  if (softFail.updateAckState) {
    input.session.awaitingToolLoopUserAck = true;
    input.session.toolLoopAckAnchorUserHash = input.latestUserHash;
    input.session.toolLoopNoUserAckCount = 0;
  }

  input.session.history.push({ role: "assistant", content: softFail.content });
  input.persistSessionAndUsage({
    state: input.session,
    requestId: input.requestId,
    resolvedModelId: input.selectedModel,
    usage,
    latencyMs: Date.now() - started,
    finishReason: input.finishReason,
    tokensSavedByReduction: 0,
    escalated: false,
    clientRequestedModel: input.originalModel,
  });
  input.maybeCheckpoint(input.session);
  input.recordSessionEvent(
    input.sessionKey,
    input.identity.userId,
    input.identity.orgId,
    softFail.eventType,
    "deterministic-policy",
    input.decision.rejectReason ?? softFail.eventFallbackSummary,
    input.requestId,
  );
  return { kind: "softFail", content: softFail.content, eventType: softFail.eventType };
}
