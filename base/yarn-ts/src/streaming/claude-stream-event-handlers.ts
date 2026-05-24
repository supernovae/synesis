import type { AiSdkStreamEvent } from "./ai-sdk-stream-events.js";
import type { ClaudeStreamState } from "./claude-stream-state.js";

export interface ClaudeStreamLocalEventHandlerInput {
  streamState: ClaudeStreamState;
  sendSse(event: string, data: unknown): boolean;
  scrubAndFlushTextBlock(text: string): void;
}

export type ClaudeStreamLocalEvent = Exclude<
  AiSdkStreamEvent,
  Extract<AiSdkStreamEvent, { type: "tool_call" | "error" | "unknown" }>
>;

export function handleClaudeStreamLocalEvent(
  event: AiSdkStreamEvent,
  input: ClaudeStreamLocalEventHandlerInput,
): boolean {
  switch (event.type) {
    case "text_delta":
      input.streamState.appendTextDelta(event.text);
      return true;
    case "reasoning_start":
      flushPendingText(input);
      writeClaudeThinkingStart(input, event.text);
      return true;
    case "reasoning_delta":
      input.sendSse("content_block_delta", {
        type: "content_block_delta",
        index: input.streamState.currentBlockIndex(),
        delta: { type: "thinking_delta", thinking: event.text },
      });
      return true;
    case "reasoning_end":
      input.sendSse("content_block_stop", {
        type: "content_block_stop",
        index: input.streamState.currentBlockIndex(),
      });
      input.streamState.advanceBlock();
      return true;
    case "tool_input_start":
      flushPendingText(input);
      input.streamState.startToolInput(event.toolCallId, event.toolName);
      return true;
    case "tool_input_delta":
      input.streamState.appendToolInputDelta(event.toolCallId, event.inputTextDelta);
      return true;
    case "finish":
      input.streamState.markFinishFromProvider(event.finishReason);
      return true;
    case "tool_call":
    case "error":
    case "unknown":
      return false;
  }
}

function flushPendingText(input: ClaudeStreamLocalEventHandlerInput): void {
  if (!input.streamState.hasPendingText()) return;
  input.scrubAndFlushTextBlock(input.streamState.drainText());
}

function writeClaudeThinkingStart(
  input: ClaudeStreamLocalEventHandlerInput,
  text: string,
): void {
  const blockIndex = input.streamState.currentBlockIndex();
  input.sendSse("content_block_start", {
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "thinking", thinking: "" },
  });
  if (!text) return;
  input.sendSse("content_block_delta", {
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "thinking_delta", thinking: text },
  });
}
