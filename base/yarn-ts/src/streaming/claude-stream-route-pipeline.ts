import {
  createClaudeStreamAfterEventsHandler,
  type ClaudeStreamAfterEventsRouteInput,
} from "./claude-stream-after-events.js";
import {
  createClaudeStreamLifecycleHandlers,
  type ClaudeStreamLifecycleInput,
} from "./claude-stream-lifecycle.js";
import {
  createClaudeStreamRouteEventHandlers,
  type ClaudeStreamRouteEventHandlerInput,
} from "./claude-stream-route-event-handlers.js";
import {
  runClaudeStreamingPipeline,
  type ClaudeStreamingPipelineResult,
} from "./claude-streaming-pipeline.js";

export interface ClaudeStreamRoutePipelineInput {
  streamParts: AsyncIterable<unknown>;
  eventHandlersInput: ClaudeStreamRouteEventHandlerInput;
  lifecycleInput: ClaudeStreamLifecycleInput;
  afterEventsInput: ClaudeStreamAfterEventsRouteInput;
}

export interface ClaudeStreamRoutePipelineFactoryInput {
  streamParts: AsyncIterable<unknown>;
  state: {
    streamState: ClaudeStreamRouteEventHandlerInput["streamState"];
    discovery: ClaudeStreamRouteEventHandlerInput["discovery"];
    blockedDetails: ClaudeStreamRouteEventHandlerInput["blockedDiscoveryDetails"];
    acceptedGuardrailCalls: ClaudeStreamRouteEventHandlerInput["acceptedGuardrailCalls"];
    toolSequence: ClaudeStreamRouteEventHandlerInput["toolSequence"];
    localLikeBaseUrl: boolean;
  };
  route: {
    sessionKey: string;
    userId: string;
    orgId: string;
    requestId: string;
    resolvedModelId: string;
    baseUrl?: string;
  };
  eventHandlers: Omit<
    ClaudeStreamRouteEventHandlerInput,
    | "streamState"
    | "acceptedGuardrailCalls"
    | "blockedDiscoveryDetails"
    | "discovery"
    | "toolSequence"
  >;
  lifecycle: Omit<
    ClaudeStreamLifecycleInput,
    "requestId" | "model" | "orgId" | "streamState"
  >;
  afterEvents: Omit<
    ClaudeStreamAfterEventsRouteInput,
    | "localLikeBaseUrl"
    | "requestId"
    | "resolvedModelId"
    | "baseUrl"
    | "sessionKey"
    | "userId"
    | "orgId"
    | "streamState"
    | "discovery"
    | "blockedDetails"
  >;
}

export function createClaudeStreamRoutePipelineInput(
  input: ClaudeStreamRoutePipelineFactoryInput,
): ClaudeStreamRoutePipelineInput {
  return {
    streamParts: input.streamParts,
    eventHandlersInput: {
      ...input.eventHandlers,
      streamState: input.state.streamState,
      acceptedGuardrailCalls: input.state.acceptedGuardrailCalls,
      blockedDiscoveryDetails: input.state.blockedDetails,
      discovery: input.state.discovery,
      toolSequence: input.state.toolSequence,
    },
    lifecycleInput: {
      ...input.lifecycle,
      requestId: input.route.requestId,
      model: input.route.resolvedModelId,
      orgId: input.route.orgId,
      streamState: input.state.streamState,
    },
    afterEventsInput: {
      ...input.afterEvents,
      localLikeBaseUrl: input.state.localLikeBaseUrl,
      requestId: input.route.requestId,
      resolvedModelId: input.route.resolvedModelId,
      baseUrl: input.route.baseUrl,
      sessionKey: input.route.sessionKey,
      userId: input.route.userId,
      orgId: input.route.orgId,
      streamState: input.state.streamState,
      discovery: input.state.discovery,
      blockedDetails: input.state.blockedDetails,
    },
  };
}

export async function runClaudeStreamRoutePipeline(
  input: ClaudeStreamRoutePipelineInput,
): Promise<ClaudeStreamingPipelineResult> {
  const eventHandlers = createClaudeStreamRouteEventHandlers(input.eventHandlersInput);
  const lifecycle = createClaudeStreamLifecycleHandlers(input.lifecycleInput);
  const afterEvents = createClaudeStreamAfterEventsHandler(input.afterEventsInput);

  return runClaudeStreamingPipeline({
    streamParts: input.streamParts,
    handleLocalEvent: eventHandlers.handleLocalEvent,
    handleToolCall: eventHandlers.handleToolCall,
    afterEvents,
    onEventError: lifecycle.onEventError,
    finalizeLifecycle: lifecycle.finalizeLifecycle,
  });
}
