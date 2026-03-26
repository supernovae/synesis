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
}

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
    return JSON.parse(raw) as SessionRecord;
  }

  async save(record: SessionRecord): Promise<void> {
    await this.redis.set(this.redisKey(record.sessionKey), JSON.stringify(record), "EX", this.ttlSeconds);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private redisKey(sessionKey: string): string {
    return `yarn-ts:session:${sessionKey}`;
  }
}
