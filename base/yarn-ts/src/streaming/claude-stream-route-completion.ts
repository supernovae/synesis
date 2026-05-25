import {
  createClaudeStreamCompletionFinalizerInput,
  finalizeClaudeStreamCompletion,
  type ClaudeStreamCompletionFinalizerResult,
  type ClaudeStreamCompletionFinalizerRouteInput,
} from "./claude-stream-finalizer.js";
import {
  createClaudeStreamTelemetryInput,
  runClaudeStreamTelemetry,
  type ClaudeStreamRequestForensicsResult,
  type ClaudeStreamTelemetryRouteInput,
  type ClaudeStreamTelemetryResult,
} from "./claude-stream-telemetry.js";

export type ClaudeStreamRouteCompletionTelemetryBase = Omit<
  ClaudeStreamTelemetryRouteInput,
  "finishReason" | "usage" | "toolNames" | "gate" | "requestForensicsDone"
>;

export interface ClaudeStreamRouteCompletionInput<TForensics extends ClaudeStreamRequestForensicsResult | undefined> {
  finalizerInput: ClaudeStreamCompletionFinalizerRouteInput<TForensics>;
  telemetryBase: ClaudeStreamRouteCompletionTelemetryBase;
  toolNames: string[];
}

export interface ClaudeStreamRouteCompletionResult<TForensics extends ClaudeStreamRequestForensicsResult | undefined> {
  finalized: ClaudeStreamCompletionFinalizerResult<TForensics>;
  telemetry: ClaudeStreamTelemetryResult;
}

export async function completeClaudeStreamRoute<TForensics extends ClaudeStreamRequestForensicsResult | undefined>(
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
    requestForensicsDone: finalized.requestForensicsDone,
  }));

  return {
    finalized,
    telemetry,
  };
}
