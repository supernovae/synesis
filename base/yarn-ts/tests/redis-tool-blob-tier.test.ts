import { describe, expect, it, vi } from "vitest";
import { RedisToolBlobTier } from "../src/state/redis-tool-blob-tier.js";

describe("RedisToolBlobTier", () => {
  it("put and get round-trip through Redis", async () => {
    const store = new Map<string, string>();
    const redis = {
      set: vi.fn(
        async (k: string, v: string, _mode?: string, _ttl?: number) => {
          store.set(k, v);
        },
      ),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
    };
    const tier = new RedisToolBlobTier(redis as never, 1_000_000, 3600);
    const { id } = await tier.putToolBlob("hello world");
    expect(id.startsWith("tb_")).toBe(true);
    const out = await tier.getToolBlob(id);
    expect(out).toBe("hello world");
  });
});
