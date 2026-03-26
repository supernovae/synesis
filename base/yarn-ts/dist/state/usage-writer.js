import { Pool } from "pg";
export class UsageWriter {
    pool;
    enabled;
    constructor(config) {
        this.enabled = config.SYNESIS_YARN_PERSIST_USAGE_TO_DB && Boolean(config.SYNESIS_YARN_ADMIN_DB_URL);
        this.pool = this.enabled ? new Pool({ connectionString: config.SYNESIS_YARN_ADMIN_DB_URL }) : null;
    }
    async upsertSession(session) {
        if (!this.pool)
            return;
        await this.pool.query(`
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
      `, [
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
        ]);
    }
    async insertUsage(event) {
        if (!this.pool)
            return;
        await this.pool.query(`
      INSERT INTO yarn_usage_log (
        session_key, request_id, user_id, org_id, provider, model,
        tokens_in, tokens_out, tokens_cached, latency_ms, cost_usd,
        escalated, tool_calls_count, finish_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14
      )
      `, [
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
        ]);
    }
    async close() {
        await this.pool?.end();
    }
}
