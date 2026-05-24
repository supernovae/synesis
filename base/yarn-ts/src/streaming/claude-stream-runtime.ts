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
