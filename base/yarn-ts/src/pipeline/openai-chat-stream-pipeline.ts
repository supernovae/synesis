import type { StreamTokenUsage } from "../streaming/openai-stream-finalizer.js";
import type { OpenAIStreamPreflightMessage } from "../streaming/openai-stream-message-preflight.js";
import type { StreamRouteEventSink, StreamRouteScope } from "../streaming/stream-route-scope.js";
import type { StreamTelemetryRouteBaseInput } from "../streaming/stream-telemetry-route-base.js";
import type { RouteToolCallSideEffectsSession } from "../streaming/route-tool-call-side-effects.js";
import type { OpenAIStreamRouteEventSession } from "../streaming/openai-stream-route-event-handlers.js";
import type {
  OpenAIStreamRouteFinalizerInput,
} from "./openai-stream-route-finalizer.js";
import type {
  OpenAIStreamRoutePipelineEventInput,
  OpenAIStreamRoutePipelineTelemetryInput,
} from "./openai-stream-route-pipeline.js";
import { runOpenAIStreamRoutePipeline } from "./openai-stream-route-pipeline.js";
import type {
  OpenAIStreamProviderInvocationInput,
} from "./openai-stream-provider-invocation.js";
import { invokeOpenAIStreamProvider } from "./openai-stream-provider-invocation.js";
import type {
  OpenAIStreamRouteRuntimeInput,
} from "./openai-stream-route-runtime.js";
import { createOpenAIStreamRouteRuntime } from "./openai-stream-route-runtime.js";
import type { OpenAIStreamRouteStartInput } from "./openai-stream-route-start.js";
import { startOpenAIStreamRoute } from "./openai-stream-route-start.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";
import type { PipelineStageTelemetry } from "./types.js";

type ProviderRuntimeFields =
  | "scope"
  | "startedAtMs"
  | "resolvedModelId"
  | "recordSessionEvent";

type RouteRuntimeFields =
  | "scope"
  | "resolvedModelId"
  | "messages"
  | "recordSessionEvent"
  | "abortRuntime"
  | "admissionRelease"
  | "span";

type EventFields = "scope" | "resolvedModelId";

type FinalizerFields = "scope" | "components" | "streamed" | "stopHeartbeat" | "recordSessionEvent";

type TelemetryRouteBaseFields = "scope" | "startedAtMs" | "resolvedModelId";

export interface OpenAIChatStreamPipelineInput<
  TMessage extends OpenAIStreamPreflightMessage,
  TForensics,
  TStreamed extends { fullStream: AsyncIterable<unknown>; totalUsage: PromiseLike<unknown>; text: PromiseLike<string> },
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  scope: StreamRouteScope;
  resolvedModelId: string;
  recordSessionEvent: StreamRouteEventSink;
  start: Omit<OpenAIStreamRouteStartInput, "scope" | "resolvedModelId" | "recordSessionEvent">;
  provider: Omit<OpenAIStreamProviderInvocationInput<TMessage, TForensics, TStreamed>, ProviderRuntimeFields>;
  runtime: Omit<OpenAIStreamRouteRuntimeInput, RouteRuntimeFields>;
  eventHandlers: Omit<OpenAIStreamRoutePipelineEventInput<TSession>, EventFields>;
  finalizer: Omit<OpenAIStreamRouteFinalizerInput<TChecklist, TVerification, TPlanGraph>, FinalizerFields>;
  telemetry: Omit<OpenAIStreamRoutePipelineTelemetryInput, "routeBase" | "finalizeRequestForensics" | "recordSessionEvent"> & {
    routeBase: Omit<StreamTelemetryRouteBaseInput, TelemetryRouteBaseFields>;
    finalizeRequestForensics(usage: StreamTokenUsage, forensics: TForensics): ReturnType<OpenAIStreamRoutePipelineTelemetryInput["finalizeRequestForensics"]>;
  };
  stageTelemetry?: PipelineStageTelemetry;
}

export async function runOpenAIChatStreamPipeline<
  TMessage extends OpenAIStreamPreflightMessage,
  TForensics,
  TStreamed extends { fullStream: AsyncIterable<unknown>; totalUsage: PromiseLike<unknown>; text: PromiseLike<string> },
  TSession extends RouteToolCallSideEffectsSession & OpenAIStreamRouteEventSession,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: OpenAIChatStreamPipelineInput<TMessage, TForensics, TStreamed, TSession, TChecklist, TVerification, TPlanGraph>,
): Promise<OpenAIChatPipelineResult> {
  const started = await startOpenAIStreamRoute({
    ...input.start,
    scope: input.scope,
    resolvedModelId: input.resolvedModelId,
    recordSessionEvent: input.recordSessionEvent,
  });
  if (!started.ok) return started.result;

  const endProviderStage = input.stageTelemetry?.startStage("provider");
  let invocation: ReturnType<typeof invokeOpenAIStreamProvider<TMessage, TForensics, TStreamed>>;
  try {
    invocation = invokeOpenAIStreamProvider({
      ...input.provider,
      scope: started.scope,
      startedAtMs: started.startedAtMs,
      resolvedModelId: input.resolvedModelId,
      recordSessionEvent: started.recordEvent,
    });
  } finally {
    endProviderStage?.();
  }

  const runtime = createOpenAIStreamRouteRuntime({
    ...input.runtime,
    scope: started.scope,
    resolvedModelId: input.resolvedModelId,
    messages: invocation.messages,
    recordSessionEvent: started.recordEvent,
    abortRuntime: invocation.abortRuntime,
    admissionRelease: () => started.admission.release!(),
    span: started.span,
  });

  await runOpenAIStreamRoutePipeline({
    streamParts: invocation.streamed.fullStream,
    runtime,
    eventHandlers: {
      ...input.eventHandlers,
      scope: started.scope,
      resolvedModelId: input.resolvedModelId,
    },
    finalizer: {
      ...input.finalizer,
      scope: started.scope,
      streamed: invocation.streamed,
      stopHeartbeat: () => runtime.heartbeat.stop(),
      recordSessionEvent: started.recordEvent,
    },
    telemetry: {
      ...input.telemetry,
      routeBase: {
        ...input.telemetry.routeBase,
        scope: started.scope,
        startedAtMs: started.startedAtMs,
        resolvedModelId: input.resolvedModelId,
      },
      recordSessionEvent: started.recordEvent,
      finalizeRequestForensics: (usage) => input.telemetry.finalizeRequestForensics(
        usage,
        invocation.requestForensics,
      ),
    },
    stageTelemetry: input.stageTelemetry,
  });

  return { kind: "streamStarted" };
}
