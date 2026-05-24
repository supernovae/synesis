import { classifyAiSdkStreamPart, type AiSdkStreamEvent } from "./ai-sdk-stream-events.js";
import type { ClaudeStreamToolCallHandlerResult } from "./claude-stream-tool-call-handler.js";

type MaybePromise<T> = T | Promise<T>;

export interface ClaudeStreamingPipelineCounters {
  toolRepairs: number;
  validationFailures: number;
}

export interface ClaudeStreamingPipelineInput {
  streamParts: AsyncIterable<unknown>;
  handleLocalEvent(event: AiSdkStreamEvent): MaybePromise<boolean>;
  handleToolCall(event: Extract<AiSdkStreamEvent, { type: "tool_call" }>): MaybePromise<ClaudeStreamToolCallHandlerResult>;
  afterEvents(counters: ClaudeStreamingPipelineCounters): MaybePromise<void>;
  onEventError(error: unknown): MaybePromise<void>;
  finalizeLifecycle(): MaybePromise<string>;
}

export interface ClaudeStreamingPipelineResult extends ClaudeStreamingPipelineCounters {
  stopReason: string;
}

export async function runClaudeStreamingPipeline(
  input: ClaudeStreamingPipelineInput,
): Promise<ClaudeStreamingPipelineResult> {
  const counters: ClaudeStreamingPipelineCounters = {
    toolRepairs: 0,
    validationFailures: 0,
  };

  try {
    for await (const part of input.streamParts) {
      const event = classifyAiSdkStreamPart(part);
      if (await input.handleLocalEvent(event)) {
        continue;
      }
      if (event.type === "tool_call") {
        const handled = await input.handleToolCall(event);
        counters.toolRepairs += handled.toolRepairs;
        counters.validationFailures += handled.validationFailures;
      } else if (event.type === "error") {
        throw event.error;
      }
    }
    await input.afterEvents(counters);
  } catch (error) {
    await input.onEventError(error);
  }

  return {
    ...counters,
    stopReason: await input.finalizeLifecycle(),
  };
}
