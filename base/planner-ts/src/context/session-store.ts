import { Redis } from "ioredis";
import { createHash } from "node:crypto";

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
    originalTaskDescription?: string;
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
  disconnect(): Promise<void>;
}

const SESSION_STORE_KEY_PART_LIMIT = 320;
const VALID_MESSAGE_ROLES = new Set<Role>(["system", "user", "assistant", "tool"]);

function safeSessionStoreKeyPart(value: string): string {
  const raw = replaceControlCharsWithSpace(value).trim();
  if (!raw) return "unknown";
  const safe = raw.replace(/[^A-Za-z0-9_.@:-]+/g, "_").replace(/_+/g, "_");
  if (!safe) return "unknown";
  if (safe.length <= SESSION_STORE_KEY_PART_LIMIT) return safe;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return `${safe.slice(0, 192)}-${digest}`;
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.role === "string"
    && VALID_MESSAGE_ROLES.has(row.role as Role)
    && typeof row.content === "string";
}

function isPendingClarification(value: unknown): value is NonNullable<SessionData["pendingClarification"]> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.question === "string"
    && Array.isArray(row.options)
    && row.options.every((item) => typeof item === "string")
    && Array.isArray(row.assumptions)
    && row.assumptions.every((item) => typeof item === "string")
    && (row.originalTaskDescription === undefined || typeof row.originalTaskDescription === "string");
}

function normalizeSessionData(key: string, raw: unknown): SessionData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  if (row.key !== key) return undefined;
  if (!Number.isFinite(Number(row.lastSeenAt))) return undefined;
  if (!Array.isArray(row.history) || !row.history.every(isChatMessage)) return undefined;
  if (row.checkpointBlock !== undefined && typeof row.checkpointBlock !== "string") return undefined;
  if (row.pendingClarification !== undefined && !isPendingClarification(row.pendingClarification)) return undefined;
  const normalized: SessionData = {
    key,
    lastSeenAt: Number(row.lastSeenAt),
    history: row.history,
  };
  if (typeof row.checkpointBlock === "string") normalized.checkpointBlock = row.checkpointBlock;
  if (isPendingClarification(row.pendingClarification)) {
    normalized.pendingClarification = row.pendingClarification;
  }
  return normalized;
}

function canonicalSessionData(key: string, data: SessionData): SessionData {
  return {
    ...data,
    key,
    history: data.history.filter(isChatMessage),
  };
}

export class MemorySessionStore implements SessionStore {
  readonly backend = "memory" as const;
  private readonly sessions = new Map<string, SessionData>();
  private readonly maxSessions: number;

  constructor(opts?: { maxSessions?: number }) {
    this.maxSessions = Math.max(1, opts?.maxSessions ?? 5000);
  }

  async get(key: string): Promise<SessionData | undefined> {
    const existing = this.sessions.get(key);
    const normalized = normalizeSessionData(key, existing);
    if (!normalized && existing) this.sessions.delete(key);
    return normalized;
  }

  async set(key: string, data: SessionData, _ttlMs: number): Promise<void> {
    this.evictIfNeeded(key);
    this.sessions.set(key, canonicalSessionData(key, data));
  }

  async mutate(
    key: string,
    _ttlMs: number,
    mutator: (current: SessionData | undefined) => SessionData,
  ): Promise<SessionData> {
    const current = await this.get(key);
    const next = canonicalSessionData(key, mutator(current));
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

  async disconnect(): Promise<void> {}
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
    return `${this.prefix}${safeSessionStoreKeyPart(key)}`;
  }

  async connect(): Promise<void> {
    if (this.client.status === "ready") return;
    await this.client.connect();
  }

  async get(key: string): Promise<SessionData | undefined> {
    const raw = await this.client.get(this.fullKey(key));
    if (!raw) return undefined;
    try {
      return normalizeSessionData(key, JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async set(key: string, data: SessionData, ttlMs: number): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.client.set(this.fullKey(key), JSON.stringify(canonicalSessionData(key, data)), "EX", ttlSec);
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
          current = normalizeSessionData(key, JSON.parse(raw));
        } catch {
          current = undefined;
        }
      }
      const next = canonicalSessionData(key, mutator(current));
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
