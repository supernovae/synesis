import { scrubTaskLedgerOutput } from "../task-ledger/index.js";
import type { OpenAIStreamFinalizerTextResult } from "./openai-stream-finalizer.js";

export interface ClaudeNonStreamFinalizerSession {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
}

export interface ClaudeNonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph> {
  session: ClaudeNonStreamFinalizerSession;
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  stopReason: string;
  assistantText: string;
  checklist: TChecklist | null;
  traceRootPrompt: string;
  latestUserPrompt: string;
  verification: TVerification;
  recentToolNames: string[];
  planGraph?: TPlanGraph | null;
  responseStyleMode: string;
  applyMarkdownGuardrail(text: string, mode: string): string;
  finalizeCompletionText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    checklist: TChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: TVerification;
    recentToolNames: string[];
    nonActionableEventDetail: string;
    planGraph?: TPlanGraph | null;
    session?: ClaudeNonStreamFinalizerSession | null;
  }): Promise<OpenAIStreamFinalizerTextResult>;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId: string,
  ): void;
}

export interface ClaudeNonStreamFinalizerResult {
  finalText: string;
  gateApplied: boolean;
  missingMust: number;
  missingShould: number;
  gateBlockedVerification: boolean;
  criticBlocked: boolean;
}

export async function finalizeClaudeNonStreamText<TChecklist, TVerification, TPlanGraph>(
  input: ClaudeNonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph>,
): Promise<ClaudeNonStreamFinalizerResult> {
  let finalText = input.assistantText;
  let gateApplied = false;
  let missingMust = 0;
  let missingShould = 0;
  let gateBlockedVerification = false;
  let criticBlocked = false;

  if (input.stopReason === "end_turn") {
    const finalized = await input.finalizeCompletionText({
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      assistantText: finalText,
      checklist: input.checklist,
      traceRootPrompt: input.traceRootPrompt,
      latestUserPrompt: input.latestUserPrompt,
      verification: input.verification,
      recentToolNames: input.recentToolNames,
      nonActionableEventDetail: "terminal end_turn had non-actionable text; emitted deterministic fallback",
      planGraph: input.planGraph,
      session: input.session,
    });
    finalText = finalized.finalText;
    gateApplied = Boolean(finalized.applied);
    missingMust = finalized.missingMust;
    missingShould = finalized.missingShould;
    gateBlockedVerification = finalized.blockedByVerification;
    criticBlocked = Boolean(finalized.criticBlocked);
  }

  finalText = input.applyMarkdownGuardrail(finalText, input.responseStyleMode);
  const scrubbed = scrubTaskLedgerOutput(finalText);
  if (scrubbed.scrubbed) {
    finalText = scrubbed.text;
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "task_ledger_output_scrubbed",
      "task-ledger",
      "Removed internal task-ledger governance from Claude response",
      input.requestId,
    );
  }
  if (finalText) {
    input.session.history.push({ role: "assistant", content: finalText });
  }

  return {
    finalText,
    gateApplied,
    missingMust,
    missingShould,
    gateBlockedVerification,
    criticBlocked,
  };
}
