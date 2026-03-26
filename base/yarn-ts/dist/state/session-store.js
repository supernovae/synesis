import { Redis } from "ioredis";
export class SessionStore {
    redis;
    ttlSeconds = 60 * 60 * 4;
    constructor(config) {
        this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
            maxRetriesPerRequest: 2
        });
    }
    async load(sessionKey) {
        const raw = await this.redis.get(this.redisKey(sessionKey));
        if (!raw) {
            return null;
        }
        return JSON.parse(raw);
    }
    async save(record) {
        await this.redis.set(this.redisKey(record.sessionKey), JSON.stringify(record), "EX", this.ttlSeconds);
    }
    async close() {
        await this.redis.quit();
    }
    redisKey(sessionKey) {
        return `yarn-ts:session:${sessionKey}`;
    }
}
