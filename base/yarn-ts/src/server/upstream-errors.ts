export interface UpstreamErrorDiagnostics {
  userMessage: string;
  rawMessage: string;
  errorName?: string;
  errorCode?: string;
  httpStatus?: number;
  isVercelAiSdkError: boolean;
  isMissingToolResults: boolean;
}

export function sanitizeUpstreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/timed?\s*out/i.test(raw)) return "Upstream model request timed out";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(raw)) return "Upstream model service unavailable";
  if (/\b[45]\d{2}\b/.test(raw)) return "Upstream model service error";
  if (/rate.?limit/i.test(raw)) return "Upstream rate limit exceeded";
  if (/context.?length|too.?long|too.?large/i.test(raw)) return "Request too large for model context window";
  if (/MissingToolResults|missing tool results?/i.test(raw)) return "Internal message integrity error (missing tool results)";
  return "Model request failed";
}

export function extractUpstreamErrorDiagnostics(err: unknown): UpstreamErrorDiagnostics {
  const row = (typeof err === "object" && err !== null) ? (err as Record<string, unknown>) : {};
  const rawMessage = err instanceof Error ? err.message : String(err);
  const errorNameRaw =
    (err instanceof Error ? err.name : undefined)
    ?? (typeof row.name === "string" ? row.name : undefined);
  const errorCodeRaw =
    (typeof row.code === "string" || typeof row.code === "number")
      ? String(row.code)
      : undefined;
  const httpStatusRaw =
    typeof row.statusCode === "number"
      ? row.statusCode
      : (typeof row.status === "number" ? row.status : undefined);
  const stackText = err instanceof Error ? String(err.stack ?? "") : "";
  const isMissingToolResults =
    /MissingToolResultsError/i.test(rawMessage)
    || /MissingToolResultsError/i.test(stackText)
    || /missing tool results?/i.test(rawMessage);
  const isVercelAiSdkError =
    /^AI[_A-Z]/.test(String(errorNameRaw ?? ""))
    || /\b@?vercel\/ai\b/i.test(stackText)
    || isMissingToolResults;
  return {
    userMessage: sanitizeUpstreamError(err),
    rawMessage,
    errorName: errorNameRaw,
    errorCode: errorCodeRaw,
    httpStatus: httpStatusRaw,
    isVercelAiSdkError,
    isMissingToolResults,
  };
}
