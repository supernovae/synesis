import {
  createEmptyLedger,
  extractTasksFromText,
  reconcileFromText,
  scrubTaskLedgerOutput,
  type ClientTaskCapabilities,
  type TaskLedger,
} from "../task-ledger/index.js";
import { guardModelOutputText } from "../security/model-output-guard.js";
import type { OpenAIStreamFinalizerTextResult } from "../streaming/openai-stream-finalizer.js";

export interface OpenAINonStreamFinalizerSession {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  record: {
    requestCount: number;
    sessionKey: string;
  };
  taskCapabilities: ClientTaskCapabilities | null;
  taskLedger: TaskLedger | null;
}

export interface OpenAINonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph> {
  session: OpenAINonStreamFinalizerSession;
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  finishReason: string;
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
    session?: OpenAINonStreamFinalizerSession | null;
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

export interface OpenAINonStreamFinalizerResult {
  finalText: string;
  gateApplied: boolean;
  missingMust: number;
  missingShould: number;
  gateBlockedVerification: boolean;
  criticBlocked: boolean;
}

export async function finalizeOpenAINonStreamText<TChecklist, TVerification, TPlanGraph>(
  input: OpenAINonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph>,
): Promise<OpenAINonStreamFinalizerResult> {
  let finalText = input.applyMarkdownGuardrail(input.assistantText, input.responseStyleMode);
  let gateApplied = false;
  let missingMust = 0;
  let missingShould = 0;
  let gateBlockedVerification = false;
  let criticBlocked = false;

  if (input.finishReason === "stop") {
    updateTaskLedgerFromText(input.session, finalText);
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
      nonActionableEventDetail: "terminal stop had non-actionable text; emitted deterministic fallback",
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

  const scrubbed = scrubTaskLedgerOutput(finalText);
  if (scrubbed.scrubbed) {
    finalText = scrubbed.text;
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "task_ledger_output_scrubbed",
      "task-ledger",
      "Removed internal task-ledger governance from OpenAI response",
      input.requestId,
    );
  }
  finalText = guardModelOutputText(finalText, "openai_nonstream_output", (event) => {
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      event.eventKind,
      event.component,
      event.detail,
      input.requestId,
    );
  }).text;
  input.session.history.push({ role: "assistant", content: finalText });

  return {
    finalText,
    gateApplied,
    missingMust,
    missingShould,
    gateBlockedVerification,
    criticBlocked,
  };
}

function updateTaskLedgerFromText(
  session: OpenAINonStreamFinalizerSession,
  text: string,
): void {
  if (!session.taskCapabilities || !text) return;
  const tasks = extractTasksFromText(
    text,
    session.taskCapabilities.detectedSource,
    session.record.requestCount,
  );
  if (tasks.length === 0) return;
  if (!session.taskLedger) {
    session.taskLedger = createEmptyLedger(
      session.record.sessionKey,
      session.taskCapabilities.hasExplicitTodoTool,
      session.taskCapabilities.hasExplicitPlanMode,
    );
  }
  session.taskLedger = reconcileFromText(session.taskLedger, tasks, session.record.requestCount);
}
