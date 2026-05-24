import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import {
  executeOpenAINonStreamProviderLoop,
  type OpenAINonStreamProviderExecutorInput,
  type OpenAINonStreamProviderMessage,
  type OpenAINonStreamProviderResultLike,
} from "./openai-nonstream-provider-executor.js";
import {
  processOpenAINonStreamProviderResult,
  type OpenAINonStreamPostProviderInput,
} from "./openai-nonstream-postprocess.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";
import type { OpenAINonStreamFinalizerSession } from "./openai-nonstream-finalizer.js";
import type { OpenAINonStreamToolCallSession } from "./openai-nonstream-tool-calls.js";

export interface OpenAINonStreamCircuitBreakers {
  allowRequest(modelId: string, orgId: string): boolean;
  recordFailure(modelId: string, orgId: string): void;
  recordSuccess(modelId: string, orgId: string): void;
}

export interface OpenAINonStreamRouteLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAINonStreamTraceSpan {
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

export interface OpenAINonStreamUpstreamDiagnostics {
  userMessage: string;
  errorName?: string | null;
  errorCode?: string | null;
  httpStatus?: number | null;
  isVercelAiSdkError?: boolean;
  isMissingToolResults?: boolean;
  rawMessage: string;
}

export interface OpenAIChatNonStreamPipelineInput<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
  TSession extends OpenAINonStreamToolCallSession & OpenAINonStreamFinalizerSession,
  TChecklist,
  TVerification,
  TPlanGraph,
> {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  resolvedModelId: string;
  circuitBreakers: OpenAINonStreamCircuitBreakers;
  logger: OpenAINonStreamRouteLogger;
  startSpan(): OpenAINonStreamTraceSpan;
  extractUpstreamErrorDiagnostics(error: unknown): OpenAINonStreamUpstreamDiagnostics;
  onMissingToolResults(): void;
  recordSessionEvent(
    eventKind: string,
    component: string,
    detail: string,
    metadataJson?: Record<string, unknown>,
  ): void;
  providerInput: OpenAINonStreamProviderExecutorInput<TMessage, TResult, TForensics>;
  getTopLevelDirs(): Promise<string[]>;
  postprocessInput: Omit<
    OpenAINonStreamPostProviderInput<TSession, TChecklist, TVerification, TPlanGraph>,
    "result" | "topLevelDirs"
  >;
}

export async function runOpenAIChatNonStreamPipeline<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
  TSession extends OpenAINonStreamToolCallSession & OpenAINonStreamFinalizerSession,
  TChecklist,
  TVerification,
  TPlanGraph,
>(
  input: OpenAIChatNonStreamPipelineInput<TMessage, TResult, TForensics, TSession, TChecklist, TVerification, TPlanGraph>,
): Promise<OpenAIChatPipelineResult> {
  if (!input.circuitBreakers.allowRequest(input.resolvedModelId, input.orgId)) {
    input.logger.warn({ model: input.resolvedModelId, orgId: input.orgId }, "circuit_breaker_open");
    input.recordSessionEvent(
      "breaker_open_reject",
      "circuit-breaker",
      `Circuit breaker open for ${input.resolvedModelId}`,
      { model: input.resolvedModelId },
    );
    return {
      kind: "error",
      statusCode: 503,
      headers: { "Retry-After": "30" },
      body: { error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } },
    };
  }

  const span = input.startSpan();
  let providerCall: Awaited<ReturnType<typeof executeOpenAINonStreamProviderLoop<TMessage, TResult, TForensics>>>;
  try {
    providerCall = await executeOpenAINonStreamProviderLoop(input.providerInput);
  } catch (err) {
    const upstream = input.extractUpstreamErrorDiagnostics(err);
    if (upstream.isMissingToolResults) {
      input.onMissingToolResults();
    }
    input.circuitBreakers.recordFailure(input.resolvedModelId, input.orgId);
    span.setStatus("error", upstream.userMessage);
    span.end();
    input.logger.error(
      {
        err,
        reqId: input.requestId,
        model: input.resolvedModelId,
        upstream_error_name: upstream.errorName,
        upstream_error_code: upstream.errorCode,
        upstream_http_status: upstream.httpStatus,
        upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
        upstream_missing_tool_results: upstream.isMissingToolResults,
        upstream_raw_message: upstream.rawMessage.slice(0, 600),
      },
      "OpenAI non-stream generateText failed",
    );
    input.recordSessionEvent(
      "upstream_error",
      "generateText",
      upstream.userMessage,
      {
        model: input.resolvedModelId,
        error_name: upstream.errorName ?? "",
        error_code: upstream.errorCode ?? "",
        error_status: upstream.httpStatus ?? 0,
        vercel_ai_sdk_error: upstream.isVercelAiSdkError,
        missing_tool_results: upstream.isMissingToolResults,
      },
    );
    return {
      kind: "error",
      statusCode: 502,
      body: { error: { type: "upstream_error", message: upstream.userMessage } },
    };
  }

  input.circuitBreakers.recordSuccess(input.resolvedModelId, input.orgId);
  span.setStatus("ok");
  span.end();

  const topLevelDirs = await input.getTopLevelDirs();
  const processed = await processOpenAINonStreamProviderResult({
    ...input.postprocessInput,
    result: {
      text: providerCall.result.text,
      reasoning: (providerCall.result as { reasoning?: unknown }).reasoning,
      usage: providerCall.result.usage,
      toolCalls: providerCall.result.toolCalls,
    },
    topLevelDirs,
    telemetryInput: {
      ...input.postprocessInput.telemetryInput,
      requestForensics: providerCall.requestForensicsDone as RequestForensicsRecord | undefined,
    },
  });

  return {
    kind: "json",
    body: processed.body,
  };
}
