import type { AdminMcpConfig } from "./config.js";

export type AdminRole = "readonly" | "user" | "org_admin" | "platform_admin" | "admin";

const ROLE_RANK: Record<AdminRole, number> = {
  readonly: 0,
  user: 1,
  org_admin: 2,
  platform_admin: 3,
  admin: 3,
};

export interface SessionUser {
  role?: string;
  username?: string;
  user_id?: string;
  org_id?: string;
  org_name?: string;
}

export interface AdminToolDescriptor {
  name: string;
  description: string;
  min_role: "org_admin" | "platform_admin";
  inputSchema: Record<string, unknown>;
}

interface ToolContext {
  cfg: AdminMcpConfig;
  authHeader: string;
  orgHeaders: Record<string, string>;
}

interface AdminToolDefinition extends AdminToolDescriptor {
  invoke: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asBool(v: unknown, defaultValue = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return defaultValue;
}

function asInt(v: unknown, defaultValue: number, min: number, max: number): number {
  let n = defaultValue;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = Math.trunc(v);
  } else if (typeof v === "string") {
    const parsed = Number.parseInt(v, 10);
    if (Number.isFinite(parsed)) n = parsed;
  }
  return Math.max(min, Math.min(max, n));
}

function asNumber(v: unknown, defaultValue: number, min: number, max: number): number {
  let n = defaultValue;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = v;
  } else if (typeof v === "string") {
    const parsed = Number.parseFloat(v);
    if (Number.isFinite(parsed)) n = parsed;
  }
  return Math.max(min, Math.min(max, n));
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const text = asString(item).trim();
    if (text) out.push(text);
  }
  return out;
}

function isHttpNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\(404\)/.test(message);
}

function stripWrappingQuotes(value: string): string {
  let out = value.trim();
  // Strip common wrapper quotes/backticks users often paste.
  while (
    out.length >= 2
    && (
      (out.startsWith("\"") && out.endsWith("\""))
      || (out.startsWith("'") && out.endsWith("'"))
      || (out.startsWith("`") && out.endsWith("`"))
    )
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function buildSessionKeyCandidates(rawInput: unknown): string[] {
  const raw = asString(rawInput).trim();
  if (!raw) return [];
  const out: string[] = [];
  const add = (value: string) => {
    const v = value.trim();
    if (!v || out.includes(v)) return;
    out.push(v);
  };

  const stripped = stripWrappingQuotes(raw);
  add(stripped);

  // If user pasted surrounding text, recover explicit synesis session keys.
  for (const match of stripped.matchAll(/synesis:[^\s"'`]+/gi)) {
    add(match[0]);
  }

  // Accept URL-encoded keys from copied links.
  for (const value of [...out]) {
    if (!/%[0-9a-f]{2}/i.test(value)) continue;
    try {
      add(decodeURIComponent(value));
    } catch {
      // Ignore malformed encoded values.
    }
  }

  // If a full key was provided, also keep just the trailing UUID conversation tail
  // for fuzzy fallback matching against recent sessions.
  const tailMatch = stripped.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (tailMatch) add(tailMatch[0]);

  return out;
}

async function resolveSessionKeyFromRecentSessions(
  ctx: ToolContext,
  candidates: string[],
): Promise<string | null> {
  const lowerCandidates = candidates.map((v) => v.toLowerCase());
  let page = 1;
  const pageSize = 100;
  let total = Number.POSITIVE_INFINITY;

  while ((page - 1) * pageSize < total && page <= 10) {
    const payload = await apiRequest(ctx, "GET", "/api/v1/yarn/sessions", {
      page,
      page_size: pageSize,
      active_since_hours: 8760,
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) break;
    const record = payload as { sessions?: unknown; total?: unknown };
    const sessions = Array.isArray(record.sessions) ? record.sessions : [];
    total = typeof record.total === "number" && Number.isFinite(record.total) ? record.total : sessions.length;

    for (const row of sessions) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const session = row as { session_key?: unknown; conversation_id?: unknown };
      const key = asString(session.session_key).trim();
      const conversationId = asString(session.conversation_id).trim();
      if (!key) continue;
      const lowerKey = key.toLowerCase();
      const lowerConversation = conversationId.toLowerCase();
      if (
        lowerCandidates.includes(lowerKey)
        || lowerCandidates.includes(lowerConversation)
        || lowerCandidates.some((candidate) => candidate.length >= 8 && lowerKey.endsWith(candidate))
      ) {
        return key;
      }
    }
    page += 1;
  }

  return null;
}

function queryString(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      if (!v.trim()) continue;
      q.set(k, v);
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      q.set(k, String(v));
      continue;
    }
    if (typeof v === "boolean") {
      q.set(k, v ? "true" : "false");
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        const text = asString(item).trim();
        if (!text) continue;
        q.append(k, text);
      }
    }
  }
  const built = q.toString();
  return built ? `?${built}` : "";
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildApiUrl(ctx: ToolContext, path: string, params?: Record<string, unknown>): string {
  const base = ctx.cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, "");
  return `${base}${path}${queryString(params ?? {})}`;
}

async function apiRequest(
  ctx: ToolContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  params?: Record<string, unknown>,
  body?: unknown,
): Promise<unknown> {
  const url = buildApiUrl(ctx, path, params);
  const headers: Record<string, string> = {
    Authorization: ctx.authHeader,
    ...ctx.orgHeaders,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error(`${method} ${path} failed (${response.status}): ${msg}`);
  }
  return parsed;
}

async function getTransitionQuality(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const sinceHours = asInt(args.since_hours, 168, 1, 720);
  const bucketMinutes = asInt(args.bucket_minutes, 60, 5, 60);
  return apiRequest(
    ctx,
    "GET",
    "/api/v1/yarn/transition-quality",
    { since_hours: sinceHours, bucket_minutes: bucketMinutes },
  );
}

async function getTransitionEvents(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const sinceMinutes = asInt(args.since_minutes, 60, 1, 1440);
  const limit = asInt(args.limit, 100, 1, 500);
  const afterId = asInt(args.after_id, 0, 0, Number.MAX_SAFE_INTEGER);
  const riskOnly = asBool(args.risk_only, true);
  const includeMetadata = asBool(args.include_metadata, false);
  const eventKinds = asStringArray(args.event_kinds);
  return apiRequest(
    ctx,
    "GET",
    "/api/v1/yarn/transition-events",
    {
      since_minutes: sinceMinutes,
      limit,
      after_id: afterId,
      risk_only: riskOnly,
      include_metadata: includeMetadata,
      event_kinds: eventKinds,
    },
  );
}

const TOOL_DEFINITIONS: AdminToolDefinition[] = [
  {
    name: "list_traces",
    description:
      "List recent traces with optional filters (same data as GET /api/v1/traces). Supports trace_service, conversation_id, decision_path, tenant_id, and offset.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 20, description: "Max results (max 100)" },
        offset: { type: "integer", default: 0, description: "Pagination offset" },
        has_error: { type: "boolean", description: "Filter error traces" },
        task_type: { type: "string", description: "Filter by task type" },
        since_hours: { type: "integer", description: "If set, only traces newer than this many hours ago" },
        trace_service: { type: "string", description: "Filter by emitter: planner, yarn, or all" },
        conversation_id: { type: "string", description: "Filter by conversation / session id" },
        decision_path: { type: "string", description: "Filter by routing path" },
        tenant_id: { type: "string", description: "Optional tenant filter" },
        user_id: { type: "string", description: "Optional user id filter (within RBAC scope)" },
        org_id: { type: "string", description: "Optional org id filter (within RBAC scope)" },
      },
    },
    invoke: async (ctx, args) => {
      const sinceHours = asInt(args.since_hours, 0, 0, 720);
      return apiRequest(ctx, "GET", "/api/v1/traces", {
        limit: asInt(args.limit, 20, 1, 100),
        offset: asInt(args.offset, 0, 0, 100_000),
        has_error: typeof args.has_error === "boolean" ? args.has_error : undefined,
        task_type: asString(args.task_type),
        trace_service: asString(args.trace_service),
        conversation_id: asString(args.conversation_id),
        decision_path: asString(args.decision_path),
        tenant_id: asString(args.tenant_id),
        user_id: asString(args.user_id),
        org_id: asString(args.org_id),
        since: sinceHours > 0 ? nowUnixSeconds() - sinceHours * 3600 : undefined,
      });
    },
  },
  {
    name: "get_trace",
    description: "Get full detail for a single trace by ID. Scoped to the caller role.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { trace_id: { type: "string", description: "The trace ID to look up" } },
      required: ["trace_id"],
    },
    invoke: async (ctx, args) => {
      const traceId = asString(args.trace_id).trim();
      if (!traceId) throw new Error("trace_id required");
      return apiRequest(ctx, "GET", `/api/v1/traces/${encodeURIComponent(traceId)}`);
    },
  },
  {
    name: "trace_stats",
    description: "Aggregate trace statistics (last 24h), same as GET /api/v1/traces/stats.",
    min_role: "org_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "GET", "/api/v1/traces/stats"),
  },
  {
    name: "trace_decision_analytics",
    description:
      "Decision-path and verification analytics from trace JSONB (GET /api/v1/traces/analytics).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24, description: "Start of window in hours ago" },
        org_id: { type: "string", description: "Optional org filter" },
      },
    },
    invoke: async (ctx, args) => {
      const sinceHours = asInt(args.since_hours, 24, 1, 720);
      return apiRequest(ctx, "GET", "/api/v1/traces/analytics", {
        since: nowUnixSeconds() - sinceHours * 3600,
        org_id: asString(args.org_id),
      });
    },
  },
  {
    name: "usage_summary",
    description: "Pre-aggregated usage/cost summary from usage traces (GET /api/v1/usage/summary).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", default: 24, description: "Lookback hours" } },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/usage/summary", { since_hours: asInt(args.since_hours, 24, 1, 720) }),
  },
  {
    name: "usage_time_series",
    description: "Hourly usage buckets (GET /api/v1/usage).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", default: 24, description: "Lookback hours (1-720)" } },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/usage", { since_hours: asInt(args.since_hours, 24, 1, 720) }),
  },
  {
    name: "unified_usage_snapshot",
    description:
      "Full usage and cost snapshot: pipeline trace totals + Yarn usage for org_admin+ (GET /api/v1/usage/summary-unified).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", default: 24, description: "Lookback hours" } },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/usage/summary-unified", {
        since_hours: asInt(args.since_hours, 24, 1, 720),
      }),
  },
  {
    name: "yarn_overview",
    description: "Yarn ops overview: sessions, tokens, costs (GET /api/v1/yarn/overview).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", default: 24, description: "Lookback hours" } },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/yarn/overview", { since_hours: asInt(args.since_hours, 24, 1, 720) }),
  },
  {
    name: "yarn_intelligence",
    description: "Yarn intelligence rollup for the period (GET /api/v1/yarn/intelligence).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", default: 24, description: "Lookback hours" } },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/yarn/intelligence", { since_hours: asInt(args.since_hours, 24, 1, 720) }),
  },
  {
    name: "yarn_sessions",
    description: "List Yarn IDE sessions (GET /api/v1/yarn/sessions).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 20, description: "Max 100" },
        active_since_hours: { type: "integer", default: 168, description: "Only sessions active in this window" },
      },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/yarn/sessions", {
        page: asInt(args.page, 1, 1, 10_000),
        page_size: asInt(args.page_size, 20, 1, 100),
        active_since_hours: asInt(args.active_since_hours, 168, 1, 8760),
      }),
  },
  {
    name: "yarn_session_detail",
    description: "Full detail for one Yarn session by session_key (GET /api/v1/yarn/sessions/{key}).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { session_key: { type: "string", description: "Yarn session key" } },
      required: ["session_key"],
    },
    invoke: async (ctx, args) => {
      const candidates = buildSessionKeyCandidates(args.session_key);
      if (candidates.length === 0) throw new Error("session_key required");

      let lastNotFound: Error | null = null;
      for (const key of candidates) {
        try {
          return await apiRequest(ctx, "GET", `/api/v1/yarn/sessions/${encodeURIComponent(key)}`);
        } catch (error) {
          if (!isHttpNotFoundError(error)) throw error;
          lastNotFound = error instanceof Error ? error : new Error(String(error));
        }
      }

      const resolvedKey = await resolveSessionKeyFromRecentSessions(ctx, candidates);
      if (resolvedKey) {
        return apiRequest(ctx, "GET", `/api/v1/yarn/sessions/${encodeURIComponent(resolvedKey)}`);
      }
      if (lastNotFound) {
        throw new Error(
          `${lastNotFound.message} (tried normalized keys: ${candidates.join(", ")})`,
        );
      }
      throw new Error("Session not found");
    },
  },
  {
    name: "yarn_performance",
    description: "Yarn latency and throughput buckets (GET /api/v1/yarn/performance).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        bucket_minutes: { type: "integer", default: 15, description: "Bucket size 5-60" },
      },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/yarn/performance", {
        since_hours: asInt(args.since_hours, 24, 1, 720),
        bucket_minutes: asInt(args.bucket_minutes, 15, 5, 60),
      }),
  },
  {
    name: "yarn_events",
    description: "Yarn usage events and errors (GET /api/v1/yarn/events).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", default: 1 },
        page_size: { type: "integer", default: 50 },
        since_hours: { type: "integer", default: 24 },
        errors_only: { type: "boolean", default: false },
      },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/yarn/events", {
        page: asInt(args.page, 1, 1, 10_000),
        page_size: asInt(args.page_size, 50, 1, 200),
        since_hours: asInt(args.since_hours, 24, 1, 720),
        errors_only: asBool(args.errors_only, false),
      }),
  },
  {
    name: "yarn_safety_summary",
    description: "Yarn safety / policy events summary (GET /api/v1/yarn/safety-summary).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", default: 24 } },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/yarn/safety-summary", {
        since_hours: asInt(args.since_hours, 24, 1, 720),
      }),
  },
  {
    name: "yarn_transition_quality",
    description: "Transition quality calibration trends and alerts (GET /api/v1/yarn/transition-quality).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 168, description: "Lookback hours (1-720)" },
        bucket_minutes: { type: "integer", default: 60, description: "Bucket size 5-60" },
      },
    },
    invoke: async (ctx, args) => getTransitionQuality(ctx, args),
  },
  {
    name: "yarn_transition_events_tail",
    description:
      "Tail transition-quality events with risk extraction (GET /api/v1/yarn/transition-events).",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_minutes: { type: "integer", default: 60, description: "Lookback minutes (1-1440)" },
        limit: { type: "integer", default: 100, description: "Max events (1-500)" },
        after_id: { type: "integer", default: 0, description: "Return only events with id > after_id" },
        risk_only: { type: "boolean", default: true, description: "Include only risk-bearing events" },
        include_metadata: { type: "boolean", default: false, description: "Include full metadata_json payloads" },
        event_kinds: {
          type: "array",
          items: { type: "string" },
          description: "Optional event-kind allowlist",
        },
      },
    },
    invoke: async (ctx, args) => getTransitionEvents(ctx, args),
  },
  {
    name: "yarn_transition_watch",
    description:
      "Watch transition quality over a short live window by polling trend and event tails.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        bucket_minutes: { type: "integer", default: 15 },
        events_since_minutes: { type: "integer", default: 30 },
        event_limit: { type: "integer", default: 120 },
        after_id: { type: "integer", default: 0 },
        risk_only: { type: "boolean", default: true },
        include_metadata: { type: "boolean", default: false },
        polls: { type: "integer", default: 4, description: "Number of polling iterations (1-12)" },
        interval_seconds: { type: "number", default: 5, description: "Pause between polls (1-30 sec)" },
      },
    },
    invoke: async (ctx, args) => {
      const polls = asInt(args.polls, 4, 1, 12);
      const intervalSeconds = asNumber(args.interval_seconds, 5, 1, 30);
      const sinceHours = asInt(args.since_hours, 24, 1, 720);
      const bucketMinutes = asInt(args.bucket_minutes, 15, 5, 60);
      const eventsSinceMinutes = asInt(args.events_since_minutes, 30, 1, 1440);
      const eventLimit = asInt(args.event_limit, 120, 1, 300);
      const riskOnly = asBool(args.risk_only, true);
      const includeMetadata = asBool(args.include_metadata, false);
      let cursor = asInt(args.after_id, 0, 0, Number.MAX_SAFE_INTEGER);

      const frames: Array<Record<string, unknown>> = [];
      const collectedEvents: Array<Record<string, unknown>> = [];
      const seen = new Set<number>();
      let qualitySnapshot: Record<string, unknown> = {};
      const watchStartedAt = new Date().toISOString();

      for (let idx = 0; idx < polls; idx += 1) {
        const qualityRaw = await getTransitionQuality(ctx, {
          since_hours: sinceHours,
          bucket_minutes: bucketMinutes,
        });
        const quality =
          qualityRaw && typeof qualityRaw === "object" ? (qualityRaw as Record<string, unknown>) : {};
        qualitySnapshot = quality;
        const tailRaw = await getTransitionEvents(ctx, {
          since_minutes: eventsSinceMinutes,
          limit: eventLimit,
          after_id: cursor,
          risk_only: riskOnly,
          include_metadata: includeMetadata,
        });
        const tail = tailRaw && typeof tailRaw === "object" ? (tailRaw as Record<string, unknown>) : {};
        const nextAfter = asInt(tail.next_after_id, cursor, 0, Number.MAX_SAFE_INTEGER);
        cursor = Math.max(cursor, nextAfter);
        const events = Array.isArray(tail.events) ? (tail.events as Array<Record<string, unknown>>) : [];

        const newEvents: Array<Record<string, unknown>> = [];
        for (const ev of events) {
          const id = asInt(ev.id, 0, 0, Number.MAX_SAFE_INTEGER);
          if (id <= 0 || seen.has(id)) continue;
          seen.add(id);
          newEvents.push(ev);
          collectedEvents.push(ev);
        }

        const summary =
          quality.summary && typeof quality.summary === "object"
            ? (quality.summary as Record<string, unknown>)
            : {};

        frames.push({
          iteration: idx + 1,
          captured_at: new Date().toISOString(),
          quality_score_avg: summary.quality_score_avg,
          regressed_rate_avg: summary.regressed_rate_avg,
          reground_required_rate_avg: summary.reground_required_rate_avg,
          global_scope_coverage_avg: summary.global_scope_coverage_avg,
          risk_flags: Array.isArray(summary.risk_flags) ? summary.risk_flags : [],
          new_event_count: newEvents.length,
          next_after_id: cursor,
          new_events: newEvents,
        });

        if (idx < polls - 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalSeconds * 1000));
        }
      }

      const finalSummary =
        qualitySnapshot.summary && typeof qualitySnapshot.summary === "object"
          ? (qualitySnapshot.summary as Record<string, unknown>)
          : {};
      const actions = Array.isArray(qualitySnapshot.actions) ? qualitySnapshot.actions : [];
      return {
        watch: {
          started_at: watchStartedAt,
          ended_at: new Date().toISOString(),
          polls,
          interval_seconds: intervalSeconds,
          since_hours: sinceHours,
          bucket_minutes: bucketMinutes,
          events_since_minutes: eventsSinceMinutes,
          event_limit: eventLimit,
          risk_only: riskOnly,
          next_after_id: cursor,
        },
        final_quality_summary: finalSummary,
        recommended_actions: actions,
        frames,
        events: collectedEvents.slice(-200),
      };
    },
  },
  {
    name: "yarn_transition_incident_brief",
    description:
      "Generate an operator-ready transition-quality incident brief from trends + recent risk events.",
    min_role: "org_admin",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", default: 24 },
        bucket_minutes: { type: "integer", default: 15 },
        events_since_minutes: { type: "integer", default: 180 },
        event_limit: { type: "integer", default: 150 },
      },
    },
    invoke: async (ctx, args) => {
      const sinceHours = asInt(args.since_hours, 24, 1, 720);
      const bucketMinutes = asInt(args.bucket_minutes, 15, 5, 60);
      const eventsSinceMinutes = asInt(args.events_since_minutes, 180, 1, 1440);
      const eventLimit = asInt(args.event_limit, 150, 1, 300);

      const qualityRaw = await getTransitionQuality(ctx, {
        since_hours: sinceHours,
        bucket_minutes: bucketMinutes,
      });
      const quality = qualityRaw && typeof qualityRaw === "object" ? (qualityRaw as Record<string, unknown>) : {};
      const tailRaw = await getTransitionEvents(ctx, {
        since_minutes: eventsSinceMinutes,
        limit: eventLimit,
        risk_only: true,
        include_metadata: false,
      });
      const tail = tailRaw && typeof tailRaw === "object" ? (tailRaw as Record<string, unknown>) : {};

      const summary =
        quality.summary && typeof quality.summary === "object"
          ? (quality.summary as Record<string, unknown>)
          : {};
      const riskFlags = Array.isArray(summary.risk_flags) ? summary.risk_flags.map((r) => asString(r)) : [];
      const topReasons = Array.isArray(quality.top_quality_reasons) ? quality.top_quality_reasons : [];
      const actions = Array.isArray(quality.actions) ? quality.actions : [];
      const events = Array.isArray(tail.events) ? (tail.events as Array<Record<string, unknown>>) : [];
      const latestEvent = events.length > 0 ? events[events.length - 1] : null;

      const findings: string[] = [];
      if (riskFlags.includes("high_regressed_rate")) {
        findings.push("Regressed transition rate is above warning threshold.");
      }
      if (riskFlags.includes("high_reground_required_rate")) {
        findings.push("Re-ground required rate is elevated; file-state confidence may be degrading.");
      }
      if (riskFlags.includes("low_global_scope_coverage")) {
        findings.push("Global scope coverage is low; check calibrator scope key stability.");
      }
      if (riskFlags.includes("low_quality_score_coverage")) {
        findings.push("Quality score coverage is low; verify state_transition_quality_score training signals are emitted.");
      }
      if (riskFlags.includes("missing_global_calibration_events")) {
        findings.push("No global calibration events observed in the active analysis window.");
      }
      if (findings.length === 0) {
        findings.push("No major window-level transition quality alerts are active.");
      }

      return {
        window: {
          since_hours: sinceHours,
          bucket_minutes: bucketMinutes,
          events_since_minutes: eventsSinceMinutes,
          event_limit: eventLimit,
        },
        quality_summary: summary,
        risk_flags: riskFlags,
        priority_findings: findings,
        top_quality_reasons: topReasons.slice(0, 6),
        recommended_actions: actions.slice(0, 6),
        event_tail: {
          count: asInt(tail.count, 0, 0, Number.MAX_SAFE_INTEGER),
          session_count: asInt(tail.session_count, 0, 0, Number.MAX_SAFE_INTEGER),
          request_count: asInt(tail.request_count, 0, 0, Number.MAX_SAFE_INTEGER),
          counts_by_kind:
            tail.counts_by_kind && typeof tail.counts_by_kind === "object" ? tail.counts_by_kind : {},
          latest_event: latestEvent,
          events: events.slice(-20),
        },
        next_best_questions: [
          "Which sessions dominate regressed transitions and what quality reasons repeat?",
          "Are global calibration events lagging behind local calibration in this period?",
          "Do risk spikes correlate with specific models or finish reasons?",
        ],
      };
    },
  },
  {
    name: "service_health",
    description: "Check health of all Synesis services.",
    min_role: "org_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "GET", "/api/v1/observability/health"),
  },
  {
    name: "list_models",
    description: "List active model role assignments.",
    min_role: "org_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "GET", "/api/v1/models/roles"),
  },
  {
    name: "cache_metrics",
    description: "Prefix cache hit rates, token savings, and session stats.",
    min_role: "org_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "GET", "/api/v1/observability/cache"),
  },
  {
    name: "circuit_breakers",
    description: "Current circuit breaker states for LLM, web search, and infra.",
    min_role: "org_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "GET", "/api/v1/observability/circuit-breakers"),
  },
  {
    name: "knowledge_gap_stats",
    description: "RAG corpus knowledge gap statistics.",
    min_role: "org_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "GET", "/api/v1/observability/knowledge-gaps/stats"),
  },
  {
    name: "refresh_model_routes",
    description: "Report the direct model route source of truth. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: { type: "object", properties: {} },
    invoke: async (ctx) => apiRequest(ctx, "POST", "/api/v1/models/reconcile"),
  },
  {
    name: "purge_trivial_traces",
    description: "Dry-run count or delete traces below a token threshold. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        min_tokens: { type: "integer", default: 50 },
        dry_run: { type: "boolean", default: true },
      },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "POST", "/api/v1/traces/purge-trivial", {
        min_tokens: asInt(args.min_tokens, 50, 1, 1_000_000),
        dry_run: asBool(args.dry_run, true),
      }),
  },
  {
    name: "ingestion_list_items",
    description: "List ingestion queue items with filters. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status" },
        handler: { type: "string", description: "Filter by handler type" },
        limit: { type: "integer", default: 20, description: "Max results" },
      },
    },
    invoke: async (ctx, args) =>
      apiRequest(ctx, "GET", "/api/v1/ingestion/items", {
        status: asString(args.status),
        handler: asString(args.handler),
        page: 1,
        page_size: asInt(args.limit, 20, 1, 100),
      }),
  },
  {
    name: "ingestion_patch_item",
    description: "Edit an ingestion item's metadata or status. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "The item ID" },
        title: { type: "string" },
        handler: { type: "string" },
        domain: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        priority: { type: "integer" },
        status: { type: "string", description: "Admin-driven status transition" },
        config: { type: "object" },
      },
      required: ["item_id"],
    },
    invoke: async (ctx, args) => {
      const itemId = asInt(args.item_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (itemId <= 0) throw new Error("item_id required");
      const patch = { ...args };
      delete patch.item_id;
      return apiRequest(ctx, "PATCH", `/api/v1/ingestion/items/${itemId}`, undefined, patch);
    },
  },
  {
    name: "ingestion_discover_url",
    description: "Run discovery on a URL to get a suggested ingestion config. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to analyse" },
        hints: { type: "string", description: "Optional free-text hints" },
        use_llm: { type: "boolean", default: false, description: "Use LLM for enrichment" },
      },
      required: ["url"],
    },
    invoke: async (ctx, args) => {
      const url = asString(args.url).trim();
      if (!url) throw new Error("url required");
      return apiRequest(ctx, "POST", "/api/v1/ingestion/discover", undefined, {
        url,
        hints: asString(args.hints),
        use_llm: asBool(args.use_llm, false),
      });
    },
  },
  {
    name: "ingestion_retry_item",
    description: "Retry a failed or dead_letter ingestion item. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "The item ID" },
        reset_retries: { type: "boolean", default: false, description: "Reset retry counter" },
      },
      required: ["item_id"],
    },
    invoke: async (ctx, args) => {
      const itemId = asInt(args.item_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (itemId <= 0) throw new Error("item_id required");
      return apiRequest(
        ctx,
        "POST",
        `/api/v1/ingestion/items/${itemId}/retry`,
        { reset_retries: asBool(args.reset_retries, false) },
      );
    },
  },
  {
    name: "ingestion_requeue_item",
    description: "Re-queue any ingestion item back to pending. Platform admin only.",
    min_role: "platform_admin",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "The item ID" },
        reset_retries: { type: "boolean", default: false },
      },
      required: ["item_id"],
    },
    invoke: async (ctx, args) => {
      const itemId = asInt(args.item_id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (itemId <= 0) throw new Error("item_id required");
      return apiRequest(
        ctx,
        "POST",
        `/api/v1/ingestion/items/${itemId}/requeue`,
        { reset_retries: asBool(args.reset_retries, false) },
      );
    },
  },
];

export function roleRank(role: string | undefined): number {
  if (!role) return 0;
  const key = (role in ROLE_RANK ? role : role.toLowerCase()) as AdminRole;
  return ROLE_RANK[key] ?? 0;
}

export function isOrgAdminOrHigher(role: string | undefined): boolean {
  return roleRank(role) >= ROLE_RANK.org_admin;
}

export function visibleToolDescriptorsForRole(role: string | undefined): AdminToolDescriptor[] {
  const rank = roleRank(role);
  return TOOL_DEFINITIONS.filter((tool) => rank >= roleRank(tool.min_role));
}

export function openAIFunctionToolsForRole(
  role: string | undefined,
  allowedToolNames?: Set<string>,
): Array<Record<string, unknown>> {
  const visible = visibleToolDescriptorsForRole(role);
  return visible
    .filter((tool) => (allowedToolNames ? allowedToolNames.has(tool.name) : true))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

export async function invokeTool(
  ctx: ToolContext,
  role: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (roleRank(role) < roleRank(tool.min_role)) {
    throw new Error(`Tool '${name}' requires ${tool.min_role} role`);
  }
  return tool.invoke(ctx, args);
}
