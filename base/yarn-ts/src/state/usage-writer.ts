import { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type { SessionRecord } from "./session-store.js";

export interface UsageEvent {
  sessionKey: string;
  requestId: string;
  userId: string;
  orgId: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensSavedByReduction: number;
  latencyMs: number;
  costUsd: number;
  pricingSource: string;
  escalated: boolean;
  toolCallsCount: number;
  finishReason: string;
}

export interface SafetyEventInsert {
  sessionKey: string;
  userId: string;
  orgId: string;
  eventKind: string;
  detail: string;
  repeatCount?: number;
  tokensBurned?: number;
  consecutiveToolCalls?: number;
}

export interface SessionEventInsert {
  sessionKey: string;
  requestId?: string;
  userId: string;
  orgId: string;
  eventKind: string;
  component: string;
  detail: string;
  metadataJson?: Record<string, unknown>;
}

export interface WriterStats {
  queueDepth: number;
  totalEnqueued: number;
  totalFlushed: number;
  totalDropped: number;
  totalFlushErrors: number;
  lastFlushMs: number;
}

export class UsageWriter {
  private readonly pool: Pool | null;
  private readonly queue: Array<
    | { type: "session"; session: SessionRecord }
    | { type: "usage"; event: UsageEvent }
    | { type: "safety"; event: SafetyEventInsert }
    | { type: "session_event"; event: SessionEventInsert }
  > = [];
  private readonly queueMax: number;
  private readonly flushIntervalMs: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private _totalEnqueued = 0;
  private _totalFlushed = 0;
  private _totalDropped = 0;
  private _totalFlushErrors = 0;
  private _lastFlushMs = 0;

  constructor(config: AppConfig) {
    const enabled = config.SYNESIS_YARN_PERSIST_USAGE_TO_DB && Boolean(config.SYNESIS_YARN_ADMIN_DB_URL);
    this.pool = enabled
      ? new Pool({
          connectionString: config.SYNESIS_YARN_ADMIN_DB_URL,
          max: config.SYNESIS_YARN_DB_POOL_MAX,
          idleTimeoutMillis: config.SYNESIS_YARN_DB_POOL_IDLE_MS,
          connectionTimeoutMillis: config.SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS
        })
      : null;
    this.queueMax = config.SYNESIS_YARN_WRITE_QUEUE_MAX;
    this.flushIntervalMs = config.SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS;
    if (this.pool) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  enqueueSessionUpsert(session: SessionRecord): void {
    this.enqueue({ type: "session", session });
  }

  enqueueUsageInsert(event: UsageEvent): void {
    this.enqueue({ type: "usage", event });
  }

  enqueueSafetyEventInsert(event: SafetyEventInsert): void {
    this.enqueue({ type: "safety", event });
  }

  enqueueSessionEvent(event: SessionEventInsert): void {
    this.enqueue({ type: "session_event", event });
  }

  getStats(): WriterStats {
    return {
      queueDepth: this.queue.length,
      totalEnqueued: this._totalEnqueued,
      totalFlushed: this._totalFlushed,
      totalDropped: this._totalDropped,
      totalFlushErrors: this._totalFlushErrors,
      lastFlushMs: this._lastFlushMs
    };
  }

  private enqueue(item: { type: "session"; session: SessionRecord } | { type: "usage"; event: UsageEvent } | { type: "safety"; event: SafetyEventInsert } | { type: "session_event"; event: SessionEventInsert }): void {
    if (!this.pool) return;
    if (this.queue.length >= this.queueMax) {
      this.queue.shift();
      this._totalDropped++;
    }
    this.queue.push(item);
    this._totalEnqueued++;
  }

  private async upsertSession(session: SessionRecord): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO yarn_sessions (
        session_key, user_id, org_id, username, role, conversation_id,
        client_kind, provider, model,
        total_tokens_in, total_tokens_out, total_tokens_cached,
        total_tokens_saved, total_cost_usd,
        request_count, escalation_count, created_at, last_active_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14,
        $15, $16, to_timestamp($17), to_timestamp($18)
      )
      ON CONFLICT (session_key) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        org_id = EXCLUDED.org_id,
        username = CASE WHEN EXCLUDED.username != '' THEN EXCLUDED.username ELSE yarn_sessions.username END,
        conversation_id = EXCLUDED.conversation_id,
        client_kind = EXCLUDED.client_kind,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        total_tokens_in = EXCLUDED.total_tokens_in,
        total_tokens_out = EXCLUDED.total_tokens_out,
        total_tokens_cached = EXCLUDED.total_tokens_cached,
        total_tokens_saved = EXCLUDED.total_tokens_saved,
        total_cost_usd = EXCLUDED.total_cost_usd,
        request_count = EXCLUDED.request_count,
        escalation_count = EXCLUDED.escalation_count,
        last_active_at = EXCLUDED.last_active_at
      `,
      [
        session.sessionKey,
        session.userId,
        session.orgId,
        session.displayName || "",
        "user",
        session.conversationId,
        session.clientKind || "unknown",
        "synesis",
        "synesis",
        session.totalTokensIn,
        session.totalTokensOut,
        session.totalTokensCached,
        session.totalTokensSaved ?? 0,
        Number(session.metadata.total_cost_usd ?? 0),
        session.requestCount,
        session.escalationCount,
        session.createdAt / 1000,
        session.lastActiveAt / 1000
      ]
    );
  }

  private async insertUsage(event: UsageEvent): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO yarn_usage_log (
        session_key, request_id, user_id, org_id, provider, model,
        tokens_in, tokens_out, tokens_cached, tokens_saved_by_reduction,
        latency_ms, cost_usd, pricing_source,
        escalated, tool_calls_count, finish_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16
      )
      ON CONFLICT (request_id) DO NOTHING
      `,
      [
        event.sessionKey,
        event.requestId,
        event.userId,
        event.orgId,
        event.provider,
        event.model,
        event.tokensIn,
        event.tokensOut,
        event.tokensCached,
        event.tokensSavedByReduction,
        event.latencyMs,
        event.costUsd,
        event.pricingSource,
        event.escalated,
        event.toolCallsCount,
        event.finishReason.slice(0, 32)
      ]
    );
  }

  private async insertSessionEvent(event: SessionEventInsert): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO yarn_session_events (
        session_key, request_id, user_id, org_id,
        event_kind, component, detail, metadata_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        event.sessionKey,
        event.requestId ?? null,
        event.userId,
        event.orgId,
        event.eventKind,
        event.component.slice(0, 64),
        event.detail.slice(0, 2048),
        event.metadataJson ? JSON.stringify(event.metadataJson) : null,
      ]
    );
  }

  private async insertSafetyEvent(event: SafetyEventInsert): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `
      INSERT INTO yarn_safety_events (
        session_key, user_id, org_id, event_kind, detail,
        repeat_count, tokens_burned, consecutive_tool_calls
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        event.sessionKey,
        event.userId,
        event.orgId,
        event.eventKind,
        event.detail.slice(0, 1000),
        event.repeatCount ?? null,
        event.tokensBurned ?? null,
        event.consecutiveToolCalls ?? null
      ]
    );
  }

  async flush(): Promise<void> {
    if (!this.pool || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;
        try {
          if (item.type === "session") {
            await this.upsertSession(item.session);
          } else if (item.type === "usage") {
            await this.insertUsage(item.event);
          } else if (item.type === "safety") {
            await this.insertSafetyEvent(item.event);
          } else if (item.type === "session_event") {
            await this.insertSessionEvent(item.event);
          }
          this._totalFlushed++;
        } catch {
          this._totalFlushErrors++;
        }
      }
      this._lastFlushMs = Date.now();
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.pool?.end();
  }
}
