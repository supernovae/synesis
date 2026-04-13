/**
 * MemoryStore — explicit observation storage and recall for the model.
 *
 * Implements the MemGPT-style "external context" tier: the model can
 * store findings via StoreObservation and retrieve them via RecallFindings,
 * giving it persistent memory across evaluation passes and tool rounds.
 *
 * Storage: Redis, partitioned by session and project scope.
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

    if (this.redis) {
      const key = this.listKey(scope, scope === "session" ? sessionKey : projectRoot);
      const raw = JSON.stringify(obs);
      await this.redis.lpush(key, raw);
      await this.redis.ltrim(key, 0, this.maxEntries - 1);
      await this.redis.expire(key, this.ttlSeconds);
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
    if (!this.redis) return [];

    const keys: string[] = [];
    if (scope === "session" || scope === "all") {
      keys.push(this.listKey("session", sessionKey));
    }
    if (scope === "project" || scope === "all") {
      keys.push(this.listKey("project", projectRoot));
    }

    const allObs: StoredObservation[] = [];
    for (const key of keys) {
      const items = await this.redis.lrange(key, 0, this.maxEntries - 1);
      for (const raw of items) {
        try {
          allObs.push(JSON.parse(raw) as StoredObservation);
        } catch { /* skip malformed */ }
      }
    }

    const q = query.toLowerCase();
    const matched = allObs
      .filter((o) => o.topic.toLowerCase().includes(q) || o.finding.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);

    return matched;
  }

  /**
   * List all observations for a session or project (no filtering).
   */
  async listAll(
    scope: MemoryScope,
    scopeKey: string,
    limit = 50,
  ): Promise<StoredObservation[]> {
    if (!this.redis) return [];
    const key = this.listKey(scope, scopeKey);
    const items = await this.redis.lrange(key, 0, limit - 1);
    const results: StoredObservation[] = [];
    for (const raw of items) {
      try {
        results.push(JSON.parse(raw) as StoredObservation);
      } catch { /* skip */ }
    }
    return results;
  }

  /**
   * Format recalled findings as a compact system block.
   */
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

  private listKey(scope: MemoryScope, scopeKey: string): string {
    return `${REDIS_PREFIX}${scope}:${scopeKey}`;
  }
}
