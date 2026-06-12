import { redactPatterns } from "./scanner.js";

const MASKED_SECRET_FRAGMENT = /\b[A-Za-z0-9_-]{1,24}\*{2,}[A-Za-z0-9_-]{1,24}\b/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_FIELD = /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"',}\s]+/gi;

export function redactOperationalError(detail: string): string {
  return redactPatterns(detail)
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_FIELD, "$1=[REDACTED]")
    .replace(MASKED_SECRET_FRAGMENT, "[REDACTED]")
    .slice(0, 500);
}

export function summarizeOperationalError(detail: string): string {
  const lowered = detail.toLowerCase();
  if (
    lowered.includes("api key") ||
    lowered.includes("unauthorized") ||
    lowered.includes("forbidden") ||
    lowered.includes("authentication") ||
    lowered.includes("invalid-argument")
  ) {
    return "LLM provider authentication failed";
  }
  if (lowered.includes("timeout") || lowered.includes("abort")) {
    return "LLM provider request timed out";
  }
  if (lowered.includes("circuit breaker")) {
    return "LLM provider circuit breaker is open";
  }
  if (lowered.includes("rate limit") || lowered.includes("too many requests") || lowered.includes("http 429")) {
    return "LLM provider rate limit exceeded";
  }
  if (lowered.includes("fetch failed") || lowered.includes("network") || lowered.includes("socket")) {
    return "LLM provider network request failed";
  }
  return redactOperationalError(detail);
}
