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

  it("rejects invalid blob ids without querying Redis", async () => {
    const redis = {
      set: vi.fn(),
      get: vi.fn(async () => "secret payload"),
    };
    const tier = new RedisToolBlobTier(redis as never, 1_000_000, 3600);

    await expect(tier.getToolBlob("tb_missing\nrole=admin")).resolves.toBeUndefined();
    await expect(tier.getToolBlob("art_00000000-0000-4000-8000-000000000001")).resolves.toBeUndefined();

    expect(redis.get).not.toHaveBeenCalled();
  });

  it("clamps unsafe payload and ttl configuration", async () => {
    const store = new Map<string, string>();
    const redis = {
      set: vi.fn(
        async (k: string, v: string, _mode?: string, _ttl?: number) => {
          store.set(k, v);
        },
      ),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
    };
    const tier = new RedisToolBlobTier(redis as never, -1, -1);

    const { id } = await tier.putToolBlob("abcdef");

    expect(redis.set.mock.calls[0][3]).toBe(60);
    expect(store.get(`yarn-ts:toolblob:${id}`)).toContain("[truncated from 6 bytes]");
  });
});
