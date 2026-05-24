import type { StreamRouteEvent } from "./stream-route-scope.js";

export interface StreamAbortRuntimeInput {
  protocolLabel: string;
  model: string;
  startedAtMs: number;
  longWaitEventMs: number;
  hardTimeoutMs: number;
  recordSessionEvent(event: StreamRouteEvent): void;
}

export interface StreamAbortRuntime {
  abortController: AbortController;
  hardTimeout: ReturnType<typeof setTimeout>;
  hardTimeoutMs: number;
}

export function createStreamAbortRuntime(input: StreamAbortRuntimeInput): StreamAbortRuntime {
  const abortController = new AbortController();
  const hardTimeoutMs = Math.max(input.longWaitEventMs + 5_000, input.hardTimeoutMs);
  const hardTimeout = setTimeout(() => {
    input.recordSessionEvent({
      eventKind: "stream_hard_timeout",
      component: "stream-heartbeat",
      detail: `Aborted ${input.protocolLabel} stream after ${hardTimeoutMs}ms`,
      metadataJson: {
        elapsedMs: Date.now() - input.startedAtMs,
        model: input.model,
      },
    });
    abortController.abort(new Error("stream_hard_timeout"));
  }, hardTimeoutMs);

  return {
    abortController,
    hardTimeout,
    hardTimeoutMs,
  };
}
