/**
 * Redis-backed {@link ToolBlobTier} for UTF-8 tool payloads (multi-replica safe).
 * Keys: `yarn-ts:toolblob:{id}` with TTL.
 */

import crypto from "node:crypto";
import type { Redis } from "ioredis";
import type { ToolBlobTier } from "./tool-blob-tier.js";

const KEY_PREFIX = "yarn-ts:toolblob:";
const TOOL_BLOB_ID_RE = /^tb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_PAYLOAD_BYTES_CAP = 10 * 1_048_576;
const DEFAULT_TTL_SECONDS = 3_600;

export class RedisToolBlobTier implements ToolBlobTier {
  private readonly effectiveMaxPayloadBytes: number;
  private readonly effectiveTtlSeconds: number;

  constructor(
    private readonly redis: Redis,
    maxPayloadBytes: number,
    ttlSeconds: number,
  ) {
    this.effectiveMaxPayloadBytes = clampInt(maxPayloadBytes, 1, MAX_PAYLOAD_BYTES_CAP, DEFAULT_MAX_PAYLOAD_BYTES);
    this.effectiveTtlSeconds = clampInt(ttlSeconds, 60, 86_400, DEFAULT_TTL_SECONDS);
  }

  async putToolBlob(payload: string): Promise<{ id: string }> {
    const id = `tb_${crypto.randomUUID()}`;
    const bytes = Buffer.byteLength(payload, "utf8");
    let stored = payload;
    if (bytes > this.effectiveMaxPayloadBytes) {
      stored = payload.slice(0, this.effectiveMaxPayloadBytes) + `\n... [truncated from ${bytes} bytes]`;
    }
    await this.redis.set(`${KEY_PREFIX}${id}`, stored, "EX", this.effectiveTtlSeconds);
    return { id };
  }

  async getToolBlob(id: string): Promise<string | undefined> {
    if (!TOOL_BLOB_ID_RE.test(id.trim())) return undefined;
    const raw = await this.redis.get(`${KEY_PREFIX}${id.trim()}`);
    return raw ?? undefined;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}
