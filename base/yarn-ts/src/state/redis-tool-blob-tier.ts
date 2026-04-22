/**
 * Redis-backed {@link ToolBlobTier} for UTF-8 tool payloads (multi-replica safe).
 * Keys: `yarn-ts:toolblob:{id}` with TTL.
 */

import crypto from "node:crypto";
import type { Redis } from "ioredis";
import type { ToolBlobTier } from "./tool-blob-tier.js";

const KEY_PREFIX = "yarn-ts:toolblob:";

export class RedisToolBlobTier implements ToolBlobTier {
  constructor(
    private readonly redis: Redis,
    private readonly maxPayloadBytes: number,
    private readonly ttlSeconds: number,
  ) {}

  async putToolBlob(payload: string): Promise<{ id: string }> {
    const id = `tb_${crypto.randomUUID()}`;
    const bytes = Buffer.byteLength(payload, "utf8");
    let stored = payload;
    if (bytes > this.maxPayloadBytes) {
      stored = payload.slice(0, this.maxPayloadBytes) + `\n... [truncated from ${bytes} bytes]`;
    }
    await this.redis.set(`${KEY_PREFIX}${id}`, stored, "EX", this.ttlSeconds);
    return { id };
  }

  async getToolBlob(id: string): Promise<string | undefined> {
    const raw = await this.redis.get(`${KEY_PREFIX}${id}`);
    return raw ?? undefined;
  }
}
