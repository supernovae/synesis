import type { OpenAIStreamResponseWriter } from "./openai-stream-response-writer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";

export interface OpenAIStreamUpstreamErrorDiagnostics {
  userMessage: string;
  rawMessage: string;
  errorName?: string;
  errorCode?: string;
  httpStatus?: number;
  isVercelAiSdkError: boolean;
  isMissingToolResults: boolean;
}

export interface OpenAIStreamLifecycleSession {
  skipToolIdStabilization: boolean;
}

export interface OpenAIStreamLifecycleSpan {
  setStatus(status: string, message?: string): void;
  end(): void;
}

export interface OpenAIStreamLifecycleCircuitBreaker {
  recordFailure(model: string, orgId: string): void;
  recordSuccess(model: string, orgId: string): void;
}

export interface OpenAIStreamLifecycleLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface OpenAIStreamLifecycleHandlers {
  onEventError(error: unknown): void;
  beforeFinalize(finishReason: string): void;
}

export interface OpenAIStreamLifecycleInput {
  requestId: string;
  model: string;
  orgId: string;
  sessionKey: string;
  userId: string;
  session: OpenAIStreamLifecycleSession;
  abortSignal: AbortSignal;
  hardTimeout: ReturnType<typeof setTimeout>;
  admissionRelease(): void;
  streamState: OpenAIStreamState;
  writer: OpenAIStreamResponseWriter;
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

export function createOpenAIStreamLifecycleHandlers(
  input: OpenAIStreamLifecycleInput,
): OpenAIStreamLifecycleHandlers {
  return {
    onEventError: (streamErr) => {
      handleOpenAIStreamEventError(input, streamErr);
    },
    beforeFinalize: (finishReason) => {
      finalizeOpenAIStreamLifecycle(input, finishReason);
    },
  };
}

function handleOpenAIStreamEventError(
  input: OpenAIStreamLifecycleInput,
  streamErr: unknown,
): void {
  const timedOut = input.abortSignal.aborted
    && /stream_hard_timeout/i.test(String(input.abortSignal.reason ?? ""));
  const upstream = input.extractUpstreamErrorDiagnostics(streamErr);
  if (upstream.isMissingToolResults) {
    input.session.skipToolIdStabilization = true;
  }
  input.circuitBreakers.recordFailure(input.model, input.orgId);
  input.span.setStatus(
    "error",
    timedOut ? "Upstream model request timed out" : upstream.userMessage,
  );
  input.logger.error(
    {
      err: streamErr,
      reqId: input.requestId,
      model: input.model,
      upstream_error_name: upstream.errorName,
      upstream_error_code: upstream.errorCode,
      upstream_http_status: upstream.httpStatus,
      upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
      upstream_missing_tool_results: upstream.isMissingToolResults,
      upstream_raw_message: upstream.rawMessage.slice(0, 600),
    },
    `OpenAI stream error: ${upstream.rawMessage.slice(0, 500)}`,
  );
  input.recordSessionEvent({
    eventKind: "stream_error",
    component: "streamText",
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
  input.streamState.markError();
  input.writer.writeTextDelta(errorHint(upstream, timedOut));
}

function finalizeOpenAIStreamLifecycle(
  input: OpenAIStreamLifecycleInput,
  finishReason: string,
): void {
  clearTimeout(input.hardTimeout);
  input.admissionRelease();

  if (finishReason !== "error") {
    input.circuitBreakers.recordSuccess(input.model, input.orgId);
    input.span.setStatus("ok");
  }
  input.span.end();
}

function errorHint(
  upstream: OpenAIStreamUpstreamErrorDiagnostics,
  timedOut: boolean,
): string {
  if (upstream.isMissingToolResults) {
    return "\n\n[Internal message integrity error — retrying should resolve this automatically]";
  }
  if (timedOut) {
    return "\n\n[Stream timed out before completion — retrying with a smaller scope may help]";
  }
  return "\n\n[Upstream provider error — retrying may help]";
}
