import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { DiscoveryGuardrailRedirect, GuardrailToolCall } from "../tool-collapse/discovery-guardrails.js";

export interface ClaudeNonStreamDiscoveryRecovery {
  text: string;
  entryCount: number;
  recoveryMode: string;
}

export interface ClaudeNonStreamDiscoveryGuardrailResult<TCall extends GuardrailToolCall> {
  calls: TCall[];
  blockedCount: number;
  redirectedCount: number;
  collapsedCount: number;
  blockedDetails: BlockedDiscoveryDetail[];
  redirectedDetails: DiscoveryGuardrailRedirect[];
}

export interface ClaudeNonStreamDiscoveryInput<TCall extends GuardrailToolCall> {
  calls: TCall[];
  finalText: string;
  stopReason: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  resolvedModelId: string;
  projectRoot: string | null | undefined;
  getTopLevelDirs(projectRoot: string | null | undefined): Promise<string[]>;
  applyDiscoveryGuardrail(calls: TCall[], topLevelDirs: string[]): ClaudeNonStreamDiscoveryGuardrailResult<TCall>;
  buildBlockedDiscoveryRecovery(
    resolvedModelId: string,
    blockedDetails: BlockedDiscoveryDetail[],
    projectRoot: string | null | undefined,
  ): Promise<ClaudeNonStreamDiscoveryRecovery>;
  recordBlockedDiscovery(sessionKey: string, count: number): number;
  getBlockedDiscoveryCount(sessionKey: string): number;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId: string,
    metadataJson?: Record<string, unknown>,
  ): void;
}

export interface ClaudeNonStreamDiscoveryResult<TCall extends GuardrailToolCall> {
  calls: TCall[];
  finalText: string;
  stopReason: string;
}

export async function applyClaudeNonStreamDiscoveryGuardrails<TCall extends GuardrailToolCall>(
  input: ClaudeNonStreamDiscoveryInput<TCall>,
): Promise<ClaudeNonStreamDiscoveryResult<TCall>> {
  const topLevelDirs = await input.getTopLevelDirs(input.projectRoot);
  let calls = input.calls;
  let finalText = input.finalText;
  let stopReason = input.stopReason;

  const firstPass = input.applyDiscoveryGuardrail(calls, topLevelDirs);
  calls = firstPass.calls;
  const firstPassResult = await recordGuardrailPass({
    ...input,
    guardrail: firstPass,
    calls,
    finalText,
    stopReason,
    updateStopReasonAfterBlocked: false,
  });
  finalText = firstPassResult.finalText;
  stopReason = firstPassResult.stopReason;

  const legacyPass = input.applyDiscoveryGuardrail(calls, topLevelDirs);
  calls = legacyPass.calls;
  const legacyResult = await recordGuardrailPass({
    ...input,
    guardrail: legacyPass,
    calls,
    finalText,
    stopReason,
    updateStopReasonAfterBlocked: true,
  });

  return {
    calls,
    finalText: legacyResult.finalText,
    stopReason: legacyResult.stopReason,
  };
}

async function recordGuardrailPass<TCall extends GuardrailToolCall>(
  input: ClaudeNonStreamDiscoveryInput<TCall> & {
    guardrail: ClaudeNonStreamDiscoveryGuardrailResult<TCall>;
    calls: TCall[];
    finalText: string;
    stopReason: string;
    updateStopReasonAfterBlocked: boolean;
  },
): Promise<{ finalText: string; stopReason: string }> {
  let finalText = input.finalText;
  let stopReason = input.stopReason;

  if (input.guardrail.redirectedCount > 0) {
    input.recordBlockedDiscovery(input.sessionKey, input.guardrail.redirectedCount);
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "broad_discovery_redirected",
      "tool-guardrails",
      `redirected=${input.guardrail.redirectedCount};sessionTotal=${input.getBlockedDiscoveryCount(input.sessionKey)}`,
      input.requestId,
      {
        redirectedDetails: input.guardrail.redirectedDetails.slice(0, 5),
        sessionBlockedTotal: input.getBlockedDiscoveryCount(input.sessionKey),
      },
    );
  }

  if (input.guardrail.blockedCount > 0) {
    const sessionBlockedTotal = input.recordBlockedDiscovery(input.sessionKey, input.guardrail.blockedCount);
    const recovery = await input.buildBlockedDiscoveryRecovery(
      input.resolvedModelId,
      input.guardrail.blockedDetails,
      input.projectRoot,
    );
    finalText = [
      finalText.trim(),
      recovery.text,
    ].filter(Boolean).join("\n\n");
    if (sessionBlockedTotal >= 2) {
      finalText += "\n\nCRITICAL: Glob has been blocked multiple times in this session. The Glob tool will be removed from your available tools. Use Read and Grep instead.";
    }
    if (input.updateStopReasonAfterBlocked) {
      stopReason = input.calls.length > 0 ? "tool_use" : "end_turn";
    }
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "tool_call_blocked_broad_discovery",
      "tool-guardrails",
      `blocked=${input.guardrail.blockedCount};sessionTotal=${sessionBlockedTotal}`,
      input.requestId,
      {
        blockedDetails: input.guardrail.blockedDetails.slice(0, 5),
        recoveryMode: recovery.recoveryMode,
        sessionBlockedTotal,
      },
    );
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "blocked_broad_discovery_then_recovery",
      "tool-guardrails",
      `mode=${recovery.recoveryMode};top_level_preview=${recovery.entryCount}`,
      input.requestId,
      { recoveryMode: recovery.recoveryMode, topLevelPreview: recovery.entryCount },
    );
  }

  if (input.guardrail.collapsedCount > 0) {
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "duplicate_broad_call_collapsed",
      "tool-guardrails",
      `collapsed=${input.guardrail.collapsedCount}`,
      input.requestId,
    );
  }

  return { finalText, stopReason };
}
