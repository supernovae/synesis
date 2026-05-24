import type { OpenAIStreamEventHandlers } from "./openai-stream-event-runner.js";
import { runOpenAIStreamEvents } from "./openai-stream-event-runner.js";
import {
  finalizeOpenAIStreamCompletion,
  type OpenAIStreamFinalizerInput,
  type OpenAIStreamFinalizerResult,
} from "./openai-stream-finalizer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";
import {
  runOpenAIStreamTelemetry,
  type OpenAIStreamTelemetryInput,
  type OpenAIStreamTelemetryResult,
} from "./openai-stream-telemetry.js";

type MaybePromise<T> = T | Promise<T>;

export interface OpenAIStreamingPipelineInput {
  streamParts: AsyncIterable<unknown>;
  streamState: OpenAIStreamState;
  eventHandlers: OpenAIStreamEventHandlers;
  afterEvents?: () => MaybePromise<void>;
  onEventError?: (error: unknown) => MaybePromise<void>;
  beforeFinalize?: (finishReason: string) => MaybePromise<void>;
  finalizerInput: Omit<OpenAIStreamFinalizerInput, "streamState" | "finishReason">;
  buildTelemetryInput(args: {
    finishReason: string;
    finalized: OpenAIStreamFinalizerResult;
  }): OpenAIStreamTelemetryInput;
}

export interface OpenAIStreamingPipelineResult {
  finishReason: string;
  finalized: OpenAIStreamFinalizerResult;
  telemetry: OpenAIStreamTelemetryResult;
}

export async function runOpenAIStreamingPipeline(
  input: OpenAIStreamingPipelineInput,
): Promise<OpenAIStreamingPipelineResult> {
  try {
    await runOpenAIStreamEvents(input.streamParts, input.eventHandlers);
    await input.afterEvents?.();
  } catch (error) {
    await input.onEventError?.(error);
  }

  const finishReason = input.streamState.rawFinishReason();
  await input.beforeFinalize?.(finishReason);

  const finalized = await finalizeOpenAIStreamCompletion({
    ...input.finalizerInput,
    streamState: input.streamState,
    finishReason,
  });
  const telemetry = runOpenAIStreamTelemetry(input.buildTelemetryInput({
    finishReason,
    finalized,
  }));

  return {
    finishReason,
    finalized,
    telemetry,
  };
}
