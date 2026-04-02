/**
 * Redis-backed distributed counters for multi-replica safety consistency.
 *
 * Provides atomic INCR/GET/SET operations on Redis for repeat-loop detection
 * and consecutive tool-call tracking so all pods share a unified view of
 * safety state. Falls back to the caller-provided local path when Redis is
 * unavailable, emitting structured events for observability.
 *
 * Uses the same Redis connection as SessionStore (SYNESIS_YARN_SESSION_REDIS_URL).
 */
import { Redis } from "ioredis";
const INCR_WITH_TTL_LUA = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local val = redis.call("INCR", key)
if val == 1 then
  redis.call("EXPIRE", key, ttl)
end
return val
`;
const SET_WITH_TTL_LUA = `
local key = KEYS[1]
local value = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call("SET", key, value, "EX", ttl)
return value
`;
export class DistributedCounterService {
    redis;
    repeatTtlSeconds;
    consecutiveToolTtlSeconds;
    stats = { redisOps: 0, redisErrors: 0, fallbackInvocations: 0 };
    constructor(config) {
        this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
            maxRetriesPerRequest: 1,
            connectTimeout: 2000,
            commandTimeout: 1000,
        });
        this.repeatTtlSeconds = Math.ceil((config.SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS ?? 1_800_000) / 1000);
        this.consecutiveToolTtlSeconds = Math.ceil((config.SYNESIS_YARN_SESSION_TTL_MS ?? 14_400_000) / 1000);
    }
    /**
     * Atomically increment the repeat counter for a given session+attempt hash.
     * Returns the new count, or null if Redis is unavailable (caller uses local fallback).
     */
    async incrRepeatCount(sessionKey, attemptHash) {
        const key = `yarn-ts:policy:repeat:${sessionKey}:${attemptHash}`;
        try {
            this.stats.redisOps += 1;
            const val = await this.redis.eval(INCR_WITH_TTL_LUA, 1, key, String(this.repeatTtlSeconds));
            return Number(val);
        }
        catch {
            this.stats.redisErrors += 1;
            this.stats.fallbackInvocations += 1;
            return null;
        }
    }
    /**
     * Read the current consecutive tool-call count for a session.
     * Returns null if Redis is unavailable.
     */
    async getConsecutiveToolCalls(sessionKey) {
        const key = `yarn-ts:qos:consecutive_tools:${sessionKey}`;
        try {
            this.stats.redisOps += 1;
            const raw = await this.redis.get(key);
            return raw !== null ? Number(raw) : 0;
        }
        catch {
            this.stats.redisErrors += 1;
            this.stats.fallbackInvocations += 1;
            return null;
        }
    }
    /**
     * Set the consecutive tool-call counter after a request completes.
     * Called from persistSessionAndUsage — increment on tool_calls finish,
     * reset to 0 on any other finish reason.
     */
    async setConsecutiveToolCalls(sessionKey, value) {
        const key = `yarn-ts:qos:consecutive_tools:${sessionKey}`;
        try {
            this.stats.redisOps += 1;
            await this.redis.eval(SET_WITH_TTL_LUA, 1, key, String(value), String(this.consecutiveToolTtlSeconds));
            return true;
        }
        catch {
            this.stats.redisErrors += 1;
            this.stats.fallbackInvocations += 1;
            return false;
        }
    }
    getStats() {
        return { ...this.stats };
    }
    async close() {
        await this.redis.quit();
    }
}
