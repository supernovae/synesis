import { shouldIncludeStreamUsage, toOpenAiUsage } from "../openai-compat.js";
import {
  createEmptyLedger,
  extractTasksFromText,
  reconcileFromText,
  scrubTaskLedgerOutput,
  type ClientTaskCapabilities,
  type TaskLedger,
} from "../task-ledger/index.js";
import type { OpenAIStreamResponseWriter } from "./openai-stream-response-writer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";

export interface StreamTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface OpenAIStreamGateState {
  gateApplied: boolean;
  missingMust: number;
  missingShould: number;
  gateBlockedVerification: boolean;
  criticBlocked: boolean;
}

export interface OpenAIStreamFinalizerTextResult {
  finalText: string;
  applied?: boolean;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
  criticBlocked?: boolean;
}

export interface OpenAIStreamFinalizerResult extends OpenAIStreamGateState {
  usage: StreamTokenUsage;
  streamedText: string;
}

export interface OpenAIStreamFinalizerInput {
  streamState: OpenAIStreamState;
  writer: OpenAIStreamResponseWriter;
  streamed: {
    totalUsage: PromiseLike<unknown>;
    text: PromiseLike<string>;
  };
  finishReason: string;
  streamOptions: unknown;
  readUsage(input: unknown): StreamTokenUsage;
  onPendingText?(rawText: string): void;
  finalizePendingText(rawText: string): Promise<OpenAIStreamFinalizerTextResult>;
  writeFinalText(text: string): void;
  finalizeStreamedText(streamedText: string, gateState: OpenAIStreamGateState, finishReason: string): OpenAIStreamFinalizerTextResult;
  scrubHistoryText(text: string): { text: string; scrubbed: boolean };
  onHistoryText(text: string): void;
  onHistoryTextScrubbed?(): void;
  endStream(): void;
  stopHeartbeat(): void;
}

export type OpenAIStreamFinalizerFactoryInput = Omit<OpenAIStreamFinalizerInput, "streamState" | "finishReason">;

export interface OpenAIStreamFinalizerSession {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  record: {
    requestCount: number;
    sessionKey: string;
  };
  taskCapabilities: ClientTaskCapabilities | null;
  taskLedger: TaskLedger | null;
}

export interface OpenAIStreamFinalizerBuilderInput<TChecklist, TVerification, TPlanGraph> {
  writer: OpenAIStreamResponseWriter;
  streamed: {
    totalUsage: PromiseLike<unknown>;
    text: PromiseLike<string>;
  };
  streamOptions: unknown;
  readUsage(input: unknown): StreamTokenUsage;
  session: OpenAIStreamFinalizerSession;
  requestId: string;
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
    session?: OpenAIStreamFinalizerSession | null;
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
  writeFinalText(text: string): void;
  endStream(): void;
  stopHeartbeat(): void;
  onTaskLedgerOutputScrubbed(): void;
}

export function createOpenAIStreamFinalizerInput<TChecklist, TVerification, TPlanGraph>(
  input: OpenAIStreamFinalizerBuilderInput<TChecklist, TVerification, TPlanGraph>,
): OpenAIStreamFinalizerFactoryInput {
  return {
    writer: input.writer,
    streamed: input.streamed,
    streamOptions: input.streamOptions,
    readUsage: input.readUsage,
    onPendingText: (rawText) => {
      updateTaskLedgerFromStreamText(input.session, rawText);
    },
    finalizePendingText: async (rawText) => {
      const finalized = await input.finalizeCompletionText({
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        userId: input.userId,
        orgId: input.orgId,
        assistantText: rawText,
        checklist: input.checklist,
        traceRootPrompt: input.traceRootPrompt,
        latestUserPrompt: input.latestUserPrompt,
        verification: input.verification,
        recentToolNames: input.recentToolNames,
        nonActionableEventDetail: "stream stop had non-actionable text; emitted deterministic fallback",
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
    writeFinalText: input.writeFinalText,
    finalizeStreamedText: (streamedText, gateState, streamFinishReason) => input.finalizePostStreamText({
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      assistantText: streamedText,
      applyGate: gateState.gateApplied,
      checklist: input.checklist,
      traceRootPrompt: input.traceRootPrompt,
      latestUserPrompt: input.latestUserPrompt,
      verification: input.verification,
      toolStopReason: streamFinishReason === "tool_calls",
      nonActionableEventDetail: "streamed text was non-actionable; emitted deterministic fallback",
      planGraph: input.planGraph,
    }),
    scrubHistoryText: scrubTaskLedgerOutput,
    onHistoryTextScrubbed: input.onTaskLedgerOutputScrubbed,
    onHistoryText: (content) => {
      input.session.history.push({ role: "assistant", content });
    },
    endStream: input.endStream,
    stopHeartbeat: input.stopHeartbeat,
  };
}

function updateTaskLedgerFromStreamText(
  session: OpenAIStreamFinalizerSession,
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

const ZERO_USAGE: StreamTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

export async function finalizeOpenAIStreamCompletion(
  input: OpenAIStreamFinalizerInput,
): Promise<OpenAIStreamFinalizerResult> {
  const gateState: OpenAIStreamGateState = {
    gateApplied: false,
    missingMust: 0,
    missingShould: 0,
    gateBlockedVerification: false,
    criticBlocked: false,
  };

  if (input.finishReason !== "tool_calls" && input.streamState.hasPendingText()) {
    const rawText = input.streamState.drainText();
    input.onPendingText?.(rawText);
    const finalized = await input.finalizePendingText(rawText);
    gateState.gateApplied = Boolean(finalized.applied);
    gateState.missingMust = finalized.missingMust;
    gateState.missingShould = finalized.missingShould;
    gateState.gateBlockedVerification = finalized.blockedByVerification;
    gateState.criticBlocked = Boolean(finalized.criticBlocked);
    input.writeFinalText(finalized.finalText);
  }

  let usage = ZERO_USAGE;
  let streamedText = "";
  try {
    usage = input.readUsage(await input.streamed.totalUsage);
  } catch {
    /* stream aborted */
  }
  try {
    streamedText = await input.streamed.text;
  } catch {
    /* stream aborted */
  }

  input.writer.writeFinalChunk(
    input.finishReason,
    shouldIncludeStreamUsage(input.streamOptions) ? toOpenAiUsage(usage) : undefined,
  );
  input.writer.writeDoneLine();
  input.endStream();
  input.stopHeartbeat();

  if (streamedText) {
    const finalized = input.finalizeStreamedText(streamedText, gateState, input.finishReason);
    streamedText = finalized.finalText;
    const scrubbed = input.scrubHistoryText(streamedText);
    if (scrubbed.scrubbed) {
      streamedText = scrubbed.text;
      input.onHistoryTextScrubbed?.();
    }
    gateState.missingMust = finalized.missingMust;
    gateState.missingShould = finalized.missingShould;
    gateState.gateBlockedVerification = finalized.blockedByVerification;
    input.onHistoryText(streamedText);
  }

  return {
    usage,
    streamedText,
    ...gateState,
  };
}
