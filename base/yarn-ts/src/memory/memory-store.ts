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
import { canonicalMemoryNamespace, canonicalMemoryProjectRoot, safeMemoryCachePart } from "./cache-identity.js";

const REDIS_PREFIX = "yarn-ts:memory:";
const DEFAULT_TTL_S = 14_400;
const MAX_MEMORY_TOPIC_CHARS = 256;
const MAX_MEMORY_FINDING_CHARS = 16_000;
const MAX_MEMORY_KEY_CHARS = 512;
const MEMORY_SCOPES = new Set<MemoryScope>(["session", "project"]);

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
    options: { namespace?: string } = {},
  ): Promise<StoredObservation> {
    const safeProjectRoot = canonicalMemoryProjectRoot(projectRoot);
    const safeNamespace = canonicalMemoryNamespace(options.namespace);
    const obs: StoredObservation = {
      id: generateId(),
      topic: memoryText(topic, MAX_MEMORY_TOPIC_CHARS) || "observation",
      finding: memoryText(finding, MAX_MEMORY_FINDING_CHARS) || "empty",
      scope,
      sessionKey: memoryText(sessionKey, MAX_MEMORY_KEY_CHARS) || "unknown",
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
      allObs = await this.recallFromRedis(
        scope,
        sessionKey,
        canonicalMemoryProjectRoot(projectRoot),
        canonicalMemoryNamespace(options.namespace),
      );
    } else {
      allObs = this.recallFromLocal(
        scope,
        sessionKey,
        canonicalMemoryProjectRoot(projectRoot),
        canonicalMemoryNamespace(options.namespace),
      );
    }

    const safeLimit = safeLimitInt(limit, 1, this.maxEntries);
    const safeQuery = memoryText(query, 512).toLowerCase();

    if (!safeQuery) {
      return allObs.sort((a, b) => b.createdAt - a.createdAt).slice(0, safeLimit);
    }

    return allObs
      .filter((o) => o.topic.toLowerCase().includes(safeQuery) || o.finding.toLowerCase().includes(safeQuery))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, safeLimit);
  }

  async listAll(
    scope: MemoryScope,
    scopeKey: string,
    limit = 50,
    options: { namespace?: string } = {},
  ): Promise<StoredObservation[]> {
    const safeNamespace = canonicalMemoryNamespace(options.namespace);
    const effectiveScopeKey = scope === "project"
      ? this.scopedProjectKey(scopeKey, safeNamespace)
      : scopeKey;
    if (this.redis) {
      try {
        const key = this.listKey(scope, effectiveScopeKey);
        const safeLimit = safeLimitInt(limit, 1, this.maxEntries);
        const items = await this.redis.lrange(key, 0, safeLimit - 1);
        return items.map((raw) => {
          try { return normalizeStoredObservation(JSON.parse(raw)); } catch { return null; }
        }).filter((o): o is StoredObservation => o !== null);
      } catch { /* fall through to local */ }
    }
    const cacheKey = this.cacheKey(scope, effectiveScopeKey);
    return (this.localCache.get(cacheKey) ?? []).slice(0, safeLimitInt(limit, 1, this.maxEntries));
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
    const scopeKey = this.scopeKey(
      "project",
      "",
      canonicalMemoryProjectRoot(projectRoot),
      canonicalMemoryNamespace(options.namespace),
    );
    this.localCache.delete(this.cacheKey("project", scopeKey));
    if (this.redis) {
      try {
        await this.redis.del(this.listKey("project", scopeKey));
      } catch { /* best effort */ }
    }
  }

  formatRecallBlock(findings: StoredObservation[]): string {
    if (findings.length === 0) return "<RECALLED_FINDINGS>No matching findings stored.</RECALLED_FINDINGS>";
    const lines = findings
      .map((finding) => normalizeStoredObservation(finding))
      .filter((finding): finding is StoredObservation => Boolean(finding))
      .map((f) => `[${f.topic}] (${f.scope}, ${new Date(f.createdAt).toISOString().slice(0, 16)}): ${f.finding}`);
    if (lines.length === 0) return "<RECALLED_FINDINGS>No matching findings stored.</RECALLED_FINDINGS>";
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
            const obs = normalizeStoredObservation(JSON.parse(raw));
            if (obs) allObs.push(obs);
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
    return `${ns}:${canonicalMemoryProjectRoot(projectRoot)}`;
  }

  private listKey(scope: MemoryScope, scopeKey: string): string {
    return `${REDIS_PREFIX}${scope}:${this.safeScopeKey(scopeKey)}`;
  }

  private cacheKey(scope: MemoryScope, scopeKey: string): string {
    return `${scope}:${this.safeScopeKey(scopeKey)}`;
  }

  private safeScopeKey(scopeKey: string): string {
    return safeMemoryCachePart(scopeKey, "unknown");
  }
}

function normalizeStoredObservation(value: unknown): StoredObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const scope = typeof row.scope === "string" && MEMORY_SCOPES.has(row.scope as MemoryScope)
    ? row.scope as MemoryScope
    : null;
  if (!scope) return null;
  const topic = memoryText(row.topic, MAX_MEMORY_TOPIC_CHARS);
  const finding = memoryText(row.finding, MAX_MEMORY_FINDING_CHARS);
  if (!topic || !finding) return null;
  return {
    id: memoryText(row.id, MAX_MEMORY_KEY_CHARS) || "obs_unknown",
    topic,
    finding,
    scope,
    sessionKey: memoryText(row.sessionKey, MAX_MEMORY_KEY_CHARS) || "unknown",
    projectRoot: canonicalMemoryProjectRoot(typeof row.projectRoot === "string" ? row.projectRoot : ""),
    namespace: canonicalMemoryNamespace(typeof row.namespace === "string" ? row.namespace : undefined),
    createdAt: safeTimestamp(row.createdAt),
  };
}

function memoryText(value: unknown, maxChars: number): string {
  return replaceControlCharsWithSpace(String(value ?? ""))
    .replace(/[<>"`]/g, "_")
    .replace(/=/g, ":")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}

function safeTimestamp(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function safeLimitInt(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}
