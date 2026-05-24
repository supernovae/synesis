import { shouldIncludeStreamUsage, toOpenAiUsage } from "../openai-compat.js";
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
