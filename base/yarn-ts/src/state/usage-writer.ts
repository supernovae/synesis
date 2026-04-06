import { Pool } from "pg";
import type { AppConfig } from "../config.js";
import type { SessionRecord, SessionContinuity } from "./session-store.js";

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
  estimatedCostUsd: number;
  actualCostUsd: number;
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

export interface ContinuityUpsert {
  userId: string;
  orgId: string;
  sessionKey: string;
  continuity: SessionContinuity;
}

export interface ConversationMemoryStats {
  continuityUpserts: number;
  recallLoads: number;
  recallHits: number;
  recallMisses: number;
}

export interface WriterStats {
  queueDepth: number;
  totalEnqueued: number;
  totalFlushed: number;
  totalDropped: number;
  totalFlushErrors: number;
  lastFlushMs: number;
}

type QueueItem =
  | { type: "session"; session: SessionRecord }
  | { type: "usage"; event: UsageEvent }
  | { type: "safety"; event: SafetyEventInsert }
  | { type: "session_event"; event: SessionEventInsert }
  | { type: "continuity"; data: ContinuityUpsert };

export class UsageWriter {
  private readonly pool: Pool | null;
  private readonly queue: QueueItem[] = [];
  private readonly queueMax: number;
  private readonly flushIntervalMs: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private _totalEnqueued = 0;
  private _totalFlushed = 0;
  private _totalDropped = 0;
  private _totalFlushErrors = 0;
  private _lastFlushMs = 0;
  private _memoryStats: ConversationMemoryStats = {
    continuityUpserts: 0, recallLoads: 0, recallHits: 0, recallMisses: 0,
  };
  private _tablesEnsured = false;

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

  enqueueContinuityUpsert(userId: string, orgId: string, sessionKey: string, continuity: SessionContinuity): void {
    this.enqueue({ type: "continuity", data: { userId, orgId, sessionKey, continuity } });
  }

  async ensureContinuityTable(): Promise<void> {
    if (!this.pool || this._tablesEnsured) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS yarn_session_continuity (
          user_id       TEXT NOT NULL,
          org_id        TEXT NOT NULL DEFAULT '',
          session_key   TEXT NOT NULL,
          current_task  TEXT NOT NULL DEFAULT '',
          key_findings  JSONB NOT NULL DEFAULT '[]',
          decisions     JSONB NOT NULL DEFAULT '[]',
          recent_files  JSONB NOT NULL DEFAULT '[]',
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, session_key)
        )
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_continuity_user_updated
          ON yarn_session_continuity (user_id, updated_at DESC)
      `);
      this._tablesEnsured = true;
    } catch {
      // table may already exist or permission issue — non-fatal
    }
  }

  async loadLatestContinuity(userId: string, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<SessionContinuity | null> {
    if (!this.pool) return null;
    this._memoryStats.recallLoads++;
    try {
      const cutoff = new Date(Date.now() - maxAgeMs);
      const result = await this.pool.query(
        `SELECT current_task, key_findings, decisions, recent_files, updated_at
         FROM yarn_session_continuity
         WHERE user_id = $1 AND updated_at >= $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [userId, cutoff.toISOString()]
      );
      if (result.rows.length === 0) {
        this._memoryStats.recallMisses++;
        return null;
      }
      const row = result.rows[0];
      this._memoryStats.recallHits++;
      return {
        currentTask: String(row.current_task ?? ""),
        keyFindings: Array.isArray(row.key_findings) ? row.key_findings : [],
        decisions: Array.isArray(row.decisions) ? row.decisions : [],
        recentFiles: Array.isArray(row.recent_files) ? row.recent_files : [],
        updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
      };
    } catch {
      this._memoryStats.recallMisses++;
      return null;
    }
  }

  getConversationMemoryStats(): ConversationMemoryStats {
    return { ...this._memoryStats };
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

  getPoolStats(): { totalCount: number; idleCount: number; waitingCount: number } {
    if (!this.pool) return { totalCount: 0, idleCount: 0, waitingCount: 0 };
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  private enqueue(item: QueueItem): void {
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
        total_tokens_saved, total_estimated_cost_usd, total_actual_cost_usd,
        request_count, escalation_count, created_at, last_active_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17, to_timestamp($18), to_timestamp($19)
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
        total_estimated_cost_usd = EXCLUDED.total_estimated_cost_usd,
        total_actual_cost_usd = EXCLUDED.total_actual_cost_usd,
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
        Number(session.metadata.total_estimated_cost_usd ?? 0),
        Number(session.metadata.total_actual_cost_usd ?? 0),
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
        latency_ms, estimated_cost_usd, actual_cost_usd, pricing_source,
        escalated, tool_calls_count, finish_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17
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
        event.estimatedCostUsd,
        event.actualCostUsd,
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

  private async upsertContinuity(data: ContinuityUpsert): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO yarn_session_continuity (
         user_id, org_id, session_key, current_task,
         key_findings, decisions, recent_files, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, session_key) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         current_task = EXCLUDED.current_task,
         key_findings = EXCLUDED.key_findings,
         decisions = EXCLUDED.decisions,
         recent_files = EXCLUDED.recent_files,
         updated_at = EXCLUDED.updated_at`,
      [
        data.userId,
        data.orgId,
        data.sessionKey,
        data.continuity.currentTask.slice(0, 2000),
        JSON.stringify(data.continuity.keyFindings),
        JSON.stringify(data.continuity.decisions),
        JSON.stringify(data.continuity.recentFiles),
      ]
    );
    this._memoryStats.continuityUpserts++;
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
          } else if (item.type === "continuity") {
            await this.upsertContinuity(item.data);
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
