import { Redis } from "ioredis";
import type { AppConfig } from "../config.js";

export interface SessionRecord {
  sessionKey: string;
  userId: string;
  orgId: string;
  conversationId: string;
  createdAt: number;
  lastActiveAt: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokensCached: number;
  requestCount: number;
  escalationCount: number;
  metadata: Record<string, unknown>;
  version: number;
}

/**
 * Lua script for compare-and-set session writes.
 * KEYS[1] = session redis key
 * ARGV[1] = expected version (0 means unconditional create)
 * ARGV[2] = serialized new record (with incremented version)
 * ARGV[3] = TTL seconds
 *
 * Returns 1 on success, 0 on version conflict.
 */
const CAS_SCRIPT = `
local key = KEYS[1]
local expectedVersion = tonumber(ARGV[1])
local newData = ARGV[2]
local ttl = tonumber(ARGV[3])
if expectedVersion == 0 then
  redis.call("SET", key, newData, "EX", ttl)
  return 1
end
local current = redis.call("GET", key)
if current == false then
  redis.call("SET", key, newData, "EX", ttl)
  return 1
end
local decoded = cjson.decode(current)
local currentVersion = tonumber(decoded.version) or 0
if currentVersion ~= expectedVersion then
  return 0
end
redis.call("SET", key, newData, "EX", ttl)
return 1
`;

export class SessionStore {
  private readonly redis: Redis;
  private readonly ttlSeconds = 60 * 60 * 4;

  constructor(config: AppConfig) {
    this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
      maxRetriesPerRequest: 2
    });
  }

  async load(sessionKey: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.redisKey(sessionKey));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SessionRecord>;
    return { version: 0, ...parsed } as SessionRecord;
  }

  /**
   * Atomically save a session record only if the stored version matches.
   * On success, the record's version is incremented in-place.
   * Returns true on success, false on version conflict.
   */
  async save(record: SessionRecord): Promise<boolean> {
    const expectedVersion = record.version;
    const newVersion = expectedVersion + 1;
    const toWrite = { ...record, version: newVersion };
    const result = await this.redis.eval(
      CAS_SCRIPT,
      1,
      this.redisKey(record.sessionKey),
      String(expectedVersion),
      JSON.stringify(toWrite),
      String(this.ttlSeconds)
    );
    if (Number(result) === 1) {
      record.version = newVersion;
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private redisKey(sessionKey: string): string {
    return `yarn-ts:session:${sessionKey}`;
  }
}
