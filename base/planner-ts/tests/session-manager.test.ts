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

  it("produces structured checkpoint with domain profile and topics", async () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 40,
      checkpointEveryMessages: 4,
      ttlMs: 100000
    });
    await manager.recordTurn("c5", "Help me study vocabulary and quiz me", "Sure! Fill in the blank: The ______ was impressive. A) elation B) hesitation");
    await manager.recordTurn("c5", "B) hesitation", "Correct! Hesitation means a pause before action.");

    const enriched = await manager.enrichIncomingMessages("c5", [{ role: "user", content: "next question" }]);
    const checkpoint = enriched[0]?.content ?? "";

    expect(checkpoint).toContain("<SESSION_STATE>");
    expect(checkpoint).toContain("Conversation arc: tutoring");
    expect(checkpoint).toContain("Active domains:");
    expect(checkpoint).toContain("coherence:");
    expect(checkpoint).toContain("Recent exchanges:");
    expect(checkpoint).toContain("</SESSION_STATE>");
  });

  it("extracts user facts/preferences into checkpoint", async () => {
    const manager = new SessionManager({
      enabled: true,
      maxHistory: 40,
      checkpointEveryMessages: 4,
      ttlMs: 100000
    });
    await manager.recordTurn("c6", "I'm using React and TypeScript for my frontend", "Great combo!");
    await manager.recordTurn("c6", "I prefer functional components over class components", "Understood, I'll use functional components.");

    const enriched = await manager.enrichIncomingMessages("c6", [{ role: "user", content: "show me a button" }]);
    const checkpoint = enriched[0]?.content ?? "";

    expect(checkpoint).toContain("User stated facts/preferences:");
    expect(checkpoint).toMatch(/using React/i);
  });
});
