import { randomUUID } from "node:crypto";

export type WritableRaw = NodeJS.WritableStream & { destroyed?: boolean };

export function safeWrite(raw: WritableRaw, data: string): boolean {
  try {
    if (raw.destroyed) return false;
    raw.write(data);
    return true;
  } catch {
    return false;
  }
}

export function safeSse(reply: { raw: WritableRaw }, event: string, data: unknown): boolean {
  return safeWrite(reply.raw, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function safeEnd(raw: WritableRaw): void {
  try {
    if (!raw.destroyed) raw.end();
  } catch {
    // Already closed.
  }
}

export function startSseHeartbeat(args: {
  raw: WritableRaw & { on?(event: string, listener: () => void): unknown };
  intervalMs: number;
  longWaitEventMs: number;
  onLongWait?: (elapsedMs: number) => void;
}): { stop: () => void } {
  let stopped = false;
  const normalizedInterval = Math.max(1000, Number.isFinite(args.intervalMs) ? args.intervalMs : 15_000);
  const normalizedLongWait = Math.max(
    normalizedInterval,
    Number.isFinite(args.longWaitEventMs) ? args.longWaitEventMs : 45_000,
  );
  const startedAt = Date.now();
  const interval = setInterval(() => {
    if (stopped) return;
    safeWrite(args.raw, ": keep-alive\n\n");
  }, normalizedInterval);
  let longWaitTimer: NodeJS.Timeout | undefined;
  if (args.onLongWait) {
    longWaitTimer = setTimeout(() => {
      if (stopped) return;
      args.onLongWait?.(Date.now() - startedAt);
    }, normalizedLongWait);
  }
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (longWaitTimer) clearTimeout(longWaitTimer);
  };
  args.raw.on?.("close", stop);
  args.raw.on?.("error", stop);
  return { stop };
}

export function resolveRequestId(headers: Record<string, unknown>): string {
  const explicit = headers["x-request-id"] ?? headers["anthropic-request-id"];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return `req-${randomUUID()}`;
}

export function formatValidationError(error: {
  issues?: Array<{ path?: PropertyKey[]; message?: string }>;
  message: string;
}): string {
  const issue = error.issues?.[0];
  if (issue) {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join(".") : "request";
    const message = typeof issue.message === "string" && issue.message.trim() ? issue.message.trim() : "invalid value";
    return `Invalid request: ${path}: ${message}`;
  }
  return `Invalid request: ${error.message.slice(0, 500)}`;
}

export function selectedOpenAiCompatHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization"
      || lower === "user-agent"
      || lower === "x-request-id"
      || lower === "openai-organization"
      || lower === "openai-project"
      || lower.startsWith("x-synesis-")
    ) {
      out[lower] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }
  return out;
}

export function debugProtocolLog(
  logger: { info(obj: Record<string, unknown>, msg: string): void },
  reqId: string,
  path: string,
  extra: Record<string, unknown>,
  enabled: boolean,
): void {
  if (!enabled) return;
  logger.info({ reqId, path, ...extra }, "debug_protocol");
}
