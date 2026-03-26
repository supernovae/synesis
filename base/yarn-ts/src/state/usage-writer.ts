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
  latencyMs: number;
  costUsd: number;
  escalated: boolean;
  toolCallsCount: number;
  finishReason: string;
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
  private readonly queue: Array<{ type: "session"; session: SessionRecord } | { type: "usage"; event: UsageEvent }> = [];
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

  private enqueue(item: { type: "session"; session: SessionRecord } | { type: "usage"; event: UsageEvent }): void {
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
        provider, model, total_tokens_in, total_tokens_out, total_tokens_cached,
        total_cost_usd, request_count, escalation_count, created_at, last_active_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, to_timestamp($15), to_timestamp($16)
      )
      ON CONFLICT (session_key) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        org_id = EXCLUDED.org_id,
        conversation_id = EXCLUDED.conversation_id,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        total_tokens_in = EXCLUDED.total_tokens_in,
        total_tokens_out = EXCLUDED.total_tokens_out,
        total_tokens_cached = EXCLUDED.total_tokens_cached,
        total_cost_usd = EXCLUDED.total_cost_usd,
        request_count = EXCLUDED.request_count,
        escalation_count = EXCLUDED.escalation_count,
        last_active_at = EXCLUDED.last_active_at
      `,
      [
        session.sessionKey,
        session.userId,
        session.orgId,
        "",
        "user",
        session.conversationId,
        "synesis",
        "synesis",
        session.totalTokensIn,
        session.totalTokensOut,
        session.totalTokensCached,
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
        tokens_in, tokens_out, tokens_cached, latency_ms, cost_usd,
        escalated, tool_calls_count, finish_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14
      )
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
        event.latencyMs,
        event.costUsd,
        event.escalated,
        event.toolCallsCount,
        event.finishReason.slice(0, 32)
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
          } else {
            await this.insertUsage(item.event);
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
