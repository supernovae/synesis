/**
 * Redis-backed diagnostic persistence — survives pod restarts and enables
 * per-request diagnostic lookup via API.
 *
 * Falls back gracefully when Redis is unavailable (fire-and-forget writes).
 */
import { Redis } from "ioredis";
const KEY_PREFIX = "yarn:diag:";
const RECENT_SET = "yarn:diag:recent";
const MAX_RECENT = 200;
export class DiagnosticStore {
    redis;
    ttlSeconds;
    stats = {
        persisted: 0,
        persistErrors: 0,
        lookups: 0,
        lookupErrors: 0,
    };
    constructor(config) {
        if (config.SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED && config.SYNESIS_YARN_SESSION_REDIS_URL) {
            this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
                maxRetriesPerRequest: 1,
                connectTimeout: 2000,
                commandTimeout: 1000,
            });
        }
        else {
            this.redis = null;
        }
        this.ttlSeconds = config.SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S;
    }
    persistDiagnostic(requestId, diagnostic) {
        if (!this.redis)
            return;
        const key = `${KEY_PREFIX}${requestId}`;
        const data = JSON.stringify(diagnostic);
        const now = Date.now();
        this.redis
            .pipeline()
            .set(key, data, "EX", this.ttlSeconds)
            .zadd(RECENT_SET, String(now), requestId)
            .zremrangebyrank(RECENT_SET, 0, -(MAX_RECENT + 1))
            .exec()
            .then(() => {
            this.stats.persisted += 1;
        })
            .catch(() => {
            this.stats.persistErrors += 1;
        });
    }
    async getDiagnostic(requestId) {
        if (!this.redis)
            return null;
        this.stats.lookups += 1;
        try {
            const raw = await this.redis.get(`${KEY_PREFIX}${requestId}`);
            if (!raw)
                return null;
            return JSON.parse(raw);
        }
        catch {
            this.stats.lookupErrors += 1;
            return null;
        }
    }
    async listRecentDiagnostics(limit = 20) {
        if (!this.redis)
            return [];
        try {
            return await this.redis.zrevrange(RECENT_SET, 0, limit - 1);
        }
        catch {
            return [];
        }
    }
    getStats() {
        return { ...this.stats };
    }
    async close() {
        await this.redis?.quit();
    }
}
