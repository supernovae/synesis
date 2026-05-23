import { Redis } from "ioredis";
import type { AppConfig } from "../config.js";

export interface SessionLedgerEvent {
  type: string;
  at?: number;
  requestId?: string;
  source?: string;
  payload?: Record<string, unknown>;
}

export interface SessionEventStoreOptions {
  maxEvents?: number;
  ttlMs?: number;
  redis?: Pick<Redis, "lpush" | "ltrim" | "expire" | "lrange" | "del" | "quit" | "multi">;
}

type RedisLike = NonNullable<SessionEventStoreOptions["redis"]>;

export class SessionEventStore {
  private readonly redis: RedisLike;
  private readonly ownsRedis: boolean;
  private readonly maxEvents: number;
  private readonly ttlSeconds: number;

  constructor(config: AppConfig, options: SessionEventStoreOptions = {}) {
    this.redis = options.redis ?? new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
      maxRetriesPerRequest: 2,
    });
    this.ownsRedis = !options.redis;
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 200));
    const ttlMs = options.ttlMs ?? config.SYNESIS_YARN_SESSION_TTL_MS;
    this.ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  }

  async append(sessionKey: string, event: SessionLedgerEvent): Promise<void> {
    const key = this.redisKey(sessionKey);
    const payload = JSON.stringify({
      at: Date.now(),
      ...event,
      type: String(event.type || "event").slice(0, 128),
    });
    const trimEnd = this.maxEvents - 1;
    if (typeof this.redis.multi === "function") {
      const multi = this.redis.multi();
      multi.lpush(key, payload);
      multi.ltrim(key, 0, trimEnd);
      multi.expire(key, this.ttlSeconds);
      await multi.exec();
      return;
    }
    await this.redis.lpush(key, payload);
    await this.redis.ltrim(key, 0, trimEnd);
    await this.redis.expire(key, this.ttlSeconds);
  }

  async readRecent(sessionKey: string, limit = this.maxEvents): Promise<SessionLedgerEvent[]> {
    const capped = Math.max(1, Math.min(this.maxEvents, Math.floor(limit)));
    const rows = await this.redis.lrange(this.redisKey(sessionKey), 0, capped - 1);
    const events: SessionLedgerEvent[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row) as SessionLedgerEvent;
        if (parsed && typeof parsed.type === "string") events.push(parsed);
      } catch {
        // Ignore malformed ledger rows; the ledger is diagnostic only.
      }
    }
    return events;
  }

  async clear(sessionKey: string): Promise<void> {
    await this.redis.del(this.redisKey(sessionKey));
  }

  async close(): Promise<void> {
    if (this.ownsRedis) await this.redis.quit();
  }

  private redisKey(sessionKey: string): string {
    const safe = sessionKey.trim() || "unknown";
    return `yarn-ts:session-events:${safe}`;
  }
}
