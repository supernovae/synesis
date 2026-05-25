import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import {
  finalizeClaudeNonStreamProviderSuccess,
  handleClaudeNonStreamProviderError,
  type ClaudeNonStreamLifecycleInput,
} from "./claude-nonstream-lifecycle.js";
import {
  createClaudeNonStreamPostProviderInput,
  processClaudeNonStreamProviderResult,
  type ClaudeNonStreamPostProviderInput,
  type ClaudeNonStreamPostProviderRouteInput,
  type ClaudeNonStreamPostProviderResult,
} from "./claude-nonstream-postprocess.js";
import {
  createClaudeNonStreamProviderExecutorInput,
  executeClaudeNonStreamProviderLoop,
  type ClaudeNonStreamProviderExecutorInput,
  type ClaudeNonStreamProviderExecutorRouteInput,
  type ClaudeNonStreamProviderMessage,
  type ClaudeNonStreamProviderResultLike,
} from "./claude-nonstream-provider-executor.js";
import type { ClaudeNonStreamRouteScope } from "./claude-nonstream-route-scope.js";

export interface ClaudeNonStreamCircuitBreakers {
  allowRequest(modelId: string, orgId: string): boolean;
  recordFailure(modelId: string, orgId: string): void;
  recordSuccess(modelId: string, orgId: string): void;
}

export interface ClaudeNonStreamRouteLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ClaudeNonStreamPipelineInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  resolvedModelId: string;
  circuitBreakers: ClaudeNonStreamCircuitBreakers;
  logger: ClaudeNonStreamRouteLogger;
  startSpan(): ClaudeNonStreamLifecycleInput["span"];
  extractUpstreamErrorDiagnostics: ClaudeNonStreamLifecycleInput["extractUpstreamErrorDiagnostics"];
  providerInput: ClaudeNonStreamProviderExecutorInput<TMessage, TResult>;
  postprocessInput: Omit<
    ClaudeNonStreamPostProviderInput<TChecklist, TVerification, TPlanGraph>,
    "result" | "serverWebSearchEvents"
  >;
}

export interface ClaudeNonStreamPipelineRouteInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TChecklist,
  TVerification,
  TPlanGraph,
> extends Omit<
    ClaudeNonStreamPipelineInput<TMessage, TResult, TChecklist, TVerification, TPlanGraph>,
    "requestId" | "sessionKey" | "userId" | "orgId"
  > {
  scope: ClaudeNonStreamRouteScope;
}

export interface ClaudeNonStreamRouteAssemblyInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TForensics,
  TChecklist,
  TVerification,
  TPlanGraph,
> extends Omit<
    ClaudeNonStreamPipelineRouteInput<TMessage, TResult, TChecklist, TVerification, TPlanGraph>,
    "providerInput" | "postprocessInput"
  > {
  providerRouteInput: ClaudeNonStreamProviderExecutorRouteInput<TMessage, TResult, TForensics>;
  postprocessRouteInput: ClaudeNonStreamPostProviderRouteInput<TChecklist, TVerification, TPlanGraph>;
}

export interface ClaudeNonStreamPipelineSuccess {
  kind: "success";
  processed: ClaudeNonStreamPostProviderResult;
}

export interface ClaudeNonStreamPipelineError {
  kind: "error";
  statusCode: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type ClaudeNonStreamPipelineResult =
  | ClaudeNonStreamPipelineSuccess
  | ClaudeNonStreamPipelineError;

export function createClaudeNonStreamPipelineInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeNonStreamPipelineRouteInput<TMessage, TResult, TChecklist, TVerification, TPlanGraph>,
): ClaudeNonStreamPipelineInput<TMessage, TResult, TChecklist, TVerification, TPlanGraph> {
  return {
    ...input,
    requestId: input.scope.requestId,
    sessionKey: input.scope.sessionKey,
    userId: input.scope.userId,
    orgId: input.scope.orgId,
  };
}

export function createClaudeNonStreamRoutePipelineInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TForensics,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeNonStreamRouteAssemblyInput<TMessage, TResult, TForensics, TChecklist, TVerification, TPlanGraph>,
): ClaudeNonStreamPipelineInput<TMessage, TResult, TChecklist, TVerification, TPlanGraph> {
  return createClaudeNonStreamPipelineInput({
    ...input,
    providerInput: createClaudeNonStreamProviderExecutorInput(input.providerRouteInput),
    postprocessInput: createClaudeNonStreamPostProviderInput(input.postprocessRouteInput),
  });
}

export async function runClaudeNonStreamPipeline<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: ClaudeNonStreamPipelineInput<TMessage, TResult, TChecklist, TVerification, TPlanGraph>,
): Promise<ClaudeNonStreamPipelineResult> {
  if (!input.circuitBreakers.allowRequest(input.resolvedModelId, input.orgId)) {
    input.logger.warn({ model: input.resolvedModelId, orgId: input.orgId }, "circuit_breaker_open_claude");
    input.providerInput.recordSessionEvent({
      eventKind: "breaker_open_reject",
      component: "circuit-breaker",
      detail: `Circuit breaker open for ${input.resolvedModelId} (claude)`,
      metadataJson: { model: input.resolvedModelId },
    });
    return {
      kind: "error",
      statusCode: 503,
      headers: { "Retry-After": "30" },
      body: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Model provider temporarily unavailable. Try again shortly.",
        },
      },
    };
  }

  const span = input.startSpan();
  let providerCall: Awaited<ReturnType<typeof executeClaudeNonStreamProviderLoop<TMessage, TResult>>>;
  try {
    providerCall = await executeClaudeNonStreamProviderLoop(input.providerInput);
  } catch (err) {
    const errorResponse = handleClaudeNonStreamProviderError(
      {
        requestId: input.requestId,
        model: input.resolvedModelId,
        orgId: input.orgId,
        span,
        circuitBreakers: input.circuitBreakers,
        logger: input.logger,
        extractUpstreamErrorDiagnostics: input.extractUpstreamErrorDiagnostics,
        recordSessionEvent: input.providerInput.recordSessionEvent,
      },
      err,
    );
    return {
      kind: "error",
      statusCode: errorResponse.statusCode,
      body: errorResponse.payload,
    };
  }

  finalizeClaudeNonStreamProviderSuccess({
    model: input.resolvedModelId,
    orgId: input.orgId,
    span,
    circuitBreakers: input.circuitBreakers,
  });

  const processed = await processClaudeNonStreamProviderResult({
    ...input.postprocessInput,
    result: {
      text: providerCall.result.text,
      reasoning: (providerCall.result as { reasoning?: unknown }).reasoning,
      usage: providerCall.result.usage,
      toolCalls: providerCall.result.toolCalls,
    },
    serverWebSearchEvents: providerCall.serverWebSearchEvents,
    telemetryInput: {
      ...input.postprocessInput.telemetryInput,
      requestForensicsDone: providerCall.requestForensicsDone as RequestForensicsRecord | undefined,
    },
  });

  return {
    kind: "success",
    processed,
  };
}
