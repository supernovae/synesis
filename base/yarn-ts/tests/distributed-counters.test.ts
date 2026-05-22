import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("ioredis", () => {
  class MockRedis {
    evalStorage = new Map<string, number>();
    getStorage = new Map<string, string>();

    eval = vi.fn(async (script: string, _numKeys: number, key: string, ...argv: string[]) => {
      if (script.includes("INCR")) {
        const current = this.evalStorage.get(key) ?? 0;
        const next = current + 1;
        this.evalStorage.set(key, next);
        return next;
      }
      if (script.includes('"SET"')) {
        const value = Number(argv[0]);
        this.evalStorage.set(key, value);
        return value;
      }
      return 0;
    });

    get = vi.fn(async (key: string) => {
      const val = this.evalStorage.get(key);
      return val !== undefined ? String(val) : null;
    });

    quit = vi.fn().mockResolvedValue(undefined);
  }
  return { Redis: MockRedis };
});

describe("DistributedCounterService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increments repeat count atomically", async () => {
    const { DistributedCounterService } = await import("../src/state/distributed-counters.js");
    const svc = new DistributedCounterService({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
      SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS: 1_800_000,
      SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    } as never);

    const count1 = await svc.incrRepeatCount("sess1", "hash1");
    expect(count1).toBe(1);

    const count2 = await svc.incrRepeatCount("sess1", "hash1");
    expect(count2).toBe(2);

    const count3 = await svc.incrRepeatCount("sess1", "hash2");
    expect(count3).toBe(1);

    expect(svc.getStats().redisOps).toBe(3);
    expect(svc.getStats().redisErrors).toBe(0);

    await svc.close();
  });

  it("set/get consecutive tool calls round-trips", async () => {
    const { DistributedCounterService } = await import("../src/state/distributed-counters.js");
    const svc = new DistributedCounterService({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
      SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS: 1_800_000,
      SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    } as never);

    await svc.setConsecutiveToolCalls("sess1", 5);
    const val = await svc.getConsecutiveToolCalls("sess1");
    expect(val).toBe(5);

    await svc.setConsecutiveToolCalls("sess1", 0);
    const reset = await svc.getConsecutiveToolCalls("sess1");
    expect(reset).toBe(0);

    await svc.close();
  });

  it("returns null on Redis failure (fallback path)", async () => {
    const { DistributedCounterService } = await import("../src/state/distributed-counters.js");
    const svc = new DistributedCounterService({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
      SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS: 1_800_000,
      SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    } as never);

    const redis = (svc as unknown as { redis: { eval: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } }).redis;
    redis.eval = vi.fn().mockRejectedValue(new Error("Connection refused"));
    redis.get = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const count = await svc.incrRepeatCount("sess1", "hash1");
    expect(count).toBeNull();

    const toolCalls = await svc.getConsecutiveToolCalls("sess1");
    expect(toolCalls).toBeNull();

    expect(svc.getStats().redisErrors).toBe(2);
    expect(svc.getStats().fallbackInvocations).toBe(2);

    await svc.close();
  });

  it("returns 0 for missing consecutive tool call key", async () => {
    const { DistributedCounterService } = await import("../src/state/distributed-counters.js");
    const svc = new DistributedCounterService({
      SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
      SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS: 1_800_000,
      SYNESIS_YARN_SESSION_TTL_MS: 14_400_000,
    } as never);

    const val = await svc.getConsecutiveToolCalls("nonexistent-session");
    expect(val).toBe(0);

    await svc.close();
  });
});
