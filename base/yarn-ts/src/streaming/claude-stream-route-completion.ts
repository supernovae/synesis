import {
  createClaudeStreamCompletionFinalizerInput,
  createClaudeStreamFinalizationHandlers,
  finalizeClaudeStreamCompletion,
  type ClaudeStreamCompletionFinalizerResult,
  type ClaudeStreamCompletionFinalizerRouteInput,
  type ClaudeStreamFinalizationHandlerInput,
} from "./claude-stream-finalizer.js";
import {
  createClaudeStreamTelemetryInput,
  runClaudeStreamTelemetry,
  type ClaudeStreamRequestForensicsResult,
  type ClaudeStreamTelemetryRouteInput,
  type ClaudeStreamTelemetryResult,
} from "./claude-stream-telemetry.js";
import {
  createStreamTelemetryRouteBase,
  type StreamTelemetryRouteBaseInput,
} from "./stream-telemetry-route-base.js";

export type ClaudeStreamRouteCompletionTelemetryBase = Omit<
  ClaudeStreamTelemetryRouteInput,
  "finishReason" | "usage" | "toolNames" | "gate" | "requestForensicsDone"
>;

export interface ClaudeStreamRouteCompletionInput<TForensics extends ClaudeStreamRequestForensicsResult | null | undefined> {
  finalizerInput: ClaudeStreamCompletionFinalizerRouteInput<TForensics>;
  telemetryBase: ClaudeStreamRouteCompletionTelemetryBase;
  toolNames: string[];
}

export interface ClaudeStreamRouteCompletionResult<TForensics extends ClaudeStreamRequestForensicsResult | null | undefined> {
  finalized: ClaudeStreamCompletionFinalizerResult<TForensics>;
  telemetry: ClaudeStreamTelemetryResult;
}

export interface ClaudeStreamRouteCompletionFactoryInput<
  TForensics extends ClaudeStreamRequestForensicsResult | null | undefined,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  finalizer: Omit<ClaudeStreamCompletionFinalizerRouteInput<TForensics>, "handlers"> & {
    handlerInput: ClaudeStreamFinalizationHandlerInput<TChecklist, TVerification, TPlanGraph>;
  };
  telemetry: StreamTelemetryRouteBaseInput & {
    recordSessionEvent: ClaudeStreamTelemetryRouteInput["recordSessionEvent"];
    persistDecisionTelemetry: ClaudeStreamTelemetryRouteInput["persistDecisionTelemetry"];
  };
  toolNames: string[];
}

export function createClaudeStreamRouteCompletionInput<
  TForensics extends ClaudeStreamRequestForensicsResult | null | undefined,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeStreamRouteCompletionFactoryInput<TForensics, TChecklist, TVerification, TPlanGraph>,
): ClaudeStreamRouteCompletionInput<TForensics> {
  const { handlerInput, ...finalizerInput } = input.finalizer;
  return {
    finalizerInput: {
      ...finalizerInput,
      handlers: createClaudeStreamFinalizationHandlers(handlerInput),
    },
    telemetryBase: {
      ...createStreamTelemetryRouteBase(input.telemetry),
      recordSessionEvent: input.telemetry.recordSessionEvent,
      persistDecisionTelemetry: input.telemetry.persistDecisionTelemetry,
    },
    toolNames: input.toolNames,
  };
}

export async function completeClaudeStreamRoute<TForensics extends ClaudeStreamRequestForensicsResult | null | undefined>(
  input: ClaudeStreamRouteCompletionInput<TForensics>,
): Promise<ClaudeStreamRouteCompletionResult<TForensics>> {
  const finalized = await finalizeClaudeStreamCompletion(
    createClaudeStreamCompletionFinalizerInput(input.finalizerInput),
  );
  const telemetry = runClaudeStreamTelemetry(createClaudeStreamTelemetryInput({
    ...input.telemetryBase,
    finishReason: input.finalizerInput.stopReason,
    usage: finalized.usage,
    toolNames: input.toolNames,
    gate: input.finalizerInput.gate,
    requestForensicsDone: finalized.requestForensicsDone ?? undefined,
  }));

  return {
    finalized,
    telemetry,
  };
}
