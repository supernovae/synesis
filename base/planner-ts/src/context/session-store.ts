import { Redis } from "ioredis";

type Role = "system" | "user" | "assistant" | "tool";
export type ChatMessage = { role: Role; content: string };

export interface SessionData {
  key: string;
  lastSeenAt: number;
  history: ChatMessage[];
  checkpointBlock?: string;
  pendingClarification?: {
    question: string;
    options: string[];
    assumptions: string[];
  };
}

export interface SessionStore {
  readonly backend: "memory" | "redis";
  get(key: string): Promise<SessionData | undefined>;
  set(key: string, data: SessionData, ttlMs: number): Promise<void>;
  mutate(
    key: string,
    ttlMs: number,
    mutator: (current: SessionData | undefined) => SessionData,
  ): Promise<SessionData>;
  delete(key: string): Promise<boolean>;
  ping(): Promise<boolean>;
  keys(): Promise<string[]>;
  pruneExpired(maxAgeMs: number): Promise<number>;
}

export class MemorySessionStore implements SessionStore {
  readonly backend = "memory" as const;
  private readonly sessions = new Map<string, SessionData>();
  private readonly maxSessions: number;

  constructor(opts?: { maxSessions?: number }) {
    this.maxSessions = Math.max(1, opts?.maxSessions ?? 5000);
  }

  async get(key: string): Promise<SessionData | undefined> {
    return this.sessions.get(key);
  }

  async set(key: string, data: SessionData, _ttlMs: number): Promise<void> {
    this.evictIfNeeded(key);
    this.sessions.set(key, data);
  }

  async mutate(
    key: string,
    _ttlMs: number,
    mutator: (current: SessionData | undefined) => SessionData,
  ): Promise<SessionData> {
    const next = mutator(this.sessions.get(key));
    this.evictIfNeeded(key);
    this.sessions.set(key, next);
    return next;
  }

  async delete(key: string): Promise<boolean> {
    return this.sessions.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async keys(): Promise<string[]> {
    return [...this.sessions.keys()];
  }

  async pruneExpired(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;
    for (const [key, value] of this.sessions.entries()) {
      if (value.lastSeenAt < cutoff) {
        this.sessions.delete(key);
        count++;
      }
    }
    return count;
  }

  private evictIfNeeded(incomingKey: string): void {
    if (this.sessions.has(incomingKey)) return;
    if (this.sessions.size < this.maxSessions) return;
    let oldestKey: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.sessions.entries()) {
      if (value.lastSeenAt < oldestSeenAt) {
        oldestSeenAt = value.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }
}

export class RedisSessionStore implements SessionStore {
  readonly backend = "redis" as const;
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly casMaxRetries: number;

  constructor(opts: { url: string; keyPrefix: string; casMaxRetries?: number }) {
    this.client = new Redis(opts.url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      lazyConnect: true
    });
    this.prefix = opts.keyPrefix;
    this.casMaxRetries = Math.max(1, opts.casMaxRetries ?? 5);
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async connect(): Promise<void> {
    if (this.client.status === "ready") return;
    await this.client.connect();
  }

  async get(key: string): Promise<SessionData | undefined> {
    const raw = await this.client.get(this.fullKey(key));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return undefined;
    }
  }

  async set(key: string, data: SessionData, ttlMs: number): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.client.set(this.fullKey(key), JSON.stringify(data), "EX", ttlSec);
  }

  async mutate(
    key: string,
    ttlMs: number,
    mutator: (current: SessionData | undefined) => SessionData,
  ): Promise<SessionData> {
    await this.connect();
    const fullKey = this.fullKey(key);
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));

    for (let attempt = 0; attempt < this.casMaxRetries; attempt++) {
      await this.client.watch(fullKey);
      const raw = await this.client.get(fullKey);
      let current: SessionData | undefined;
      if (raw) {
        try {
          current = JSON.parse(raw) as SessionData;
        } catch {
          current = undefined;
        }
      }
      const next = mutator(current);
      const tx = this.client.multi();
      tx.set(fullKey, JSON.stringify(next), "EX", ttlSec);
      const result = await tx.exec();
      if (result !== null) {
        return next;
      }
    }
    throw new Error(`Redis session CAS failed for key '${key}' after ${this.casMaxRetries} retries`);
  }

  async delete(key: string): Promise<boolean> {
    const removed = await this.client.del(this.fullKey(key));
    return removed > 0;
  }

  async ping(): Promise<boolean> {
    try {
      await this.connect();
      const out = await this.client.ping();
      return out === "PONG";
    } catch {
      return false;
    }
  }

  async keys(): Promise<string[]> {
    const pattern = `${this.prefix}*`;
    const allKeys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, chunk] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = nextCursor;
      allKeys.push(...(chunk as string[]));
    } while (cursor !== "0");
    return allKeys.map((k) => k.slice(this.prefix.length));
  }

  async pruneExpired(_maxAgeMs: number): Promise<number> {
    // Redis TTL handles expiration; no manual prune needed.
    return 0;
  }

  async disconnect(): Promise<void> {
    if (this.client.status !== "close" && this.client.status !== "end") {
      this.client.disconnect();
    }
  }
}

export function createSessionStore(opts: {
  redisUrl: string;
  redisKeyPrefix: string;
  memoryMaxSessions?: number;
  redisCasMaxRetries?: number;
}): SessionStore {
  if (opts.redisUrl) {
    return new RedisSessionStore({
      url: opts.redisUrl,
      keyPrefix: opts.redisKeyPrefix,
      casMaxRetries: opts.redisCasMaxRetries,
    });
  }
  return new MemorySessionStore({ maxSessions: opts.memoryMaxSessions });
}
