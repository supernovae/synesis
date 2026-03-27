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
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  pruneExpired(maxAgeMs: number): Promise<number>;
}

export class MemorySessionStore implements SessionStore {
  readonly backend = "memory" as const;
  private readonly sessions = new Map<string, SessionData>();

  async get(key: string): Promise<SessionData | undefined> {
    return this.sessions.get(key);
  }

  async set(key: string, data: SessionData, _ttlMs: number): Promise<void> {
    this.sessions.set(key, data);
  }

  async delete(key: string): Promise<boolean> {
    return this.sessions.delete(key);
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
}

export class RedisSessionStore implements SessionStore {
  readonly backend = "redis" as const;
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(opts: { url: string; keyPrefix: string }) {
    this.client = new Redis(opts.url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      lazyConnect: true
    });
    this.prefix = opts.keyPrefix;
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

  async delete(key: string): Promise<boolean> {
    const removed = await this.client.del(this.fullKey(key));
    return removed > 0;
  }

  async keys(): Promise<string[]> {
    const pattern = `${this.prefix}*`;
    const rawKeys = await this.client.keys(pattern);
    return rawKeys.map((k: string) => k.slice(this.prefix.length));
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
}): SessionStore {
  if (opts.redisUrl) {
    return new RedisSessionStore({
      url: opts.redisUrl,
      keyPrefix: opts.redisKeyPrefix
    });
  }
  return new MemorySessionStore();
}
