import { describe, expect, it } from "vitest";
import { SessionContinuityService } from "../src/context/session-continuity.js";

describe("SessionContinuityService", () => {
  it("extracts task from last user message", () => {
    const svc = new SessionContinuityService();
    const result = svc.extract([
      { role: "user", content: "Please fix the authentication bug in auth.ts" },
      { role: "assistant", content: "I'll look at auth.ts now." }
    ]);
    expect(result.currentTask).toContain("fix the authentication bug");
  });

  it("extracts findings from assistant messages", () => {
    const svc = new SessionContinuityService();
    const result = svc.extract([
      { role: "user", content: "What's wrong?" },
      { role: "assistant", content: "I found that the token validation was missing a check for expiry." },
      { role: "assistant", content: "Also discovered that the Redis connection string was incorrect." }
    ]);
    expect(result.keyFindings.length).toBe(2);
    expect(result.keyFindings[0]).toContain("token validation");
    expect(result.keyFindings[1]).toContain("Redis connection");
  });

  it("extracts decisions from assistant messages", () => {
    const svc = new SessionContinuityService();
    const result = svc.extract([
      { role: "user", content: "How should we proceed?" },
      { role: "assistant", content: "I decided to use a middleware approach for auth. Switched to ioredis for the connection pool." }
    ]);
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts file paths from conversation", () => {
    const svc = new SessionContinuityService();
    const result = svc.extract([
      { role: "user", content: "Edit src/auth.ts and src/config.ts" },
      { role: "assistant", content: "Updated src/auth.ts with the fix. Also modified tests/auth.test.ts" }
    ]);
    expect(result.recentFiles).toContain("src/auth.ts");
    expect(result.recentFiles).toContain("src/config.ts");
    expect(result.recentFiles).toContain("tests/auth.test.ts");
  });

  it("builds system block from continuity data", () => {
    const svc = new SessionContinuityService();
    const block = svc.toSystemBlock({
      currentTask: "Fix auth bug",
      keyFindings: ["Token expiry check missing"],
      decisions: ["Use middleware pattern"],
      recentFiles: ["src/auth.ts"],
      updatedAt: Date.now()
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("<SESSION_CONTINUITY>");
    expect(block!).toContain("</SESSION_CONTINUITY>");
    expect(block!).toContain("Fix auth bug");
    expect(block!).toContain("Token expiry check missing");
    expect(block!).toContain("Use middleware pattern");
    expect(block!).toContain("src/auth.ts");
  });

  it("returns null block when continuity is empty", () => {
    const svc = new SessionContinuityService();
    const block = svc.toSystemBlock({
      currentTask: "",
      keyFindings: [],
      decisions: [],
      recentFiles: [],
      updatedAt: Date.now()
    });
    expect(block).toBeNull();
  });

  it("tracks stats", () => {
    const svc = new SessionContinuityService();
    svc.extract([
      { role: "user", content: "fix it" },
      { role: "assistant", content: "I found the bug in main.ts. It was a null pointer." }
    ]);
    svc.toSystemBlock({
      currentTask: "fix",
      keyFindings: ["null pointer"],
      decisions: [],
      recentFiles: ["main.ts"],
      updatedAt: Date.now()
    });
    const stats = svc.getStats();
    expect(stats.extractionCount).toBe(1);
    expect(stats.injectionCount).toBe(1);
  });
});
