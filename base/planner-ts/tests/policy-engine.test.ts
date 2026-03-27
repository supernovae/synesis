import { describe, expect, it } from "vitest";
import { createAuthorizationPolicyEngine } from "../src/auth/policy-engine.js";
import { loadConfig } from "../src/config.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    ...overrides
  });
}

describe("authorization policy engine", () => {
  it("allows chat invoke when model scope exists", () => {
    const engine = createAuthorizationPolicyEngine(makeConfig());
    const decision = engine.authorize("chat.completions", "invoke", {
      userId: "u1",
      userEmail: "u1@test.com",
      orgId: "",
      tenantIds: [],
      role: "user",
      tokenScopes: ["model:readonly"],
      authMethod: "bearer",
      trustedForwardedIdentity: false
    });
    expect(decision.allow).toBe(true);
    expect(decision.matchedRules).toContain("allow_model_scope");
    expect(engine.getStats().recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(engine.getStats().recentEvents[0]?.allow).toBe(true);
  });

  it("denies chat invoke when model scope is missing", () => {
    const engine = createAuthorizationPolicyEngine(makeConfig());
    const decision = engine.authorize("chat.completions", "invoke", {
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
    expect(decision.rejectReason).toContain("required scope");
    const stats = engine.getStats();
    expect(stats.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(stats.recentEvents[stats.recentEvents.length - 1]?.allow).toBe(false);
  });

  it("uses openfga stub engine when selected", () => {
    const engine = createAuthorizationPolicyEngine(
      makeConfig({
        SYNESIS_PLANNER_TS_AUTHZ_ENGINE: "openfga_stub"
      })
    );
    expect(engine.engineName).toBe("openfga_stub");
    const decision = engine.authorize("chat.completions", "invoke", {
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
    expect(decision.rejectReason).toContain("not configured yet");
  });
});
