/**
 * MemoryStore — explicit observation storage and recall for the model.
 *
 * Implements the MemGPT-style "external context" tier: the model can
 * store findings via StoreObservation and retrieve them via RecallFindings,
 * giving it persistent memory across evaluation passes and tool rounds.
 *
 * Hybrid storage: in-memory LRU (always available) + Redis (durable,
 * shared across replicas). When Redis is available, it is the source of
 * truth; the in-memory layer acts as a write-through cache. When Redis
 * is unavailable, the in-memory layer provides graceful degradation.
 */

import type { Redis } from "ioredis";
import type { MemoryScope, MemoryStoreStats, StoredObservation } from "./types.js";

const REDIS_PREFIX = "yarn-ts:memory:";
const DEFAULT_TTL_S = 14_400;

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `obs_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export class MemoryStore {
  private readonly maxEntries: number;
  private readonly stats: MemoryStoreStats = {
    totalStored: 0,
    totalRecalled: 0,
    sessionEntries: 0,
    projectEntries: 0,
  };
  /** In-memory write-through cache, keyed by scope:scopeKey. */
  private readonly localCache = new Map<string, StoredObservation[]>();

  constructor(
    private readonly redis: Redis | null,
    maxEntries = 200,
    private readonly ttlSeconds = DEFAULT_TTL_S,
  ) {
    this.maxEntries = maxEntries;
  }

  async store(
    topic: string,
    finding: string,
    scope: MemoryScope,
    sessionKey: string,
    projectRoot: string,
  ): Promise<StoredObservation> {
    const obs: StoredObservation = {
      id: generateId(),
      topic: topic.trim(),
      finding: finding.trim(),
      scope,
      sessionKey,
      projectRoot,
      createdAt: Date.now(),
    };

    const cacheKey = this.cacheKey(scope, scope === "session" ? sessionKey : projectRoot);
    this.localPush(cacheKey, obs);

    if (this.redis) {
      try {
        const redisKey = this.listKey(scope, scope === "session" ? sessionKey : projectRoot);
        const raw = JSON.stringify(obs);
        await this.redis.lpush(redisKey, raw);
        await this.redis.ltrim(redisKey, 0, this.maxEntries - 1);
        await this.redis.expire(redisKey, this.ttlSeconds);
      } catch {
        /* Redis failure — local cache still has it */
      }
    }

    this.stats.totalStored += 1;
    if (scope === "session") this.stats.sessionEntries += 1;
    else this.stats.projectEntries += 1;

    return obs;
  }

  async recall(
    query: string,
    scope: MemoryScope | "all",
    sessionKey: string,
    projectRoot: string,
    limit = 10,
  ): Promise<StoredObservation[]> {
    this.stats.totalRecalled += 1;

    let allObs: StoredObservation[];

    if (this.redis) {
      allObs = await this.recallFromRedis(scope, sessionKey, projectRoot);
    } else {
      allObs = this.recallFromLocal(scope, sessionKey, projectRoot);
    }

    if (!query.trim()) {
      return allObs.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    }

    const q = query.toLowerCase();
    return allObs
      .filter((o) => o.topic.toLowerCase().includes(q) || o.finding.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async listAll(
    scope: MemoryScope,
    scopeKey: string,
    limit = 50,
  ): Promise<StoredObservation[]> {
    if (this.redis) {
      try {
        const key = this.listKey(scope, scopeKey);
        const items = await this.redis.lrange(key, 0, limit - 1);
        return items.map((raw) => {
          try { return JSON.parse(raw) as StoredObservation; } catch { return null; }
        }).filter((o): o is StoredObservation => o !== null);
      } catch { /* fall through to local */ }
    }
    const cacheKey = this.cacheKey(scope, scopeKey);
    return (this.localCache.get(cacheKey) ?? []).slice(0, limit);
  }

  /** Count stored observations for a session (local cache, O(1)). */
  countSession(sessionKey: string): number {
    return (this.localCache.get(this.cacheKey("session", sessionKey)) ?? []).length;
  }

  /** Clear session-scoped entries (local + Redis). */
  async clearSession(sessionKey: string): Promise<void> {
    this.localCache.delete(this.cacheKey("session", sessionKey));
    if (this.redis) {
      try {
        await this.redis.del(this.listKey("session", sessionKey));
      } catch { /* best effort */ }
    }
  }

  /** Clear project-scoped entries (local + Redis). For testing. */
  async clearProject(projectRoot: string): Promise<void> {
    this.localCache.delete(this.cacheKey("project", projectRoot));
    if (this.redis) {
      try {
        await this.redis.del(this.listKey("project", projectRoot));
      } catch { /* best effort */ }
    }
  }

  formatRecallBlock(findings: StoredObservation[]): string {
    if (findings.length === 0) return "<RECALLED_FINDINGS>No matching findings stored.</RECALLED_FINDINGS>";
    const lines = findings.map((f) =>
      `[${f.topic}] (${f.scope}, ${new Date(f.createdAt).toISOString().slice(0, 16)}): ${f.finding}`,
    );
    return [
      "<RECALLED_FINDINGS>",
      ...lines,
      "</RECALLED_FINDINGS>",
    ].join("\n");
  }

  getStats(): MemoryStoreStats {
    return { ...this.stats };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private localPush(cacheKey: string, obs: StoredObservation): void {
    let list = this.localCache.get(cacheKey);
    if (!list) {
      list = [];
      this.localCache.set(cacheKey, list);
    }
    list.unshift(obs);
    if (list.length > this.maxEntries) {
      list.length = this.maxEntries;
    }
  }

  private recallFromLocal(
    scope: MemoryScope | "all",
    sessionKey: string,
    projectRoot: string,
  ): StoredObservation[] {
    const results: StoredObservation[] = [];
    if (scope === "session" || scope === "all") {
      results.push(...(this.localCache.get(this.cacheKey("session", sessionKey)) ?? []));
    }
    if (scope === "project" || scope === "all") {
      results.push(...(this.localCache.get(this.cacheKey("project", projectRoot)) ?? []));
    }
    return results;
  }

  private async recallFromRedis(
    scope: MemoryScope | "all",
    sessionKey: string,
    projectRoot: string,
  ): Promise<StoredObservation[]> {
    try {
      const keys: string[] = [];
      if (scope === "session" || scope === "all") {
        keys.push(this.listKey("session", sessionKey));
      }
      if (scope === "project" || scope === "all") {
        keys.push(this.listKey("project", projectRoot));
      }

      const allObs: StoredObservation[] = [];
      for (const key of keys) {
        const items = await this.redis!.lrange(key, 0, this.maxEntries - 1);
        for (const raw of items) {
          try {
            allObs.push(JSON.parse(raw) as StoredObservation);
          } catch { /* skip malformed */ }
        }
      }
      return allObs;
    } catch {
      return this.recallFromLocal(scope, sessionKey, projectRoot);
    }
  }

  private listKey(scope: MemoryScope, scopeKey: string): string {
    return `${REDIS_PREFIX}${scope}:${scopeKey}`;
  }

  private cacheKey(scope: MemoryScope, scopeKey: string): string {
    return `${scope}:${scopeKey}`;
  }
}
