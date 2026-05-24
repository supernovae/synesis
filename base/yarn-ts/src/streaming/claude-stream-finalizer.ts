import {
  createEmptyLedger,
  extractTasksFromText,
  reconcileFromText,
  scrubTaskLedgerOutput,
  type ClientTaskCapabilities,
  type TaskLedger,
} from "../task-ledger/index.js";
import type { ClaudeStreamGateState } from "./claude-stream-components.js";
import type { ClaudeStreamState } from "./claude-stream-state.js";
import type { OpenAIStreamFinalizerTextResult, StreamTokenUsage } from "./openai-stream-finalizer.js";

export interface ClaudeStreamFinalizerSession {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  record: {
    requestCount: number;
    sessionKey: string;
  };
  taskCapabilities: ClientTaskCapabilities | null;
  taskLedger: TaskLedger | null;
}

export interface ClaudeStreamFinalizationHandlers {
  finalizePendingText(rawText: string): Promise<OpenAIStreamFinalizerTextResult>;
  finalizeHistoryText(
    streamedText: string,
    stopReason: string,
    gateApplied: boolean,
  ): OpenAIStreamFinalizerTextResult;
}

export interface ClaudeStreamFinalizationHandlerInput<TChecklist, TVerification, TPlanGraph> {
  session: ClaudeStreamFinalizerSession;
  pendingRequestId: string;
  historyRequestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
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
    session?: ClaudeStreamFinalizerSession | null;
  }): Promise<OpenAIStreamFinalizerTextResult>;
  finalizePostStreamText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    applyGate: boolean;
    checklist: TChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: TVerification;
    toolStopReason: boolean;
    nonActionableEventDetail: string;
    planGraph?: TPlanGraph | null;
  }): OpenAIStreamFinalizerTextResult;
}

export interface ClaudeStreamCompletionFinalizerInput<TForensics> {
  streamState: ClaudeStreamState;
  gate: ClaudeStreamGateState;
  stopReason: string;
  streamed: {
    totalUsage: PromiseLike<unknown>;
    text: PromiseLike<string>;
  };
  readUsage(input: unknown): StreamTokenUsage;
  finalizeRequestForensics(usage: StreamTokenUsage): TForensics;
  handlers: ClaudeStreamFinalizationHandlers;
  writeFinalText(text: string): void;
  closeTextBlock(): void;
  writeMessageDelta(usage: StreamTokenUsage): void;
  endStream(): void;
  stopHeartbeat(): void;
  onHistoryText(text: string): void;
  onHistoryTextScrubbed(): void;
}

export interface ClaudeStreamCompletionFinalizerResult<TForensics> {
  usage: StreamTokenUsage;
  requestForensicsDone: TForensics;
  streamedText: string;
}

export function createClaudeStreamFinalizationHandlers<TChecklist, TVerification, TPlanGraph>(
  input: ClaudeStreamFinalizationHandlerInput<TChecklist, TVerification, TPlanGraph>,
): ClaudeStreamFinalizationHandlers {
  return {
    finalizePendingText: async (rawText) => {
      updateTaskLedgerFromClaudeStreamText(input.session, rawText);
      const finalized = await input.finalizeCompletionText({
        requestId: input.pendingRequestId,
        sessionKey: input.sessionKey,
        userId: input.userId,
        orgId: input.orgId,
        assistantText: rawText,
        checklist: input.checklist,
        traceRootPrompt: input.traceRootPrompt,
        latestUserPrompt: input.latestUserPrompt,
        verification: input.verification,
        recentToolNames: input.recentToolNames,
        nonActionableEventDetail: "claude stream stop had non-actionable text; emitted deterministic fallback",
        planGraph: input.planGraph,
        session: input.session,
      });
      return {
        ...finalized,
        finalText: input.applyMarkdownGuardrail(
          finalized.finalText,
          input.responseStyleMode,
        ),
      };
    },
    finalizeHistoryText: (streamedText, stopReason, gateApplied) => input.finalizePostStreamText({
      requestId: input.historyRequestId,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      assistantText: streamedText,
      applyGate: gateApplied,
      checklist: input.checklist,
      traceRootPrompt: input.traceRootPrompt,
      latestUserPrompt: input.latestUserPrompt,
      verification: input.verification,
      toolStopReason: stopReason === "tool_use",
      nonActionableEventDetail: "claude streamed text was non-actionable; emitted deterministic fallback",
      planGraph: input.planGraph,
    }),
  };
}

const ZERO_USAGE: StreamTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

export async function finalizeClaudeStreamCompletion<TForensics>(
  input: ClaudeStreamCompletionFinalizerInput<TForensics>,
): Promise<ClaudeStreamCompletionFinalizerResult<TForensics>> {
  if (input.stopReason !== "tool_use" && input.streamState.hasPendingText()) {
    const rawText = input.streamState.drainText();
    const finalized = await input.handlers.finalizePendingText(rawText);
    input.gate.applied = Boolean(finalized.applied);
    input.gate.missingMust = finalized.missingMust;
    input.gate.missingShould = finalized.missingShould;
    input.gate.blockedVerification = finalized.blockedByVerification;
    input.gate.criticBlocked = Boolean(finalized.criticBlocked);
    input.writeFinalText(finalized.finalText);
  }

  input.closeTextBlock();

  let usage = ZERO_USAGE;
  try {
    usage = input.readUsage(await input.streamed.totalUsage);
  } catch {
    /* stream aborted */
  }
  const requestForensicsDone = input.finalizeRequestForensics(usage);
  input.writeMessageDelta(usage);
  input.endStream();
  input.stopHeartbeat();

  let streamedText = "";
  try {
    streamedText = await input.streamed.text;
  } catch {
    /* stream aborted */
  }
  if (streamedText) {
    const finalized = input.handlers.finalizeHistoryText(
      streamedText,
      input.stopReason,
      input.gate.applied,
    );
    streamedText = finalized.finalText;
    const scrubbed = scrubTaskLedgerOutput(streamedText);
    if (scrubbed.scrubbed) {
      streamedText = scrubbed.text;
      input.onHistoryTextScrubbed();
    }
    input.gate.missingMust = finalized.missingMust;
    input.gate.missingShould = finalized.missingShould;
    input.gate.blockedVerification = finalized.blockedByVerification;
    input.onHistoryText(streamedText);
  }

  return {
    usage,
    requestForensicsDone,
    streamedText,
  };
}

function updateTaskLedgerFromClaudeStreamText(
  session: ClaudeStreamFinalizerSession,
  rawText: string,
): void {
  if (!session.taskCapabilities || !rawText) return;
  const tasks = extractTasksFromText(
    rawText,
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
