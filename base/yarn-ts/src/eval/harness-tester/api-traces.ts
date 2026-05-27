import type { HarnessTesterApiTraceSummary } from "./types.js";

export async function fetchHarnessTesterApiTraceSummary(params: {
  adminUrl?: string;
  adminToken?: string;
  sessionKey: string;
}): Promise<HarnessTesterApiTraceSummary> {
  if (!params.adminUrl || !params.adminToken) {
    return {
      available: false,
      sessionKey: params.sessionKey,
      eventCount: 0,
      fatalErrors: 0,
      schemaErrors: 0,
      toolErrors: 0,
      error: "Admin URL/token not configured; API trace correlation skipped.",
    };
  }
  try {
    const url = new URL("/api/v1/yarn/session-events", params.adminUrl);
    url.searchParams.set("session_key", params.sessionKey);
    url.searchParams.set("limit", "500");
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${params.adminToken}`,
      },
    });
    if (!response.ok) {
      return {
        available: false,
        sessionKey: params.sessionKey,
        eventCount: 0,
        fatalErrors: 0,
        schemaErrors: 0,
        toolErrors: 0,
        error: `${response.status} ${response.statusText}`,
      };
    }
    const events = await response.json();
    const text = JSON.stringify(events);
    return {
      available: true,
      sessionKey: params.sessionKey,
      eventCount: Array.isArray(events) ? events.length : countEventLikeObjects(events),
      fatalErrors: countMatches(text, /fatal|hard_stop|uncaught|500|provider_error/gi),
      schemaErrors: countMatches(text, /SchemaError|invalid_tool|invalid arguments|schema/gi),
      toolErrors: countMatches(text, /tool_call_parse|invalid_tool_result|tool error|tool_use/gi),
      events,
    };
  } catch (error) {
    return {
      available: false,
      sessionKey: params.sessionKey,
      eventCount: 0,
      fatalErrors: 0,
      schemaErrors: 0,
      toolErrors: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function countEventLikeObjects(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const maybeEvents = value as { events?: unknown; rows?: unknown; data?: unknown };
  if (Array.isArray(maybeEvents.events)) return maybeEvents.events.length;
  if (Array.isArray(maybeEvents.rows)) return maybeEvents.rows.length;
  if (Array.isArray(maybeEvents.data)) return maybeEvents.data.length;
  return 0;
}
