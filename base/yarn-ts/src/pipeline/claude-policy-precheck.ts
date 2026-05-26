import type { AppConfig } from "../config.js";
import type { SessionPhase, GovernorInputMessage } from "../governance/execution-governor.js";
import { applyGovernorPhaseRouteBookkeeping } from "../governance/governor-phase-route.js";
import { applyRuntimePreferenceLoopLimits } from "../runtime/user-preferences.js";
import { handleDeterministicPolicyPrecheck } from "../policy/deterministic-policy-route.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";

type PolicyAction =
  | { kind: "continue" }
  | { kind: "softFail"; content: string }
  | { kind: "reject"; decision: unknown };

type PolicyDecisionLike = {
  matchedRules: string[];
  pivotPrompt?: string | null;
};

type SessionLike = {
  record: { totalTokensIn: number };
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  toolLoopNoUserAckCount: number;
};

type RequestLike = {
  model: string;
  messages: unknown[];
  tools?: unknown[];
};

export interface ClaudePolicyPrecheckInput {
  config: Pick<
    AppConfig,
    | "SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT"
    | "SYNESIS_YARN_POLICY_HARD_REJECT_AFTER"
    | "SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT"
    | "SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT"
    | "SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT"
    | "SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS"
    | "SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS"
    | "SYNESIS_YARN_SESSION_BUDGET_MODE"
    | "SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED"
  >;
  session: SessionLike;
  sessionKey: string;
  identity: { userId: string; orgId: string };
  requestId: string;
  request: RequestLike;
  runtimePreferences: unknown;
  executionGovernor: {
    telemetry: { phase: SessionPhase };
  };
  commandLoop: {
    commandRepeatCount: number;
    broadDiscoveryRepeatCount: number;
    commandSignatureHash?: string | null;
    failureSignatureHash?: string | null;
  };
  lastToolUseId: string;
  latestUserHash: string;
  latestToolProgress: {
    hasRecentWriteSuccess: boolean;
    hasRecentFailure: boolean;
  };
  toolProgress: { state: string };
  orchestration: { selectedModel: string };
  workingPhase?: WorkflowPhase;
  orchestratorPhaseOverride?: WorkflowPhase | null;
  normalizedMessages: GovernorInputMessage[];
  distributedCounters: {
    getConsecutiveToolCalls(sessionKey: string): Promise<number | null>;
  };
  policyEngine: {
    evaluate(input: unknown): unknown;
  };
  governanceClient?: {
    getRules(): unknown;
  } | null;
  shouldStripGlobFromTools(sessionKey: string): boolean;
  stripGlobFromTools(tools?: unknown[]): { stripped: boolean; tools?: unknown[] };
  getBlockedDiscoveryCount(sessionKey: string): number;
  logWarn(record: Record<string, unknown>, message: string): void;
  withSpan<T>(name: string, attributes: Record<string, unknown>, fn: () => T): T;
  logAndPersistSafetyEvent(decision: unknown, sessionKey: string, tokensIn: number): void;
  persistSessionAndUsage(input: unknown): unknown;
  maybeCheckpoint(session: unknown): unknown;
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

export interface ClaudePolicyPrecheckResult {
  policyPrecheck: PolicyDecisionLike;
  policyAction: PolicyAction;
  clientToolInventory: unknown[];
  governorPhase: SessionPhase;
}

export async function runClaudePolicyPrecheck(
  input: ClaudePolicyPrecheckInput,
): Promise<ClaudePolicyPrecheckResult> {
  const aggressiveRepeatGuard =
    (input.commandLoop.commandRepeatCount >= 2 && Boolean(input.commandLoop.failureSignatureHash))
    || input.commandLoop.broadDiscoveryRepeatCount >= 4;
  const repeatAwarePivot = aggressiveRepeatGuard
    ? Math.max(3, Math.min(input.config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT, 6))
    : input.config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT;
  const repeatAwareHardReject = aggressiveRepeatGuard
    ? Math.max(3, Math.min(input.config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER, 4))
    : input.config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER;
  const loopLimits = applyRuntimePreferenceLoopLimits({
    consecutiveToolCallsLimit: input.config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: repeatAwarePivot,
    stagnantToolCyclesLimit: input.config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckHardLimit: input.config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: repeatAwareHardReject,
  }, input.runtimePreferences as never);
  const distToolCalls = await input.distributedCounters.getConsecutiveToolCalls(input.sessionKey);
  if (distToolCalls !== null && distToolCalls !== input.session.consecutiveToolCalls) {
    input.session.consecutiveToolCalls = distToolCalls;
  }
  const policyPrecheck = input.withSpan("yarn.policy.evaluate", { "yarn.path": "claude" }, () => input.policyEngine.evaluate({
    tools: (input.request.tools as unknown[]) ?? [],
    repeatAttempt: {
      action: "claude_messages",
      args: {
        model: input.request.model,
        lastToolUseId: input.lastToolUseId,
        messageCount: input.request.messages.length,
        latestUserHash: input.latestUserHash || "none",
        commandSignature: input.commandLoop.commandSignatureHash || "none",
        commandRepeatCount: input.commandLoop.commandRepeatCount,
        failureSignature: input.commandLoop.failureSignatureHash || "none",
      },
      fsFingerprint: input.commandLoop.commandSignatureHash
        ? `${input.commandLoop.commandSignatureHash}:${input.commandLoop.failureSignatureHash || "none"}:${input.latestUserHash || "none"}`
        : `${input.lastToolUseId || "none"}:${input.request.messages.length}:${input.latestUserHash || "none"}`,
    },
    sessionKey: input.sessionKey,
    sessionTokensIn: input.session.record.totalTokensIn,
    maxInputTokens: input.config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
    hardMaxInputTokens: input.config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    sessionBudgetMode: input.config.SYNESIS_YARN_SESSION_BUDGET_MODE,
    consecutiveToolCalls: input.session.consecutiveToolCalls,
    consecutiveToolCallsLimit: loopLimits.consecutiveToolCallsLimit,
    consecutiveToolCallsPivot: loopLimits.consecutiveToolCallsPivot,
    toolProgressState: input.latestToolProgress.hasRecentWriteSuccess
      ? "progress"
      : (input.latestToolProgress.hasRecentFailure ? "stagnant" : input.toolProgress.state),
    stagnantToolCycles: input.latestToolProgress.hasRecentWriteSuccess
      ? 0
      : (input.latestToolProgress.hasRecentFailure ? Math.max(input.session.stagnantToolCycles, 1) : input.session.stagnantToolCycles),
    stagnantToolCyclesLimit: loopLimits.stagnantToolCyclesLimit,
    toolLoopNoUserAckCount: input.session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: loopLimits.toolLoopNoUserAckHardLimit,
    hardRejectAfter: loopLimits.hardRejectAfter,
    governanceRules: input.governanceClient?.getRules(),
  })) as PolicyDecisionLike;
  const policyAction = handleDeterministicPolicyPrecheck({
    decision: policyPrecheck as never,
    softFailEnabled: input.config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED,
    session: input.session as never,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    selectedModel: input.orchestration.selectedModel,
    originalModel: input.request.model,
    latestUserHash: input.latestUserHash,
    finishReason: "end_turn",
    logSafetyEvent: input.logAndPersistSafetyEvent as never,
    persistSessionAndUsage: input.persistSessionAndUsage as never,
    maybeCheckpoint: input.maybeCheckpoint as never,
    recordSessionEvent: input.recordSessionEvent,
  }) as PolicyAction;

  const clientToolInventory = Array.isArray(input.request.tools) ? [...(input.request.tools as unknown[])] : [];
  if (input.shouldStripGlobFromTools(input.sessionKey)) {
    const globStrip = input.stripGlobFromTools(input.request.tools as unknown[] | undefined);
    if (globStrip.stripped) {
      input.request.tools = globStrip.tools;
      input.logWarn(
        {
          reqId: input.requestId,
          sessionKey: input.sessionKey,
          sessionBlockedTotal: input.getBlockedDiscoveryCount(input.sessionKey),
        },
        "proactive_glob_strip_from_tools",
      );
    }
  }
  const governorPhase = input.executionGovernor.telemetry.phase;
  applyGovernorPhaseRouteBookkeeping({
    session: input.session as never,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    governorPhase,
    workingPhase: input.workingPhase,
    orchestratorPhaseOverride: input.orchestratorPhaseOverride,
    messages: input.normalizedMessages,
    recordSessionEvent: input.recordSessionEvent,
  });

  return {
    policyPrecheck,
    policyAction,
    clientToolInventory,
    governorPhase,
  };
}
