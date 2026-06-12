import type { TraceRecord } from "./types.js";

export interface TraceEmitterConfig {
  adminUrl: string;
  adminToken: string;
  timeoutMs?: number;
}

function sanitizeTraceEmitErrorBody(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as { detail?: unknown };
    if (Array.isArray(parsed.detail)) {
      const detail = parsed.detail.slice(0, 12).map((item) => {
        if (!item || typeof item !== "object") return item;
        const record = item as Record<string, unknown>;
        return {
          loc: record.loc,
          msg: record.msg,
          type: record.type,
        };
      });
      return JSON.stringify({ detail }).slice(0, 2048);
    }
  } catch {
    // Fall back to a short sanitized text body below.
  }

  return [...trimmed]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .slice(0, 512);
}

/**
 * Fire-and-forget POST to admin /api/v1/traces/ingest.
 * Never blocks the response path; failures are logged and swallowed.
 */
export function emitTrace(
  trace: TraceRecord,
  config: TraceEmitterConfig,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): void {
  if (!config.adminUrl) return;

  const url = `${config.adminUrl.replace(/\/$/, "")}/api/v1/traces/ingest`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.adminToken) {
    headers["x-synesis-service-token"] = config.adminToken;
    headers["x-synesis-service-name"] = trace.service;
    headers["authorization"] = `Bearer ${config.adminToken}`;
  }
  if (trace.request_id) {
    headers["x-request-id"] = trace.request_id;
  }
  if (trace.authz_trace_id) {
    headers["x-synesis-authz-trace-id"] = trace.authz_trace_id;
  }

  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(trace),
    signal: AbortSignal.timeout(config.timeoutMs ?? 3000),
  }).then(async (resp) => {
    if (!resp.ok) {
      let sanitized: string | undefined;
      try {
        const body = await resp.text();
        sanitized = sanitizeTraceEmitErrorBody(body);
      } catch {
        sanitized = undefined;
      }
      const detail = sanitized ? ` detail=${sanitized}` : "";
      logger?.warn(
        `trace emit HTTP ${resp.status} for ${trace.trace_id}: ${resp.statusText}${detail}`,
      );
    }
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`trace emit failed: ${msg}`);
  });
}
