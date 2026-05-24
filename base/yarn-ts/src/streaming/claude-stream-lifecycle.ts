import type {
  OpenAIStreamLifecycleCircuitBreaker,
  OpenAIStreamLifecycleLogger,
  OpenAIStreamLifecycleSession,
  OpenAIStreamLifecycleSpan,
  OpenAIStreamUpstreamErrorDiagnostics,
} from "./openai-stream-lifecycle.js";
import type { ClaudeStreamState } from "./claude-stream-state.js";

export interface ClaudeStreamLifecycleInput {
  requestId: string;
  model: string;
  orgId: string;
  session: OpenAIStreamLifecycleSession;
  abortSignal: AbortSignal;
  hardTimeout: ReturnType<typeof setTimeout>;
  admissionRelease(): void;
  streamState: ClaudeStreamState;
  span: OpenAIStreamLifecycleSpan;
  circuitBreakers: OpenAIStreamLifecycleCircuitBreaker;
  logger: OpenAIStreamLifecycleLogger;
  extractUpstreamErrorDiagnostics(error: unknown): OpenAIStreamUpstreamErrorDiagnostics;
  sendSse(event: string, data: unknown): boolean;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
    metadataJson?: Record<string, unknown>;
  }): void;
}

export function handleClaudeStreamEventError(
  input: ClaudeStreamLifecycleInput,
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
    `Claude stream error: ${upstream.rawMessage.slice(0, 500)}`,
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
  writeClaudeErrorHint(input, errorHint(upstream, timedOut));
  input.streamState.markEndTurn();
}

export function finalizeClaudeStreamLifecycle(
  input: ClaudeStreamLifecycleInput,
): string {
  clearTimeout(input.hardTimeout);
  input.admissionRelease();

  const stopReason = input.streamState.rawStopReason();
  if (stopReason !== "end_turn" || !input.streamState.isInTextBlock()) {
    input.circuitBreakers.recordSuccess(input.model, input.orgId);
    input.span.setStatus("ok");
  }
  input.span.end();
  return stopReason;
}

function writeClaudeErrorHint(
  input: ClaudeStreamLifecycleInput,
  text: string,
): void {
  if (!input.streamState.isTextBlockOpen()) {
    input.sendSse("content_block_start", {
      type: "content_block_start",
      index: input.streamState.currentBlockIndex(),
      content_block: { type: "text", text: "" },
    });
    input.streamState.markTextBlockOpen();
  }
  input.sendSse("content_block_delta", {
    type: "content_block_delta",
    index: input.streamState.currentBlockIndex(),
    delta: { type: "text_delta", text },
  });
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
