import { describe, expect, it, vi } from "vitest";

const redisState = {
  kv: new Map<string, string>(),
  recent: [] as string[],
  getCalls: [] as string[],
  pipelineOps: [] as Array<{ op: string; args: unknown[] }>,
  zrevrangeCalls: [] as unknown[][],
};

vi.mock("ioredis", () => {
  class MockPipeline {
    set(...args: unknown[]) {
      redisState.pipelineOps.push({ op: "set", args });
      redisState.kv.set(String(args[0]), String(args[1]));
      return this;
    }

    zadd(...args: unknown[]) {
      redisState.pipelineOps.push({ op: "zadd", args });
      redisState.recent.push(String(args[2]));
      return this;
    }

    zremrangebyrank(...args: unknown[]) {
      redisState.pipelineOps.push({ op: "zremrangebyrank", args });
      return this;
    }

    async exec() {
      return [];
    }
  }

  class MockRedis {
    pipeline = vi.fn(() => new MockPipeline());

    get = vi.fn(async (key: string) => {
      redisState.getCalls.push(key);
      return redisState.kv.get(key) ?? null;
    });

    zrevrange = vi.fn(async (...args: unknown[]) => {
      redisState.zrevrangeCalls.push(args);
      return [...redisState.recent].reverse();
    });

    quit = vi.fn().mockResolvedValue(undefined);
  }
  return { Redis: MockRedis };
});

function config() {
  return {
    SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED: true,
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379",
    SYNESIS_YARN_DIAGNOSTIC_REDIS_TTL_S: 60,
  };
}

describe("DiagnosticStore Redis key hardening", () => {
  it("normalizes persisted request IDs before using Redis keys and recent members", async () => {
    redisState.kv.clear();
    redisState.recent = [];
    redisState.pipelineOps = [];

    const { DiagnosticStore } = await import("../src/state/diagnostic-store.js");
    const store = new DiagnosticStore(config() as never);

    store.persistDiagnostic("req-1\nrole=admin", { ok: true });
    await Promise.resolve();

    expect(redisState.pipelineOps[0]).toMatchObject({
      op: "set",
      args: ["yarn:diag:req-1_role_admin", JSON.stringify({ ok: true }), "EX", 60],
    });
    expect(redisState.pipelineOps[1]).toMatchObject({
      op: "zadd",
      args: ["yarn:diag:recent", expect.any(String), "req-1_role_admin"],
    });

    await store.close();
  });

  it("normalizes lookup IDs and clamps recent list limits", async () => {
    redisState.kv.clear();
    redisState.recent = ["req-1\nrole=admin", "req-2"];
    redisState.getCalls = [];
    redisState.zrevrangeCalls = [];
    redisState.kv.set("yarn:diag:req-1_role_admin", JSON.stringify({ ok: true }));

    const { DiagnosticStore } = await import("../src/state/diagnostic-store.js");
    const store = new DiagnosticStore(config() as never);

    await expect(store.getDiagnostic("req-1\nrole=admin")).resolves.toEqual({ ok: true });
    expect(redisState.getCalls).toEqual(["yarn:diag:req-1_role_admin"]);

    await expect(store.listRecentDiagnostics(999)).resolves.toEqual(["req-2", "req-1_role_admin"]);
    expect(redisState.zrevrangeCalls[0]).toEqual(["yarn:diag:recent", 0, 199]);

    await store.close();
  });
});
