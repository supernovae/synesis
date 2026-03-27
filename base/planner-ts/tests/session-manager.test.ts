import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/context/session-manager.js";

describe("SessionManager", () => {
  it("injects checkpoint block into incoming messages", async () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 2,
      ttlMs: 100000
    });
    await manager.recordTurn("c1", "user one", "assistant one");
    await manager.recordTurn("c1", "user two", "assistant two");

    const enriched = await manager.enrichIncomingMessages("c1", [{ role: "user", content: "next" }]);
    expect(enriched[0]?.role).toBe("system");
    expect(enriched[0]?.content).toContain("<SESSION_STATE>");
  });

  it("returns telemetry counters", async () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 3,
      ttlMs: 100000
    });
    await manager.recordTurn("c2", "u", "a");
    const telemetry = await manager.telemetry();
    expect(telemetry.activeSessions).toBe(1);
    expect(telemetry.totalHistoryEntries).toBeGreaterThan(0);
    expect(telemetry.storeBackend).toBe("memory");
  });

  it("purges a conversation by key", async () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 10,
      ttlMs: 100000
    });
    await manager.recordTurn("c3", "hi", "hello");
    const before = await manager.telemetry();
    expect(before.activeSessions).toBe(1);

    const deleted = await manager.purge("c3");
    expect(deleted).toBe(true);

    const after = await manager.telemetry();
    expect(after.activeSessions).toBe(0);
  });

  it("returns false when purging non-existent key", async () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 10,
      ttlMs: 100000
    });
    const result = await manager.purge("nonexistent");
    expect(result).toBe(false);
  });
});
