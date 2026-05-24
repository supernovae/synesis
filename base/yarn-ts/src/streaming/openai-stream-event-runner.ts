import { classifyAiSdkStreamPart, type AiSdkStreamEvent } from "./ai-sdk-stream-events.js";

type MaybePromise<T> = T | Promise<T>;

export type OpenAIStreamToolCallEvent = Extract<AiSdkStreamEvent, { type: "tool_call" }> & {
  created: number;
};

export interface OpenAIStreamEventHandlers {
  onTextDelta?: (event: Extract<AiSdkStreamEvent, { type: "text_delta" }>) => MaybePromise<void>;
  onReasoningDelta?: (
    event: Extract<AiSdkStreamEvent, { type: "reasoning_start" | "reasoning_delta" }>,
  ) => MaybePromise<void>;
  onReasoningEnd?: (event: Extract<AiSdkStreamEvent, { type: "reasoning_end" }>) => MaybePromise<void>;
  onToolInputStart?: (event: Extract<AiSdkStreamEvent, { type: "tool_input_start" }>) => MaybePromise<void>;
  onToolInputDelta?: (event: Extract<AiSdkStreamEvent, { type: "tool_input_delta" }>) => MaybePromise<void>;
  onToolCall?: (event: OpenAIStreamToolCallEvent) => MaybePromise<void>;
  onFinish?: (event: Extract<AiSdkStreamEvent, { type: "finish" }>) => MaybePromise<void>;
  onUnknown?: (event: Extract<AiSdkStreamEvent, { type: "unknown" }>) => MaybePromise<void>;
}

export async function runOpenAIStreamEvents(
  parts: AsyncIterable<unknown>,
  handlers: OpenAIStreamEventHandlers,
): Promise<void> {
  for await (const part of parts) {
    const event = classifyAiSdkStreamPart(part);
    switch (event.type) {
      case "text_delta":
        await handlers.onTextDelta?.(event);
        break;
      case "reasoning_start":
      case "reasoning_delta":
        await handlers.onReasoningDelta?.(event);
        break;
      case "reasoning_end":
        await handlers.onReasoningEnd?.(event);
        break;
      case "tool_input_start":
        await handlers.onToolInputStart?.(event);
        break;
      case "tool_input_delta":
        await handlers.onToolInputDelta?.(event);
        break;
      case "tool_call":
        await handlers.onToolCall?.({
          ...event,
          created: Math.floor(Date.now() / 1000),
        });
        break;
      case "finish":
        await handlers.onFinish?.(event);
        break;
      case "error":
        throw event.error;
      case "unknown":
        await handlers.onUnknown?.(event);
        break;
    }
  }
}
