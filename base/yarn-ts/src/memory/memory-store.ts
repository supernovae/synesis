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

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { MemoryScope, MemoryStoreStats, StoredObservation } from "./types.js";
import { normalizeAbsolutePathHint } from "../path-governance/path-hints.js";

const REDIS_PREFIX = "yarn-ts:memory:";
const DEFAULT_TTL_S = 14_400;

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `obs_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function hashKeyPart(label: string, value: string, chars = 32): string {
  return `${label}-${createHash("sha256").update(value).digest("hex").slice(0, chars)}`;
}

function canonicalProjectRoot(projectRoot: string): string {
  const normalized = normalizeAbsolutePathHint(projectRoot);
  if (normalized) return normalized;
  const raw = projectRoot.replace(/\0/g, "").trim();
  if (raw === "no-workspace" || /^invalid-workspace-[a-f0-9]{32}$/.test(raw)) return raw;
  return raw ? hashKeyPart("invalid-workspace", raw) : "no-workspace";
}

function canonicalNamespace(namespace: string | undefined): string | undefined {
  const raw = namespace?.replace(/\0/g, "").trim();
  if (!raw) return undefined;
  if (raw.length <= 160 && /^[A-Za-z0-9_.:@-]+$/.test(raw)) return raw;
  return hashKeyPart("namespace", raw);
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
    options: { namespace?: string } = {},
  ): Promise<StoredObservation> {
    const safeProjectRoot = canonicalProjectRoot(projectRoot);
    const safeNamespace = canonicalNamespace(options.namespace);
    const obs: StoredObservation = {
      id: generateId(),
      topic: topic.trim(),
      finding: finding.trim(),
      scope,
      sessionKey,
      projectRoot: safeProjectRoot,
      namespace: safeNamespace,
      createdAt: Date.now(),
    };

    const scopeKey = this.scopeKey(scope, sessionKey, safeProjectRoot, safeNamespace);
    const cacheKey = this.cacheKey(scope, scopeKey);
    this.localPush(cacheKey, obs);

    if (this.redis) {
      try {
        const redisKey = this.listKey(scope, scopeKey);
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
    options: { namespace?: string } = {},
  ): Promise<StoredObservation[]> {
    this.stats.totalRecalled += 1;

    let allObs: StoredObservation[];

    if (this.redis) {
      allObs = await this.recallFromRedis(scope, sessionKey, canonicalProjectRoot(projectRoot), canonicalNamespace(options.namespace));
    } else {
      allObs = this.recallFromLocal(scope, sessionKey, canonicalProjectRoot(projectRoot), canonicalNamespace(options.namespace));
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
    options: { namespace?: string } = {},
  ): Promise<StoredObservation[]> {
    const safeNamespace = canonicalNamespace(options.namespace);
    const effectiveScopeKey = scope === "project"
      ? this.scopedProjectKey(scopeKey, safeNamespace)
      : scopeKey;
    if (this.redis) {
      try {
        const key = this.listKey(scope, effectiveScopeKey);
        const items = await this.redis.lrange(key, 0, limit - 1);
        return items.map((raw) => {
          try { return JSON.parse(raw) as StoredObservation; } catch { return null; }
        }).filter((o): o is StoredObservation => o !== null);
      } catch { /* fall through to local */ }
    }
    const cacheKey = this.cacheKey(scope, effectiveScopeKey);
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
  async clearProject(projectRoot: string, options: { namespace?: string } = {}): Promise<void> {
    const scopeKey = this.scopeKey("project", "", canonicalProjectRoot(projectRoot), canonicalNamespace(options.namespace));
    this.localCache.delete(this.cacheKey("project", scopeKey));
    if (this.redis) {
      try {
        await this.redis.del(this.listKey("project", scopeKey));
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
    namespace?: string,
  ): StoredObservation[] {
    const results: StoredObservation[] = [];
    if (scope === "session" || scope === "all") {
      results.push(...(this.localCache.get(this.cacheKey("session", this.scopeKey("session", sessionKey, projectRoot, namespace))) ?? []));
    }
    if (scope === "project" || scope === "all") {
      results.push(...(this.localCache.get(this.cacheKey("project", this.scopeKey("project", sessionKey, projectRoot, namespace))) ?? []));
    }
    return results;
  }

  private async recallFromRedis(
    scope: MemoryScope | "all",
    sessionKey: string,
    projectRoot: string,
    namespace?: string,
  ): Promise<StoredObservation[]> {
    try {
      const keys: string[] = [];
      if (scope === "session" || scope === "all") {
        keys.push(this.listKey("session", this.scopeKey("session", sessionKey, projectRoot, namespace)));
      }
      if (scope === "project" || scope === "all") {
        keys.push(this.listKey("project", this.scopeKey("project", sessionKey, projectRoot, namespace)));
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
      return this.recallFromLocal(scope, sessionKey, projectRoot, namespace);
    }
  }

  private scopeKey(scope: MemoryScope, sessionKey: string, projectRoot: string, namespace?: string): string {
    return scope === "session"
      ? sessionKey
      : this.scopedProjectKey(projectRoot, namespace);
  }

  private scopedProjectKey(projectRoot: string, namespace?: string): string {
    const ns = namespace?.trim() ? namespace.trim() : "global";
    return `${ns}:${canonicalProjectRoot(projectRoot)}`;
  }

  private listKey(scope: MemoryScope, scopeKey: string): string {
    return `${REDIS_PREFIX}${scope}:${this.safeScopeKey(scopeKey)}`;
  }

  private cacheKey(scope: MemoryScope, scopeKey: string): string {
    return `${scope}:${this.safeScopeKey(scopeKey)}`;
  }

  private safeScopeKey(scopeKey: string): string {
    const trimmed = scopeKey.replace(/\0/g, "").trim() || "unknown";
    const encoded = encodeURIComponent(trimmed);
    if (encoded.length <= 180) return encoded;
    return `sha256-${createHash("sha256").update(trimmed).digest("hex")}`;
  }
}
