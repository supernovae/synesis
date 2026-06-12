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

function stripControlChars(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (typeof value === "string") return stripControlChars(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleanKey = stripControlChars(key);
      if (!cleanKey) continue;
      const cleanValue = sanitizeJsonValue(item, depth + 1);
      if (cleanValue !== undefined) out[cleanKey] = cleanValue;
    }
    return out;
  }
  return undefined;
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric > 1 && numeric <= 10) return Math.max(0, Math.min(1, numeric / 10));
  return Math.max(0, Math.min(1, numeric));
}

export function sanitizeTraceForIngest(trace: TraceRecord): TraceRecord {
  const sanitized = sanitizeJsonValue(trace) as TraceRecord;
  return {
    ...sanitized,
    spans: (sanitized.spans ?? []).map((span) => ({
      ...span,
      confidence: normalizeConfidence(span.confidence),
    })),
  };
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
  const safeTrace = sanitizeTraceForIngest(trace);

  const url = `${config.adminUrl.replace(/\/$/, "")}/api/v1/traces/ingest`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.adminToken) {
    headers["x-synesis-service-token"] = config.adminToken;
    headers["x-synesis-service-name"] = safeTrace.service;
    headers["authorization"] = `Bearer ${config.adminToken}`;
  }
  if (safeTrace.request_id) {
    headers["x-request-id"] = safeTrace.request_id;
  }
  if (safeTrace.authz_trace_id) {
    headers["x-synesis-authz-trace-id"] = safeTrace.authz_trace_id;
  }

  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(safeTrace),
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
        `trace emit HTTP ${resp.status} for ${safeTrace.trace_id}: ${resp.statusText}${detail}`,
      );
    }
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`trace emit failed: ${msg}`);
  });
}
