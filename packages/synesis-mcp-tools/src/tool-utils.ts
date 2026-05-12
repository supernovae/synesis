export const LIMITS = {
  queryChars: 4_000,
  shortStringChars: 256,
  mediumStringChars: 2_000,
  codeChars: 200_000,
  contextChars: 50_000,
  patchTextChars: 200_000,
  maxTopK: 20,
  maxGraphDepth: 3,
  maxStringArrayItems: 50,
  maxPackageItems: 50,
  maxPatchOps: 200,
  maxTerraformPlanChars: 1_000_000,
  maxTerraformResources: 500,
  maxFetchPages: 10,
} as const;

export function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function boundedString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  return s.slice(0, maxChars);
}

export function boundedStringArray(value: unknown, maxItems = LIMITS.maxStringArrayItems, maxChars = LIMITS.shortStringChars): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => boundedString(item, maxChars))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

export function sanitizeUpstreamError(error: string, status?: number): Record<string, unknown> {
  const out: Record<string, unknown> = { error };
  if (typeof status === "number") out.status = status;
  out.message = "Upstream request failed";
  return out;
}

export function requestFailure(error: string, cause: unknown): Record<string, unknown> {
  const aborted = cause instanceof Error && cause.name === "AbortError";
  return {
    error: aborted ? "timeout" : error,
    message: aborted ? "Request timed out" : "Request failed",
  };
}

