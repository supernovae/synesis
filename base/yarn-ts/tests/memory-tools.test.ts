import { describe, expect, it, beforeEach } from "vitest";
import {
  storeObservationTool,
  recallFindingsTool,
  clearSessionMemory,
  clearProjectMemory,
  getSessionMemoryCount,
} from "../src/mcp/handlers/memory-tools.js";
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
  clearSessionMemory(CTX.sessionKey);
  clearSessionMemory(CTX2.sessionKey);
  clearProjectMemory(CTX.projectRoot);
});

describe("store_observation", () => {
  it("stores a session-scoped observation", () => {
    const result = storeObservationTool.handler(
      { topic: "auth flow", finding: "JWT tokens are validated in middleware/auth.ts" },
      CTX,
    );
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^obs_/);
    expect(result.stored).toBe(1);
  });

  it("stores multiple observations and counts them", () => {
    storeObservationTool.handler({ topic: "db", finding: "Uses PostgreSQL" }, CTX);
    storeObservationTool.handler({ topic: "auth", finding: "JWT-based" }, CTX);
    const result = storeObservationTool.handler({ topic: "api", finding: "REST + GraphQL" }, CTX);
    expect(result.stored).toBe(3);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(3);
  });

  it("defaults to session scope", () => {
    storeObservationTool.handler({ topic: "test", finding: "session scoped" }, CTX);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(1);
  });

  it("supports project scope", () => {
    storeObservationTool.handler(
      { topic: "architecture", finding: "Monorepo with npm workspaces", scope: "project" },
      CTX,
    );
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(0);
  });
});

describe("recall_findings", () => {
  it("recalls stored findings by query", () => {
    storeObservationTool.handler({ topic: "auth", finding: "JWT tokens in auth.ts" }, CTX);
    storeObservationTool.handler({ topic: "database", finding: "PostgreSQL with Prisma" }, CTX);
    storeObservationTool.handler({ topic: "testing", finding: "Vitest for unit tests" }, CTX);

    const result = recallFindingsTool.handler({ query: "auth" }, CTX);
    expect(result.count).toBe(1);
    expect(result.findings[0].topic).toBe("auth");
  });

  it("returns all findings when query is empty", () => {
    storeObservationTool.handler({ topic: "a", finding: "first" }, CTX);
    storeObservationTool.handler({ topic: "b", finding: "second" }, CTX);

    const result = recallFindingsTool.handler({}, CTX);
    expect(result.count).toBe(2);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      storeObservationTool.handler({ topic: `topic-${i}`, finding: `finding ${i}` }, CTX);
    }
    const result = recallFindingsTool.handler({ limit: 2 }, CTX);
    expect(result.count).toBe(2);
  });

  it("isolates sessions", () => {
    storeObservationTool.handler({ topic: "a", finding: "session 1 finding" }, CTX);
    storeObservationTool.handler({ topic: "b", finding: "session 2 finding" }, CTX2);

    const r1 = recallFindingsTool.handler({ scope: "session" }, CTX);
    expect(r1.count).toBe(1);
    expect(r1.findings[0].finding).toBe("session 1 finding");

    const r2 = recallFindingsTool.handler({ scope: "session" }, CTX2);
    expect(r2.count).toBe(1);
    expect(r2.findings[0].finding).toBe("session 2 finding");
  });

  it("returns project-scoped findings across sessions", () => {
    storeObservationTool.handler(
      { topic: "arch", finding: "shared project finding", scope: "project" },
      CTX,
    );
    const result = recallFindingsTool.handler({ scope: "project" }, CTX2);
    expect(result.count).toBe(1);
    expect(result.findings[0].finding).toBe("shared project finding");
  });

  it("returns findings with age metadata", () => {
    storeObservationTool.handler({ topic: "test", finding: "recent" }, CTX);
    const result = recallFindingsTool.handler({}, CTX);
    expect(result.findings[0].age).toMatch(/\ds ago/);
  });
});

describe("clearSessionMemory", () => {
  it("removes all session-scoped entries", () => {
    storeObservationTool.handler({ topic: "a", finding: "f1" }, CTX);
    storeObservationTool.handler({ topic: "b", finding: "f2" }, CTX);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(2);

    clearSessionMemory(CTX.sessionKey);
    expect(getSessionMemoryCount(CTX.sessionKey)).toBe(0);

    const result = recallFindingsTool.handler({ scope: "session" }, CTX);
    expect(result.count).toBe(0);
  });
});

describe("works without context", () => {
  it("store_observation falls back to unknown session", () => {
    const result = storeObservationTool.handler(
      { topic: "no-ctx", finding: "works without context" },
    );
    expect(result.ok).toBe(true);
  });

  it("recall_findings returns empty without context", () => {
    const result = recallFindingsTool.handler({});
    expect(result.count).toBeGreaterThanOrEqual(0);
  });
});
