import { describe, expect, it } from "vitest";
import { McpConcurrencyLimiter } from "../src/mcp/concurrency-limiter.js";

describe("McpConcurrencyLimiter", () => {
  it("limits concurrent tool calls per caller and releases slots", () => {
    const limiter = new McpConcurrencyLimiter({ maxPerCaller: 1, maxGlobal: 10 });

    const first = limiter.tryAcquire({ orgId: "org-1", userId: "alice" });
    expect(first.allowed).toBe(true);

    const second = limiter.tryAcquire({ orgId: "org-1", userId: "alice" });
    expect(second).toMatchObject({
      allowed: false,
      reason: "caller_concurrency_exceeded",
      callerActive: 1,
      callerLimit: 1,
    });

    if (first.allowed) first.release();

    const third = limiter.tryAcquire({ orgId: "org-1", userId: "alice" });
    expect(third.allowed).toBe(true);
    if (third.allowed) third.release();
    expect(limiter.getActiveCounts({ orgId: "org-1", userId: "alice" })).toEqual({
      callerActive: 0,
      globalActive: 0,
    });
  });

  it("isolates per-caller limits by organization and user", () => {
    const limiter = new McpConcurrencyLimiter({ maxPerCaller: 1, maxGlobal: 10 });

    const aliceOrgOne = limiter.tryAcquire({ orgId: "org-1", userId: "alice" });
    const aliceOrgTwo = limiter.tryAcquire({ orgId: "org-2", userId: "alice" });
    const bobOrgOne = limiter.tryAcquire({ orgId: "org-1", userId: "bob" });

    expect(aliceOrgOne.allowed).toBe(true);
    expect(aliceOrgTwo.allowed).toBe(true);
    expect(bobOrgOne.allowed).toBe(true);

    if (aliceOrgOne.allowed) aliceOrgOne.release();
    if (aliceOrgTwo.allowed) aliceOrgTwo.release();
    if (bobOrgOne.allowed) bobOrgOne.release();
  });

  it("applies a global concurrent tool cap", () => {
    const limiter = new McpConcurrencyLimiter({ maxPerCaller: 10, maxGlobal: 2 });

    const first = limiter.tryAcquire({ orgId: "org-1", userId: "alice" });
    const second = limiter.tryAcquire({ orgId: "org-1", userId: "bob" });
    const third = limiter.tryAcquire({ orgId: "org-2", userId: "carol" });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third).toMatchObject({
      allowed: false,
      reason: "global_concurrency_exceeded",
      globalActive: 2,
      globalLimit: 2,
    });

    if (first.allowed) first.release();
    if (second.allowed) second.release();
  });
});
