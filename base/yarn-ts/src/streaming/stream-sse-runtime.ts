import type { StreamRouteEvent } from "./stream-route-scope.js";

export interface StreamSseRaw extends NodeJS.WritableStream {
  destroyed?: boolean;
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
}

export interface StreamHeartbeat {
  stop(): void;
}

export interface StreamSseRuntimeInput {
  raw: StreamSseRaw;
  headers: Record<string, string>;
  protocolLabel: string;
  model: string;
  heartbeatIntervalMs: number;
  longWaitEventMs: number;
  startHeartbeat(input: {
    raw: StreamSseRaw;
    intervalMs: number;
    longWaitEventMs: number;
    onLongWait?: (elapsedMs: number) => void;
  }): StreamHeartbeat;
  recordSessionEvent(event: StreamRouteEvent): void;
}

export function startStreamSseRuntime(input: StreamSseRuntimeInput): StreamHeartbeat {
  input.raw.writeHead(200, input.headers);
  return input.startHeartbeat({
    raw: input.raw,
    intervalMs: input.heartbeatIntervalMs,
    longWaitEventMs: input.longWaitEventMs,
    onLongWait: (elapsedMs) => {
      input.recordSessionEvent({
        eventKind: "stream_long_wait",
        component: "stream-heartbeat",
        detail: `${input.protocolLabel} stream exceeded ${input.longWaitEventMs}ms without finishing`,
        metadataJson: { elapsedMs, model: input.model },
      });
    },
  });
}
