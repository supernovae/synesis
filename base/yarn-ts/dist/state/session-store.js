import { Redis } from "ioredis";
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
    redis;
    ttlSeconds;
    constructor(config, ttlMs) {
        this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
            maxRetriesPerRequest: 2
        });
        const effectiveTtlMs = ttlMs ?? config.SYNESIS_YARN_SESSION_TTL_MS;
        this.ttlSeconds = Math.ceil(effectiveTtlMs / 1000);
    }
    async load(sessionKey) {
        const raw = await this.redis.get(this.redisKey(sessionKey));
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw);
            return { version: 0, ...parsed };
        }
        catch {
            return null;
        }
    }
    /**
     * Atomically save a session record only if the stored version matches.
     * On success, the record's version is incremented in-place.
     * Returns true on success, false on version conflict.
     */
    async save(record) {
        const expectedVersion = record.version;
        const newVersion = expectedVersion + 1;
        const toWrite = { ...record, version: newVersion };
        const result = await this.redis.eval(CAS_SCRIPT, 1, this.redisKey(record.sessionKey), String(expectedVersion), JSON.stringify(toWrite), String(this.ttlSeconds));
        if (Number(result) === 1) {
            record.version = newVersion;
            return true;
        }
        return false;
    }
    async saveContinuity(userId, continuity) {
        const key = `yarn-ts:continuity:${userId}`;
        await this.redis.set(key, JSON.stringify(continuity), "EX", this.ttlSeconds);
    }
    async loadContinuity(userId) {
        const key = `yarn-ts:continuity:${userId}`;
        const raw = await this.redis.get(key);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async close() {
        await this.redis.quit();
    }
    redisKey(sessionKey) {
        return `yarn-ts:session:${sessionKey}`;
    }
}
