import { createStreamAbortRuntime } from "./stream-abort-runtime.js";
import {
  startStreamSseRuntime,
  type StreamHeartbeat,
  type StreamSseRaw,
} from "./stream-sse-runtime.js";

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

export type OpenAIStreamSseRaw = StreamSseRaw;

export type OpenAIStreamHeartbeat = StreamHeartbeat;

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
  return startStreamSseRuntime({
    raw: input.raw,
    headers: input.headers,
    protocolLabel: "OpenAI",
    model: input.model,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    longWaitEventMs: input.longWaitEventMs,
    startHeartbeat: input.startHeartbeat,
    recordSessionEvent: input.recordSessionEvent,
  });
}
