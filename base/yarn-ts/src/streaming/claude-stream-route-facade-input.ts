import {
  buildClaudeStreamRouteCompletionInput,
  type ClaudeStreamRouteCompletionBuilderInput,
  type RequirementChecklistShape,
} from "./claude-stream-route-completion-input.js";
import {
  buildClaudeStreamRouteEventHandlersInput,
  type ClaudeStreamRouteEventHandlersBuilderInput,
} from "./claude-stream-route-event-input.js";
import {
  buildClaudeStreamRouteRunInput,
} from "./claude-stream-route-input.js";
import type { ClaudeStreamRouteRunInput } from "./claude-stream-route-orchestrator.js";
import {
  runClaudeStreamRoute,
  type ClaudeStreamRouteRunResult,
} from "./claude-stream-route-orchestrator.js";
import {
  buildClaudeStreamRoutePipelineSupportInput,
  type ClaudeStreamRoutePipelineSupportBuilderInput,
} from "./claude-stream-route-pipeline-input.js";
import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { ClaudeStreamRouteRuntimeResult } from "./claude-stream-route-runtime.js";
import {
  buildClaudeStreamRouteStartInput,
  type ClaudeStreamRouteStartBuilderInput,
} from "./claude-stream-route-start-input.js";
import type { ClaudeStreamRequestForensicsResult } from "./claude-stream-telemetry.js";

export interface ClaudeStreamRouteInputBuilderInput<
  TMessage extends ClaudeStreamProviderMessage,
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
> {
  runtime: ClaudeStreamRouteRuntimeResult<unknown>;
  start: ClaudeStreamRouteStartBuilderInput<TMessage>;
  eventHandlers: ClaudeStreamRouteEventHandlersBuilderInput;
  pipelineSupport: ClaudeStreamRoutePipelineSupportBuilderInput;
  completion: ClaudeStreamRouteCompletionBuilderInput<TChecklist, TVerification, TPlanGraph>;
  onProviderComplete?: ClaudeStreamRouteRunInput<
    TMessage,
    ClaudeStreamRequestForensicsResult | null | undefined,
    TChecklist,
    TVerification,
    TPlanGraph
  >["onProviderComplete"];
}

export function buildClaudeStreamRouteInput<
  TMessage extends ClaudeStreamProviderMessage,
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeStreamRouteInputBuilderInput<TMessage, TChecklist, TVerification, TPlanGraph>,
): ClaudeStreamRouteRunInput<
  TMessage,
  ClaudeStreamRequestForensicsResult | null | undefined,
  TChecklist,
  TVerification,
  TPlanGraph
> {
  return buildClaudeStreamRouteRunInput({
    runtime: input.runtime,
    start: buildClaudeStreamRouteStartInput(input.start),
    pipeline: {
      eventHandlers: buildClaudeStreamRouteEventHandlersInput(input.eventHandlers),
      ...buildClaudeStreamRoutePipelineSupportInput(input.pipelineSupport),
    },
    completion: buildClaudeStreamRouteCompletionInput(input.completion),
    onProviderComplete: input.onProviderComplete,
  });
}

export async function runClaudeStreamRouteFromInput<
  TMessage extends ClaudeStreamProviderMessage,
  TChecklist extends RequirementChecklistShape,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeStreamRouteInputBuilderInput<TMessage, TChecklist, TVerification, TPlanGraph>,
): Promise<ClaudeStreamRouteRunResult<
  TMessage,
  ClaudeStreamRequestForensicsResult | null | undefined
>> {
  return runClaudeStreamRoute(buildClaudeStreamRouteInput(input));
}
