import type { StreamRouteScope } from "./stream-route-scope.js";
import type { ClaudeStreamRequestForensicsResult } from "./claude-stream-telemetry.js";
import type {
  ClaudeStreamRouteRunInput,
} from "./claude-stream-route-orchestrator.js";
import type { ClaudeStreamRouteStartInput } from "./claude-stream-route-start.js";
import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { ClaudeStreamRouteRuntimeResult } from "./claude-stream-route-runtime.js";

type RuntimeLifecycleFields = "abortSignal" | "hardTimeout" | "admissionRelease" | "span";
type RuntimeTelemetryFields = "scope" | "startedAtMs" | "resolvedModelId";

export interface ClaudeStreamRouteRunInputBuilderInput<
  TMessage extends ClaudeStreamProviderMessage,
  TForensics extends ClaudeStreamRequestForensicsResult | null | undefined,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  runtime: ClaudeStreamRouteRuntimeResult<unknown>;
  start: Omit<ClaudeStreamRouteStartInput<TMessage>, "scope" | "request"> & {
    request: Omit<ClaudeStreamRouteStartInput<TMessage>["request"], "abortSignal">;
  };
  pipeline: {
    eventHandlers: ClaudeStreamRouteRunInput<
      TMessage,
      TForensics,
      TChecklist,
      TVerification,
      TPlanGraph
    >["pipeline"]["eventHandlers"];
    lifecycle: Omit<
      ClaudeStreamRouteRunInput<
        TMessage,
        TForensics,
        TChecklist,
        TVerification,
        TPlanGraph
      >["pipeline"]["lifecycle"],
      RuntimeLifecycleFields
    >;
    afterEvents: ClaudeStreamRouteRunInput<
      TMessage,
      TForensics,
      TChecklist,
      TVerification,
      TPlanGraph
    >["pipeline"]["afterEvents"];
  };
  completion: {
    finalizer: Omit<
      ClaudeStreamRouteRunInput<
        TMessage,
        TForensics,
        TChecklist,
        TVerification,
        TPlanGraph
      >["completion"]["finalizer"],
      keyof StreamRouteScope
    >;
    telemetry: Omit<
      ClaudeStreamRouteRunInput<
        TMessage,
        TForensics,
        TChecklist,
        TVerification,
        TPlanGraph
      >["completion"]["telemetry"],
      RuntimeTelemetryFields
    >;
  };
}

export function buildClaudeStreamRouteRunInput<
  TMessage extends ClaudeStreamProviderMessage,
  TForensics extends ClaudeStreamRequestForensicsResult | null | undefined,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeStreamRouteRunInputBuilderInput<
    TMessage,
    TForensics,
    TChecklist,
    TVerification,
    TPlanGraph
  >,
): ClaudeStreamRouteRunInput<TMessage, TForensics, TChecklist, TVerification, TPlanGraph> {
  return {
    start: {
      ...input.start,
      scope: input.runtime.streamScope,
      request: {
        ...input.start.request,
        abortSignal: input.runtime.streamAbortRuntime.abortController.signal,
      },
    },
    pipeline: {
      eventHandlers: input.pipeline.eventHandlers,
      lifecycle: {
        ...input.pipeline.lifecycle,
        abortSignal: input.runtime.streamAbortRuntime.abortController.signal,
        hardTimeout: input.runtime.streamAbortRuntime.hardTimeout,
        admissionRelease: input.runtime.admissionRelease,
        span: input.runtime.streamSpan,
      },
      afterEvents: input.pipeline.afterEvents,
    },
    completion: {
      finalizer: {
        ...input.completion.finalizer,
        ...input.runtime.responseScope,
      },
      telemetry: {
        ...input.completion.telemetry,
        scope: input.runtime.responseScope,
        startedAtMs: input.runtime.startedAtMs,
        resolvedModelId: input.start.components.resolvedModelId,
      },
    },
  };
}
