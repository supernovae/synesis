import type { ClaudeStreamRequestForensicsResult } from "./claude-stream-telemetry.js";
import {
  completeClaudeStreamRoute,
  createClaudeStreamRouteCompletionInput,
  type ClaudeStreamRouteCompletionFactoryInput,
  type ClaudeStreamRouteCompletionResult,
} from "./claude-stream-route-completion.js";
import {
  createClaudeStreamRoutePipelineInput,
  runClaudeStreamRoutePipeline,
  type ClaudeStreamRoutePipelineFactoryInput,
} from "./claude-stream-route-pipeline.js";
import {
  startClaudeStreamRoute,
  type ClaudeStreamRouteStartInput,
  type ClaudeStreamRouteStartResult,
} from "./claude-stream-route-start.js";
import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { StreamTelemetryRouteBaseInput } from "./stream-telemetry-route-base.js";

export interface ClaudeStreamRouteRunInput<
  TMessage extends ClaudeStreamProviderMessage,
  TForensics extends ClaudeStreamRequestForensicsResult | undefined,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  start: ClaudeStreamRouteStartInput<TMessage>;
  pipeline: {
    eventHandlers: Omit<
      ClaudeStreamRoutePipelineFactoryInput["eventHandlers"],
      "sendSse" | "scrubAndFlushTextBlock"
    >;
    lifecycle: Omit<ClaudeStreamRoutePipelineFactoryInput["lifecycle"], "sendSse">;
    afterEvents: ClaudeStreamRoutePipelineFactoryInput["afterEvents"];
  };
  completion: {
    finalizer: Omit<
      ClaudeStreamRouteCompletionFactoryInput<TForensics, TChecklist, TVerification, TPlanGraph>["finalizer"],
      | "streamState"
      | "gate"
      | "stopReason"
      | "streamed"
      | "writeFinalText"
      | "closeTextBlock"
      | "sendSse"
      | "stopHeartbeat"
    >;
    telemetry: Omit<
      StreamTelemetryRouteBaseInput,
      "cacheStrategy" | "prefixFingerprint" | "cacheShapeDiagnostics"
    > & {
      recordSessionEvent: ClaudeStreamRouteCompletionFactoryInput<
        TForensics,
        TChecklist,
        TVerification,
        TPlanGraph
      >["telemetry"]["recordSessionEvent"];
      persistDecisionTelemetry: ClaudeStreamRouteCompletionFactoryInput<
        TForensics,
        TChecklist,
        TVerification,
        TPlanGraph
      >["telemetry"]["persistDecisionTelemetry"];
    };
  };
}

export interface ClaudeStreamRouteRunResult<
  TMessage extends ClaudeStreamProviderMessage,
  TForensics extends ClaudeStreamRequestForensicsResult | undefined,
> {
  started: ClaudeStreamRouteStartResult<TMessage>;
  stopReason: string;
  completed: ClaudeStreamRouteCompletionResult<TForensics>;
}

export async function runClaudeStreamRoute<
  TMessage extends ClaudeStreamProviderMessage,
  TForensics extends ClaudeStreamRequestForensicsResult | undefined,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeStreamRouteRunInput<TMessage, TForensics, TChecklist, TVerification, TPlanGraph>,
): Promise<ClaudeStreamRouteRunResult<TMessage, TForensics>> {
  const started = startClaudeStreamRoute(input.start);
  const streamState = started.components.streamState;
  const pipelineResult = await runClaudeStreamRoutePipeline(createClaudeStreamRoutePipelineInput({
    streamParts: started.streamed.fullStream,
    state: {
      streamState,
      acceptedGuardrailCalls: started.components.guardrailAccepted,
      blockedDetails: started.components.blockedDetails,
      discovery: started.components.discovery,
      toolSequence: started.components.toolSequence,
      localLikeBaseUrl: started.components.localLikeBaseUrl,
    },
    route: {
      sessionKey: input.start.scope.sessionKey,
      userId: input.start.scope.userId,
      orgId: input.start.scope.orgId,
      requestId: input.start.scope.requestId,
      resolvedModelId: input.start.components.resolvedModelId,
      baseUrl: input.start.components.tierConfig?.baseUrl,
    },
    eventHandlers: {
      ...input.pipeline.eventHandlers,
      sendSse: input.start.sendSse,
      scrubAndFlushTextBlock: started.components.scrubAndFlushTextBlock,
    },
    lifecycle: {
      ...input.pipeline.lifecycle,
      sendSse: input.start.sendSse,
    },
    afterEvents: input.pipeline.afterEvents,
  }));

  const completed = await completeClaudeStreamRoute(createClaudeStreamRouteCompletionInput({
    finalizer: {
      ...input.completion.finalizer,
      streamState,
      gate: started.components.gate,
      stopReason: pipelineResult.stopReason,
      streamed: {
        totalUsage: started.streamed.totalUsage,
        text: started.streamed.text,
      },
      writeFinalText: started.components.scrubAndFlushTextBlock,
      closeTextBlock: started.components.closeTextBlock,
      sendSse: input.start.sendSse,
      stopHeartbeat: () => started.runtime.heartbeat.stop(),
    },
    telemetry: {
      ...input.completion.telemetry,
      cacheStrategy: started.components.cacheStrategy !== "none"
        ? started.components.cacheStrategy
        : undefined,
      prefixFingerprint: started.components.prefixFingerprint,
      cacheShapeDiagnostics: started.cacheShapeDiagnostics,
    },
    toolNames: started.components.toolSequence,
  }));

  return {
    started,
    stopReason: pipelineResult.stopReason,
    completed,
  };
}
