import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/context/session-manager.js";

describe("SessionManager", () => {
  it("injects checkpoint block into incoming messages", () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 2,
      ttlMs: 100000
    });
    manager.recordTurn("c1", "user one", "assistant one");
    manager.recordTurn("c1", "user two", "assistant two");

    const enriched = manager.enrichIncomingMessages("c1", [{ role: "user", content: "next" }]);
    expect(enriched[0]?.role).toBe("system");
    expect(enriched[0]?.content).toContain("<SESSION_STATE>");
  });

  it("returns telemetry counters", () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 3,
      ttlMs: 100000
    });
    manager.recordTurn("c2", "u", "a");
    const telemetry = manager.telemetry();
    expect(telemetry.activeSessions).toBe(1);
    expect(telemetry.totalHistoryEntries).toBeGreaterThan(0);
  });
});
