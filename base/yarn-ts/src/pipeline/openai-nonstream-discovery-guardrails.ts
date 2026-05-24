import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { DiscoveryGuardrailRedirect } from "../tool-collapse/discovery-guardrails.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";

export interface OpenAINonStreamDiscoveryRecovery {
  text: string;
  entryCount: number;
  recoveryMode: string;
}

export interface OpenAINonStreamDiscoveryGuardrailResult<TCall extends GuardrailToolCall> {
  calls: TCall[];
  blockedCount: number;
  redirectedCount: number;
  collapsedCount: number;
  blockedDetails: BlockedDiscoveryDetail[];
  redirectedDetails: DiscoveryGuardrailRedirect[];
}

export interface OpenAINonStreamDiscoveryGuardrailPassInput<TCall extends GuardrailToolCall> {
  calls: TCall[];
  finalText: string;
  guardrail: OpenAINonStreamDiscoveryGuardrailResult<TCall>;
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  resolvedModelId: string;
  projectRoot: string | null | undefined;
  recordRecoveryEvent: boolean;
  buildBlockedDiscoveryRecovery(
    resolvedModelId: string,
    blockedDetails: BlockedDiscoveryDetail[],
    projectRoot: string | null | undefined,
  ): Promise<OpenAINonStreamDiscoveryRecovery>;
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

export interface OpenAINonStreamDiscoveryGuardrailPassResult<TCall extends GuardrailToolCall> {
  calls: TCall[];
  finalText: string;
}

export async function applyOpenAINonStreamDiscoveryGuardrailPass<TCall extends GuardrailToolCall>(
  input: OpenAINonStreamDiscoveryGuardrailPassInput<TCall>,
): Promise<OpenAINonStreamDiscoveryGuardrailPassResult<TCall>> {
  let finalText = input.finalText;

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
        ...(input.recordRecoveryEvent ? { recoveryMode: recovery.recoveryMode } : {}),
        sessionBlockedTotal,
      },
    );
    if (input.recordRecoveryEvent) {
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

  return { calls: input.guardrail.calls, finalText };
}
