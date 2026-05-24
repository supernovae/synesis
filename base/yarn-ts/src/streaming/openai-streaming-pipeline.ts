import type { OpenAIStreamEventHandlers } from "./openai-stream-event-runner.js";
import { runOpenAIStreamEvents } from "./openai-stream-event-runner.js";
import {
  finalizeOpenAIStreamCompletion,
  type OpenAIStreamFinalizerFactoryInput,
  type OpenAIStreamFinalizerResult,
} from "./openai-stream-finalizer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";
import {
  runOpenAIStreamTelemetry,
  type OpenAIStreamTelemetryInputBuilder,
  type OpenAIStreamTelemetryResult,
} from "./openai-stream-telemetry.js";

type MaybePromise<T> = T | Promise<T>;

export interface OpenAIStreamingPipelineStageTelemetry {
  startStage(stage: string): () => void;
}

export interface OpenAIStreamingPipelineInput {
  streamParts: AsyncIterable<unknown>;
  streamState: OpenAIStreamState;
  eventHandlers: OpenAIStreamEventHandlers;
  afterEvents?: () => MaybePromise<void>;
  onEventError?: (error: unknown) => MaybePromise<void>;
  beforeFinalize?: (finishReason: string) => MaybePromise<void>;
  finalizerInput: OpenAIStreamFinalizerFactoryInput;
  buildTelemetryInput: OpenAIStreamTelemetryInputBuilder;
  stageTelemetry?: OpenAIStreamingPipelineStageTelemetry;
}

export interface OpenAIStreamingPipelineLifecycleHandlers {
  onEventError(error: unknown): MaybePromise<void>;
  beforeFinalize(finishReason: string): MaybePromise<void>;
}

export interface OpenAIStreamingPipelineFactoryInput
  extends Omit<OpenAIStreamingPipelineInput, "onEventError" | "beforeFinalize"> {
  lifecycle?: Partial<OpenAIStreamingPipelineLifecycleHandlers>;
}

export interface OpenAIStreamingPipelineResult {
  finishReason: string;
  finalized: OpenAIStreamFinalizerResult;
  telemetry: OpenAIStreamTelemetryResult;
}

export function createOpenAIStreamingPipelineInput(
  input: OpenAIStreamingPipelineFactoryInput,
): OpenAIStreamingPipelineInput {
  const { lifecycle, ...pipelineInput } = input;
  return {
    ...pipelineInput,
    onEventError: lifecycle?.onEventError,
    beforeFinalize: lifecycle?.beforeFinalize,
  };
}

export async function runOpenAIStreamingPipeline(
  input: OpenAIStreamingPipelineInput,
): Promise<OpenAIStreamingPipelineResult> {
  const endStreamStage = input.stageTelemetry?.startStage("stream");
  try {
    await runOpenAIStreamEvents(input.streamParts, input.eventHandlers);
    await input.afterEvents?.();
  } catch (error) {
    await input.onEventError?.(error);
  } finally {
    endStreamStage?.();
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
