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
