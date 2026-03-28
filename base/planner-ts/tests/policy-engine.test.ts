import { describe, expect, it } from "vitest";
import { createAuthorizationPolicyEngine } from "../src/auth/policy-engine.js";
import { loadConfig } from "../src/config.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    ...overrides
  });
}

describe("authorization policy engine (OpenFGA)", () => {
  it("engine name is openfga", () => {
    const engine = createAuthorizationPolicyEngine(makeConfig());
    expect(engine.engineName).toBe("openfga");
  });

  it("denies when model scope missing", async () => {
    const engine = createAuthorizationPolicyEngine(makeConfig());
    const decision = await engine.authorize("chat.completions", "invoke", {
      userId: "u1",
      userEmail: "u1@test.com",
      orgId: "",
      tenantIds: [],
      role: "user",
      tokenScopes: ["coder:readonly"],
      authMethod: "bearer",
      trustedForwardedIdentity: false
    });
    expect(decision.allow).toBe(false);
    expect(decision.rejectReason).toContain("scope");
    expect(decision.matchedRules).toContain("deny_missing_model_scope");
  });

  it("denies when FGA not configured (no store)", async () => {
    const engine = createAuthorizationPolicyEngine(makeConfig());
    const decision = await engine.authorize("chat.completions", "invoke", {
      userId: "u1",
      userEmail: "u1@test.com",
      orgId: "",
      tenantIds: [],
      role: "user",
      tokenScopes: ["model:readonly"],
      authMethod: "bearer",
      trustedForwardedIdentity: false
    });
    expect(decision.allow).toBe(false);
    expect(decision.matchedRules).toContain("deny_openfga_planner_invoke");
  });

  it("tracks stats across evaluations", async () => {
    const engine = createAuthorizationPolicyEngine(makeConfig());
    await engine.authorize("chat.completions", "invoke", {
      userId: "u1",
      userEmail: "",
      orgId: "",
      tenantIds: [],
      role: "user",
      tokenScopes: ["coder:readonly"],
      authMethod: "bearer",
      trustedForwardedIdentity: false
    });
    const stats = engine.getStats();
    expect(stats.evaluations).toBeGreaterThanOrEqual(1);
    expect(stats.rejectedCount).toBeGreaterThanOrEqual(1);
    expect(stats.recentEvents.length).toBeGreaterThanOrEqual(1);
  });
});
