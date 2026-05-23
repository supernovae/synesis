import { describe, expect, it, vi } from "vitest";
import { SessionEventStore } from "../src/state/session-event-store.js";
import type { AppConfig } from "../src/config.js";

function config(): AppConfig {
  return {
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
    SYNESIS_YARN_SESSION_TTL_MS: 60_000,
  } as AppConfig;
}

describe("SessionEventStore", () => {
  it("appends bounded events with TTL using Redis pipeline operations", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const redis = {
      multi: vi.fn(() => ({
        lpush: vi.fn((...args: unknown[]) => { calls.push(["lpush", ...args]); return undefined; }),
        ltrim: vi.fn((...args: unknown[]) => { calls.push(["ltrim", ...args]); return undefined; }),
        expire: vi.fn((...args: unknown[]) => { calls.push(["expire", ...args]); return undefined; }),
        exec: vi.fn().mockResolvedValue([]),
      })),
      lpush: vi.fn(),
      ltrim: vi.fn(),
      expire: vi.fn(),
      lrange: vi.fn(),
      del: vi.fn(),
      quit: vi.fn(),
    };
    const store = new SessionEventStore(config(), { redis: redis as never, maxEvents: 3, ttlMs: 60_000 });

    await store.append("s1", { type: "tool_event", requestId: "r1", payload: { tool: "Bash" } });

    expect(calls[0][0]).toBe("lpush");
    expect(calls[0][1]).toBe("yarn-ts:session-events:s1");
    expect(JSON.parse(calls[0][2] as string)).toMatchObject({ type: "tool_event", requestId: "r1" });
    expect(calls).toContainEqual(["ltrim", "yarn-ts:session-events:s1", 0, 2]);
    expect(calls).toContainEqual(["expire", "yarn-ts:session-events:s1", 60]);
  });

  it("reads recent events and skips malformed ledger rows", async () => {
    const redis = {
      lrange: vi.fn().mockResolvedValue([
        JSON.stringify({ type: "provider_result", at: 10 }),
        "not-json",
        JSON.stringify({ nope: true }),
      ]),
      del: vi.fn(),
      quit: vi.fn(),
    };
    const store = new SessionEventStore(config(), { redis: redis as never, maxEvents: 10 });

    const events = await store.readRecent("s1", 5);

    expect(redis.lrange).toHaveBeenCalledWith("yarn-ts:session-events:s1", 0, 4);
    expect(events).toEqual([{ type: "provider_result", at: 10 }]);
  });

  it("clears events by session key", async () => {
    const redis = {
      lrange: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn(),
    };
    const store = new SessionEventStore(config(), { redis: redis as never });

    await store.clear("s1");

    expect(redis.del).toHaveBeenCalledWith("yarn-ts:session-events:s1");
  });
});
