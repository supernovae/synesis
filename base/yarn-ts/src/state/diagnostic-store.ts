/**
 * Redis-backed diagnostic persistence — survives pod restarts and enables
 * per-request diagnostic lookup via API.
 *
 * Falls back gracefully when Redis is unavailable (fire-and-forget writes).
 */

import { Redis } from "ioredis";
import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";

const KEY_PREFIX = "yarn:diag:";
const RECENT_SET = "yarn:diag:recent";
const MAX_RECENT = 200;
const REQUEST_ID_KEY_LIMIT = 160;

export interface DiagnosticStoreStats {
  persisted: number;
  persistErrors: number;
  lookups: number;
  lookupErrors: number;
}

export class DiagnosticStore {
  private readonly redis: Redis | null;
  private readonly ttlSeconds: number;
  private readonly stats: DiagnosticStoreStats = {
    persisted: 0,
    persistErrors: 0,
    lookups: 0,
    lookupErrors: 0,
  };

  constructor(config: AppConfig) {
    if (config.SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED && config.SYNESIS_YARN_SESSION_REDIS_URL) {
      this.redis = new Redis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        commandTimeout: 1000,
      });
    } else {
      this.redis = null;
    }
    this.ttlSeconds = config.SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S;
  }

  persistDiagnostic(requestId: string, diagnostic: Record<string, unknown>): void {
    if (!this.redis) return;
    const safeRequestId = safeDiagnosticRequestId(requestId);
    if (!safeRequestId) return;
    const key = `${KEY_PREFIX}${safeRequestId}`;
    const data = JSON.stringify(diagnostic);
    const now = Date.now();

    this.redis
      .pipeline()
      .set(key, data, "EX", this.ttlSeconds)
      .zadd(RECENT_SET, String(now), safeRequestId)
      .zremrangebyrank(RECENT_SET, 0, -(MAX_RECENT + 1))
      .exec()
      .then(() => {
        this.stats.persisted += 1;
      })
      .catch(() => {
        this.stats.persistErrors += 1;
      });
  }

  async getDiagnostic(requestId: string): Promise<Record<string, unknown> | null> {
    if (!this.redis) return null;
    const safeRequestId = safeDiagnosticRequestId(requestId);
    if (!safeRequestId) return null;
    this.stats.lookups += 1;
    try {
      const raw = await this.redis.get(`${KEY_PREFIX}${safeRequestId}`);
      if (!raw) return null;
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.stats.lookupErrors += 1;
      return null;
    }
  }

  async listRecentDiagnostics(limit = 20): Promise<string[]> {
    if (!this.redis) return [];
    try {
      const safeLimit = Math.max(1, Math.min(MAX_RECENT, Math.floor(limit)));
      const rows = await this.redis.zrevrange(RECENT_SET, 0, safeLimit - 1);
      return rows.map((row) => safeDiagnosticRequestId(row)).filter((row): row is string => Boolean(row));
    } catch {
      return [];
    }
  }

  getStats(): DiagnosticStoreStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    await this.redis?.quit();
  }
}

function safeDiagnosticRequestId(value: unknown): string | null {
  const raw = replaceControlCharsWithSpace(String(value ?? "")).trim();
  if (!raw) return null;
  const safe = raw
    .replace(/[^A-Za-z0-9_.@:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!safe) return null;
  if (safe.length <= REQUEST_ID_KEY_LIMIT) return safe;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return `${safe.slice(0, 96)}-${digest}`;
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
}
