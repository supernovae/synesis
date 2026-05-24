import {
  createOpenAIStreamingPipelineInput,
  runOpenAIStreamingPipeline,
  type OpenAIStreamingPipelineResult,
} from "../streaming/openai-streaming-pipeline.js";
import type { OpenAIStreamRouteRuntime } from "./openai-stream-route-runtime.js";
import {
  createOpenAIStreamRouteEventPipelineHandlers,
  type OpenAIStreamRouteEventPipelineInput,
} from "./openai-stream-route-events.js";
import {
  createOpenAIStreamRouteFinalizerInput,
  type OpenAIStreamRouteFinalizerInput,
} from "./openai-stream-route-finalizer.js";
import {
  createOpenAIStreamRouteTelemetryInputBuilder,
  type OpenAIStreamRouteTelemetryInput,
} from "./openai-stream-route-telemetry.js";
import type {
  OpenAIStreamRouteEventSession,
} from "../streaming/openai-stream-route-event-handlers.js";
import type { RouteToolCallSideEffectsSession } from "../streaming/route-tool-call-side-effects.js";
import type { PipelineStageTelemetry } from "./types.js";

type RuntimeEventFields =
  | "streamState"
  | "writer"
  | "acceptedGuardrailCalls"
  | "blockedDiscoveryDetails"
  | "accumulator"
  | "scrubAndFlushText";

export type OpenAIStreamRoutePipelineEventInput<
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
> = Omit<OpenAIStreamRouteEventPipelineInput<TSession>, RuntimeEventFields>;

export type OpenAIStreamRoutePipelineFinalizerInput<TChecklist, TVerification, TPlanGraph> = Omit<
  OpenAIStreamRouteFinalizerInput<TChecklist, TVerification, TPlanGraph>,
  "components"
>;

export type OpenAIStreamRoutePipelineTelemetryInput = Omit<
  OpenAIStreamRouteTelemetryInput,
  "components"
>;

export interface OpenAIStreamRoutePipelineInput<
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  streamParts: AsyncIterable<unknown>;
  runtime: OpenAIStreamRouteRuntime;
  eventHandlers: OpenAIStreamRoutePipelineEventInput<TSession>;
  finalizer: OpenAIStreamRoutePipelineFinalizerInput<TChecklist, TVerification, TPlanGraph>;
  telemetry: OpenAIStreamRoutePipelineTelemetryInput;
  stageTelemetry?: PipelineStageTelemetry;
}

export async function runOpenAIStreamRoutePipeline<
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: OpenAIStreamRoutePipelineInput<TSession, TChecklist, TVerification, TPlanGraph>,
): Promise<OpenAIStreamingPipelineResult> {
  const { runtime } = input;
  const { components } = runtime;
  return runOpenAIStreamingPipeline(createOpenAIStreamingPipelineInput({
    streamParts: input.streamParts,
    streamState: components.streamState,
    eventHandlers: createOpenAIStreamRouteEventPipelineHandlers({
      ...input.eventHandlers,
      streamState: components.streamState,
      writer: components.writer,
      acceptedGuardrailCalls: components.guardrailAccepted,
      blockedDiscoveryDetails: components.blockedDetails,
      accumulator: components.accumulator,
      scrubAndFlushText: components.scrubAndFlushText,
    }),
    afterEvents: runtime.afterEvents,
    lifecycle: runtime.lifecycle,
    finalizerInput: createOpenAIStreamRouteFinalizerInput({
      ...input.finalizer,
      components,
    }),
    buildTelemetryInput: createOpenAIStreamRouteTelemetryInputBuilder({
      ...input.telemetry,
      components,
    }),
    stageTelemetry: input.stageTelemetry,
  }));
}
