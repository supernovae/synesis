import { describe, it, expect } from "vitest";
import { buildScopeFilter } from "../src/retrieval/scope-filter.js";

describe("buildScopeFilter — Python parity", () => {
  it("returns empty string when undefined, global filter when empty opts", () => {
    expect(buildScopeFilter()).toBe("");
    expect(buildScopeFilter({})).toContain('visibility_scope == "global"');
  });

  it("solo user (no org) gets global + open ACL only", () => {
    const filter = buildScopeFilter({ callerUserId: "alice" });
    expect(filter).toContain('visibility_scope == "global"');
    expect(filter).toContain('acl_mode in ["open", ""]');
    expect(filter).not.toContain("org_id");
  });

  it("org user gets global + org clauses", () => {
    const filter = buildScopeFilter({ callerOrgId: "acme" });
    expect(filter).toContain('visibility_scope == "global"');
    expect(filter).toContain('visibility_scope == "org" and org_id == "acme"');
    expect(filter).toContain('acl_mode in ["open", ""]');
  });

  it("org + tenant gets all three tiers with org binding on tenant", () => {
    const filter = buildScopeFilter({ callerOrgId: "acme", callerTenantIds: ["t1", "t2"] });
    expect(filter).toContain('visibility_scope == "tenant" and org_id == "acme" and tenant_id in ["t1","t2"]');
  });

  it("org + user_id adds user-scoped tier", () => {
    const filter = buildScopeFilter({ callerOrgId: "acme", callerUserId: "alice" });
    expect(filter).toContain('visibility_scope == "user" and org_id == "acme" and owner_user_id == "alice"');
  });

  it("org + user_id + conversation_id adds session tier with TTL", () => {
    const filter = buildScopeFilter({
      callerOrgId: "acme",
      callerUserId: "alice",
      callerConversationId: "conv-123",
    });
    expect(filter).toContain('visibility_scope == "session"');
    expect(filter).toContain('conversation_id == "conv-123"');
    expect(filter).toContain("expires_at_epoch");
  });

  it("ACL groups produce group-matching expression", () => {
    const filter = buildScopeFilter({
      callerOrgId: "acme",
      callerAclGroups: ["engineering", "research"],
    });
    expect(filter).toContain('acl_groups like "%engineering%"');
    expect(filter).toContain('acl_groups like "%research%"');
    expect(filter).toContain('acl_mode in ["open", ""]');
  });

  it("escapes quotes in values", () => {
    const filter = buildScopeFilter({ callerOrgId: 'bad"org' });
    expect(filter).not.toContain('"bad"org"');
    expect(filter).toContain('bad\\"org');
  });

  it("tenant clause without org is not generated", () => {
    const filter = buildScopeFilter({ callerTenantIds: ["t1"] });
    expect(filter).not.toContain("tenant_id");
  });
});
