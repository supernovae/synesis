import type {
  OpenAIStreamLifecycleCircuitBreaker,
  OpenAIStreamLifecycleLogger,
  OpenAIStreamLifecycleSpan,
  OpenAIStreamUpstreamErrorDiagnostics,
} from "./openai-stream-lifecycle.js";

export interface ClaudeNonStreamLifecycleInput {
  requestId: string;
  model: string;
  orgId: string;
  span: OpenAIStreamLifecycleSpan;
  circuitBreakers: OpenAIStreamLifecycleCircuitBreaker;
  logger: OpenAIStreamLifecycleLogger;
  extractUpstreamErrorDiagnostics(error: unknown): OpenAIStreamUpstreamErrorDiagnostics;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
    metadataJson?: Record<string, unknown>;
  }): void;
}

export interface ClaudeNonStreamErrorResponse {
  statusCode: 502;
  payload: {
    type: "error";
    error: {
      type: "upstream_error";
      message: string;
    };
  };
}

export function handleClaudeNonStreamProviderError(
  input: ClaudeNonStreamLifecycleInput,
  error: unknown,
): ClaudeNonStreamErrorResponse {
  const upstream = input.extractUpstreamErrorDiagnostics(error);
  input.circuitBreakers.recordFailure(input.model, input.orgId);
  input.span.setStatus("error", upstream.userMessage);
  input.span.end();
  input.logger.error(
    {
      err: error,
      reqId: input.requestId,
      model: input.model,
      upstream_error_name: upstream.errorName,
      upstream_error_code: upstream.errorCode,
      upstream_http_status: upstream.httpStatus,
      upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
      upstream_missing_tool_results: upstream.isMissingToolResults,
      upstream_raw_message: upstream.rawMessage.slice(0, 600),
    },
    "Claude non-stream generateText failed",
  );
  input.recordSessionEvent({
    eventKind: "upstream_error",
    component: "generateText",
    detail: upstream.userMessage,
    metadataJson: {
      model: input.model,
      error_name: upstream.errorName ?? "",
      error_code: upstream.errorCode ?? "",
      error_status: upstream.httpStatus ?? 0,
      vercel_ai_sdk_error: upstream.isVercelAiSdkError,
      missing_tool_results: upstream.isMissingToolResults,
    },
  });
  return {
    statusCode: 502,
    payload: {
      type: "error",
      error: { type: "upstream_error", message: upstream.userMessage },
    },
  };
}

export function finalizeClaudeNonStreamProviderSuccess(
  input: Pick<ClaudeNonStreamLifecycleInput, "model" | "orgId" | "span" | "circuitBreakers">,
): void {
  input.circuitBreakers.recordSuccess(input.model, input.orgId);
  input.span.setStatus("ok");
  input.span.end();
}
