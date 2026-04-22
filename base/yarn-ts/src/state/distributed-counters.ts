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
import type { AppConfig } from "../config.js";

export interface DistributedCounterStats {
  redisOps: number;
  redisErrors: number;
  fallbackInvocations: number;
}

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

const ROLLING_MINUTE_BUCKET_SUM_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
local windowMinutes = tonumber(ARGV[2])
local addTokens = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local nowMinute = math.floor(nowMs / 60000)
local cutoff = nowMinute - windowMinutes + 1
if cutoff < 0 then cutoff = 0 end

if addTokens > 0 then
  redis.call("HINCRBY", key, tostring(nowMinute), addTokens)
end

local fields = redis.call("HKEYS", key)
for i = 1, #fields do
  local minute = tonumber(fields[i])
  if minute ~= nil and minute < cutoff then
    redis.call("HDEL", key, fields[i])
  end
end

local rows = redis.call("HGETALL", key)
local total = 0
for i = 2, #rows, 2 do
  total = total + tonumber(rows[i])
end

redis.call("EXPIRE", key, ttl)
return total
`;

export interface HourlyTokenWindowSnapshot {
  sessionTokensInWindow: number;
  userTokensInWindow: number;
}

export class DistributedCounterService {
  private readonly redis: Redis;
  private readonly repeatTtlSeconds: number;
  private readonly consecutiveToolTtlSeconds: number;
  private readonly hourlyWindowMinutes: number;
  private readonly hourlyCounterTtlSeconds: number;
  private readonly globalCalibrationTtlSeconds: number;
  private stats = { redisOps: 0, redisErrors: 0, fallbackInvocations: 0 };

  constructor(config: AppConfig) {
    this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1000,
    });
    this.repeatTtlSeconds = Math.ceil(
      (config.SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS ?? 1_800_000) / 1000
    );
    this.consecutiveToolTtlSeconds = Math.ceil(
      (config.SYNESIS_YARN_SESSION_TTL_MS ?? 14_400_000) / 1000
    );
    const hourlyWindowMs = Math.max(60_000, config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS ?? 3_600_000);
    this.hourlyWindowMinutes = Math.max(1, Math.ceil(hourlyWindowMs / 60_000));
    this.hourlyCounterTtlSeconds = Math.max(120, Math.ceil((hourlyWindowMs * 2) / 1000));
    this.globalCalibrationTtlSeconds = Math.max(
      3_600,
      Math.ceil((config.SYNESIS_YARN_SESSION_TTL_MS ?? 14_400_000) / 1000) * 2,
    );
  }

  /**
   * Atomically increment the repeat counter for a given session+attempt hash.
   * Returns the new count, or null if Redis is unavailable (caller uses local fallback).
   */
  async incrRepeatCount(sessionKey: string, attemptHash: string): Promise<number | null> {
    const key = `yarn-ts:policy:repeat:${sessionKey}:${attemptHash}`;
    try {
      this.stats.redisOps += 1;
      const val = await this.redis.eval(INCR_WITH_TTL_LUA, 1, key, String(this.repeatTtlSeconds));
      return Number(val);
    } catch {
      this.stats.redisErrors += 1;
      this.stats.fallbackInvocations += 1;
      return null;
    }
  }

  /**
   * Read the current consecutive tool-call count for a session.
   * Returns null if Redis is unavailable.
   */
  async getConsecutiveToolCalls(sessionKey: string): Promise<number | null> {
    const key = `yarn-ts:qos:consecutive_tools:${sessionKey}`;
    try {
      this.stats.redisOps += 1;
      const raw = await this.redis.get(key);
      return raw !== null ? Number(raw) : 0;
    } catch {
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
  async setConsecutiveToolCalls(sessionKey: string, value: number): Promise<boolean> {
    const key = `yarn-ts:qos:consecutive_tools:${sessionKey}`;
    try {
      this.stats.redisOps += 1;
      await this.redis.eval(SET_WITH_TTL_LUA, 1, key, String(value), String(this.consecutiveToolTtlSeconds));
      return true;
    } catch {
      this.stats.redisErrors += 1;
      this.stats.fallbackInvocations += 1;
      return false;
    }
  }

  /**
   * Record input tokens into rolling hourly minute buckets and return current
   * window totals for both session and user scopes.
   */
  async addInputTokensAndReadHourlyWindow(
    sessionKey: string,
    userId: string,
    inputTokens: number,
    nowMs = Date.now(),
  ): Promise<HourlyTokenWindowSnapshot | null> {
    const safeTokens = Number.isFinite(inputTokens) ? Math.max(0, Math.floor(inputTokens)) : 0;
    const sessionCounterKey = `yarn-ts:qos:hourly_tokens:session:${sessionKey}`;
    const userCounterKey = `yarn-ts:qos:hourly_tokens:user:${userId}`;
    try {
      this.stats.redisOps += 2;
      const [sessionTokens, userTokens] = await Promise.all([
        this.redis.eval(
          ROLLING_MINUTE_BUCKET_SUM_LUA,
          1,
          sessionCounterKey,
          String(nowMs),
          String(this.hourlyWindowMinutes),
          String(safeTokens),
          String(this.hourlyCounterTtlSeconds),
        ),
        this.redis.eval(
          ROLLING_MINUTE_BUCKET_SUM_LUA,
          1,
          userCounterKey,
          String(nowMs),
          String(this.hourlyWindowMinutes),
          String(safeTokens),
          String(this.hourlyCounterTtlSeconds),
        ),
      ]);
      return {
        sessionTokensInWindow: Number(sessionTokens),
        userTokensInWindow: Number(userTokens),
      };
    } catch {
      this.stats.redisErrors += 1;
      this.stats.fallbackInvocations += 1;
      return null;
    }
  }

  async getStateTransitionGlobalCalibrationScope(
    scopeKey: string,
  ): Promise<Record<string, unknown> | null> {
    const key = `yarn-ts:state-transition:global:${scopeKey}`;
    try {
      this.stats.redisOps += 1;
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      this.stats.redisErrors += 1;
      this.stats.fallbackInvocations += 1;
      return null;
    }
  }

  async setStateTransitionGlobalCalibrationScope(
    scopeKey: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const key = `yarn-ts:state-transition:global:${scopeKey}`;
    try {
      this.stats.redisOps += 1;
      await this.redis.set(key, JSON.stringify(payload), "EX", this.globalCalibrationTtlSeconds);
      return true;
    } catch {
      this.stats.redisErrors += 1;
      this.stats.fallbackInvocations += 1;
      return false;
    }
  }

  getStats(): DistributedCounterStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
