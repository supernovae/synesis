/**
 * Per-user sliding-window request rate limiter.
 *
 * Two backends:
 * - **In-memory** (default): ring of timestamps per userId in a Map.
 * - **Redis** (when `redis` option supplied): sorted-set per user key with
 *   score = timestamp. Shared across pods for multi-replica deployments.
 *
 * Bounded: evicts users with no activity older than the window on a periodic
 * sweep so the Map / sorted set does not grow unbounded.
 */

import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  currentCount: number;
  limit: number;
}

export interface RateLimiterStats {
  trackedUsers: number;
  totalRejections: number;
  sweepEvictions: number;
  backend: "memory" | "redis";
}

const RATE_LIMIT_KEY_PREFIX = "yarn-ts:rl:";

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local ttlSeconds = tonumber(ARGV[4])
local cutoff = now - windowMs
redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
local count = redis.call("ZCARD", key)
if count >= maxRequests then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryMs = 0
  if oldest and #oldest >= 2 then
    retryMs = tonumber(oldest[2]) + windowMs - now
  end
  return {0, count, retryMs}
end
redis.call("ZADD", key, now, now .. ":" .. math.random(100000))
redis.call("EXPIRE", key, ttlSeconds)
return {1, count + 1, 0}
`;

export class UserRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly redis: Redis | null;
  private totalRejections = 0;
  private sweepEvictions = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { windowMs?: number; maxRequests?: number; redis?: Redis | null }) {
    this.windowMs = opts?.windowMs ?? 60_000;
    this.maxRequests = opts?.maxRequests ?? 30;
    this.redis = opts?.redis ?? null;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
  }

  async check(userId: string): Promise<RateLimitResult> {
    if (this.redis) {
      return this.checkRedis(userId);
    }
    return this.checkMemory(userId);
  }

  private checkMemory(userId: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(userId, timestamps);
    }

    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      this.totalRejections += 1;
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.ceil((oldest + this.windowMs - now) / 1000);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
        currentCount: timestamps.length,
        limit: this.maxRequests,
      };
    }

    timestamps.push(now);
    return {
      allowed: true,
      currentCount: timestamps.length,
      limit: this.maxRequests,
    };
  }

  private async checkRedis(userId: string): Promise<RateLimitResult> {
    const key = `${RATE_LIMIT_KEY_PREFIX}${userId}`;
    const now = Date.now();
    const ttlSeconds = Math.ceil(this.windowMs / 1000) + 10;
    try {
      const result = await this.redis!.eval(
        RATE_LIMIT_SCRIPT,
        1,
        key,
        String(now),
        String(this.windowMs),
        String(this.maxRequests),
        String(ttlSeconds),
      ) as [number, number, number];
      const [allowed, count, retryMs] = result;
      if (!allowed) {
        this.totalRejections += 1;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
          currentCount: count,
          limit: this.maxRequests,
        };
      }
      return { allowed: true, currentCount: count, limit: this.maxRequests };
    } catch {
      return this.checkMemory(userId);
    }
  }

  getStats(): RateLimiterStats {
    return {
      trackedUsers: this.windows.size,
      totalRejections: this.totalRejections,
      sweepEvictions: this.sweepEvictions,
      backend: this.redis ? "redis" : "memory",
    };
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [userId, timestamps] of this.windows) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
        this.windows.delete(userId);
        this.sweepEvictions += 1;
      }
    }
  }
}
