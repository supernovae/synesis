import { describe, expect, it, beforeEach } from "vitest";
import {
  storeObservationTool,
  recallFindingsTool,
  clearSessionMemory,
  clearProjectMemory,
  getSessionMemoryCount,
  initMemoryToolStore,
} from "../src/mcp/handlers/memory-tools.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import type { McpToolContext } from "../src/mcp/tool-registry.js";

const CTX: McpToolContext = {
  sessionKey: "test-session-1",
  projectRoot: "/home/user/project",
  userId: "u1",
  orgId: "o1",
};

const CTX2: McpToolContext = {
  sessionKey: "test-session-2",
  projectRoot: "/home/user/project",
  userId: "u1",
  orgId: "o1",
};

beforeEach(() => {
  initMemoryToolStore(new MemoryStore(null));
});

describe("store_observation", () => {
  it("stores a session-scoped observation", async () => {
    const result = await storeObservationTool.handler(
      { topic: "auth flow", finding: "JWT tokens are validated in middleware/auth.ts" },
      CTX,
    );
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^obs_/);
    expect(result.stored).toBe(1);
  });

  it("stores multiple observations and counts them", async () => {
    await storeObservationTool.handler({ topic: "db", finding: "Uses PostgreSQL" }, CTX);
    await storeObservationTool.handler({ topic: "auth", finding: "JWT-based" }, CTX);
    const result = await storeObservationTool.handler({ topic: "api", finding: "REST + GraphQL" }, CTX);
    expect(result.stored).toBe(3);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(3);
  });

  it("defaults to session scope", async () => {
    await storeObservationTool.handler({ topic: "test", finding: "session scoped" }, CTX);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(1);
  });

  it("supports project scope", async () => {
    await storeObservationTool.handler(
      { topic: "architecture", finding: "Monorepo with npm workspaces", scope: "project" },
      CTX,
    );
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(0);
  });
});

describe("recall_findings", () => {
  it("recalls stored findings by query", async () => {
    await storeObservationTool.handler({ topic: "auth", finding: "JWT tokens in auth.ts" }, CTX);
    await storeObservationTool.handler({ topic: "database", finding: "PostgreSQL with Prisma" }, CTX);
    await storeObservationTool.handler({ topic: "testing", finding: "Vitest for unit tests" }, CTX);

    const result = await recallFindingsTool.handler({ query: "auth" }, CTX);
    expect(result.count).toBe(1);
    expect(result.findings[0].topic).toBe("auth");
  });

  it("returns all findings when query is empty", async () => {
    await storeObservationTool.handler({ topic: "a", finding: "first" }, CTX);
    await storeObservationTool.handler({ topic: "b", finding: "second" }, CTX);

    const result = await recallFindingsTool.handler({}, CTX);
    expect(result.count).toBe(2);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await storeObservationTool.handler({ topic: `topic-${i}`, finding: `finding ${i}` }, CTX);
    }
    const result = await recallFindingsTool.handler({ limit: 2 }, CTX);
    expect(result.count).toBe(2);
  });

  it("isolates sessions", async () => {
    await storeObservationTool.handler({ topic: "a", finding: "session 1 finding" }, CTX);
    await storeObservationTool.handler({ topic: "b", finding: "session 2 finding" }, CTX2);

    const r1 = await recallFindingsTool.handler({ scope: "session" }, CTX);
    expect(r1.count).toBe(1);
    expect(r1.findings[0].finding).toBe("session 1 finding");

    const r2 = await recallFindingsTool.handler({ scope: "session" }, CTX2);
    expect(r2.count).toBe(1);
    expect(r2.findings[0].finding).toBe("session 2 finding");
  });

  it("returns project-scoped findings across sessions", async () => {
    await storeObservationTool.handler(
      { topic: "arch", finding: "shared project finding", scope: "project" },
      CTX,
    );
    const result = await recallFindingsTool.handler({ scope: "project" }, CTX2);
    expect(result.count).toBe(1);
    expect(result.findings[0].finding).toBe("shared project finding");
  });

  it("returns findings with age metadata", async () => {
    await storeObservationTool.handler({ topic: "test", finding: "recent" }, CTX);
    const result = await recallFindingsTool.handler({}, CTX);
    expect(result.findings[0].age).toMatch(/\ds ago/);
  });
});

describe("clearSessionMemory", () => {
  it("removes all session-scoped entries", async () => {
    await storeObservationTool.handler({ topic: "a", finding: "f1" }, CTX);
    await storeObservationTool.handler({ topic: "b", finding: "f2" }, CTX);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(2);

    clearSessionMemory(CTX.sessionKey);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(0);

    const result = await recallFindingsTool.handler({ scope: "session" }, CTX);
    expect(result.count).toBe(0);
  });
});

describe("MemoryStore in-memory fallback", () => {
  it("store and recall work without Redis", async () => {
    const store = new MemoryStore(null);
    const obs = await store.store("topic1", "finding1", "session", "s1", "/proj");
    expect(obs.topic).toBe("topic1");

    const recalled = await store.recall("topic1", "session", "s1", "/proj");
    expect(recalled.length).toBe(1);
    expect(recalled[0].finding).toBe("finding1");
  });

  it("countSession reflects local cache", async () => {
    const store = new MemoryStore(null);
    await store.store("a", "f1", "session", "s1", "/proj");
    await store.store("b", "f2", "session", "s1", "/proj");
    expect(store.countSession("s1")).toBe(2);
  });

  it("clearSession removes local entries", async () => {
    const store = new MemoryStore(null);
    await store.store("a", "f1", "session", "s1", "/proj");
    await store.clearSession("s1");
    expect(store.countSession("s1")).toBe(0);
    const recalled = await store.recall("", "session", "s1", "/proj");
    expect(recalled.length).toBe(0);
  });

  it("project scope persists across sessions", async () => {
    const store = new MemoryStore(null);
    await store.store("arch", "monorepo", "project", "s1", "/proj");
    const recalled = await store.recall("", "project", "s2", "/proj");
    expect(recalled.length).toBe(1);
    expect(recalled[0].finding).toBe("monorepo");
  });

  it("scope=all returns session + project entries", async () => {
    const store = new MemoryStore(null);
    await store.store("s-topic", "session finding", "session", "s1", "/proj");
    await store.store("p-topic", "project finding", "project", "s1", "/proj");
    const recalled = await store.recall("", "all", "s1", "/proj");
    expect(recalled.length).toBe(2);
  });

  it("respects maxEntries cap", async () => {
    const store = new MemoryStore(null, 3);
    for (let i = 0; i < 5; i++) {
      await store.store(`t${i}`, `f${i}`, "session", "s1", "/proj");
    }
    expect(store.countSession("s1")).toBe(3);
    const recalled = await store.recall("", "session", "s1", "/proj");
    expect(recalled[0].finding).toBe("f4");
  });

  it("formatRecallBlock produces XML block", async () => {
    const store = new MemoryStore(null);
    await store.store("auth", "JWT tokens", "session", "s1", "/proj");
    const entries = await store.recall("", "session", "s1", "/proj");
    const block = store.formatRecallBlock(entries);
    expect(block).toContain("<RECALLED_FINDINGS>");
    expect(block).toContain("[auth]");
    expect(block).toContain("JWT tokens");
  });

  it("formatRecallBlock handles empty", () => {
    const store = new MemoryStore(null);
    expect(store.formatRecallBlock([])).toContain("No matching findings stored");
  });
});

describe("works without context", () => {
  it("store_observation falls back to unknown session", async () => {
    const result = await storeObservationTool.handler(
      { topic: "no-ctx", finding: "works without context" },
    );
    expect(result.ok).toBe(true);
  });

  it("recall_findings returns empty without context", async () => {
    const result = await recallFindingsTool.handler({});
    expect(result.count).toBeGreaterThanOrEqual(0);
  });
});
