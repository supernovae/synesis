import { createStreamAbortRuntime } from "./stream-abort-runtime.js";

export interface OpenAIStreamRuntimeEventRecorder {
  (event: {
    eventKind: string;
    component: string;
    detail: string;
    metadataJson?: Record<string, unknown>;
  }): void;
}

export interface OpenAIStreamAbortRuntimeInput {
  requestId: string;
  model: string;
  startedAtMs: number;
  longWaitEventMs: number;
  hardTimeoutMs: number;
  recordSessionEvent: OpenAIStreamRuntimeEventRecorder;
}

export interface OpenAIStreamAbortRuntime {
  abortController: AbortController;
  hardTimeout: ReturnType<typeof setTimeout>;
  hardTimeoutMs: number;
}

export interface OpenAIStreamSseRaw extends NodeJS.WritableStream {
  destroyed?: boolean;
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
}

export interface OpenAIStreamHeartbeat {
  stop(): void;
}

export interface OpenAIStreamSseRuntimeInput {
  raw: OpenAIStreamSseRaw;
  headers: Record<string, string>;
  model: string;
  heartbeatIntervalMs: number;
  longWaitEventMs: number;
  startHeartbeat(input: {
    raw: OpenAIStreamSseRaw;
    intervalMs: number;
    longWaitEventMs: number;
    onLongWait?: (elapsedMs: number) => void;
  }): OpenAIStreamHeartbeat;
  recordSessionEvent: OpenAIStreamRuntimeEventRecorder;
}

export function createOpenAIStreamAbortRuntime(
  input: OpenAIStreamAbortRuntimeInput,
): OpenAIStreamAbortRuntime {
  return createStreamAbortRuntime({
    protocolLabel: "OpenAI",
    model: input.model,
    startedAtMs: input.startedAtMs,
    longWaitEventMs: input.longWaitEventMs,
    hardTimeoutMs: input.hardTimeoutMs,
    recordSessionEvent: input.recordSessionEvent,
  });
}

export function startOpenAIStreamSseRuntime(
  input: OpenAIStreamSseRuntimeInput,
): OpenAIStreamHeartbeat {
  input.raw.writeHead(200, input.headers);
  return input.startHeartbeat({
    raw: input.raw,
    intervalMs: input.heartbeatIntervalMs,
    longWaitEventMs: input.longWaitEventMs,
    onLongWait: (elapsedMs) => {
      input.recordSessionEvent({
        eventKind: "stream_long_wait",
        component: "stream-heartbeat",
        detail: `OpenAI stream exceeded ${input.longWaitEventMs}ms without finishing`,
        metadataJson: { elapsedMs, model: input.model },
      });
    },
  });
}
