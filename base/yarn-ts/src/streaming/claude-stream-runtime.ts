import type { OpenAIStreamHeartbeat, OpenAIStreamRuntimeEventRecorder, OpenAIStreamSseRaw } from "./openai-stream-runtime.js";

export interface ClaudeStreamSseRuntimeInput {
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

export interface ClaudeStreamRouteRuntimeInput extends Omit<ClaudeStreamSseRuntimeInput, "recordSessionEvent"> {
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  createMessageId(): string;
  sendSse(event: string, data: unknown): boolean;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId: string,
    metadataJson?: Record<string, unknown>,
  ): void;
}

export interface ClaudeStreamRouteRuntime {
  heartbeat: OpenAIStreamHeartbeat;
  messageId: string;
}

export function startClaudeStreamSseRuntime(
  input: ClaudeStreamSseRuntimeInput,
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
        detail: `Claude stream exceeded ${input.longWaitEventMs}ms without finishing`,
        metadataJson: { elapsedMs, model: input.model },
      });
    },
  });
}

export function startClaudeStreamRouteRuntime(
  input: ClaudeStreamRouteRuntimeInput,
): ClaudeStreamRouteRuntime {
  const heartbeat = startClaudeStreamSseRuntime({
    raw: input.raw,
    headers: input.headers,
    model: input.model,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    longWaitEventMs: input.longWaitEventMs,
    startHeartbeat: input.startHeartbeat,
    recordSessionEvent: (event) => input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      event.eventKind,
      event.component,
      event.detail,
      input.requestId,
      event.metadataJson,
    ),
  });
  const messageId = input.createMessageId();
  input.sendSse("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: input.model,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  return { heartbeat, messageId };
}
