import { afterEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const closeMock = vi.fn();
const sessionMock = vi.fn(() => ({ run: runMock, close: closeMock }));
const driverMock = vi.fn(() => ({ session: sessionMock, close: vi.fn() }));

vi.mock("neo4j-driver", () => ({
  default: {
    driver: driverMock,
    auth: { basic: vi.fn((user: string, password: string) => ({ user, password })) },
    isInt: vi.fn(() => false),
  },
}));

const { retrieveContext } = await import("../src/retrieval/rag-client.js");
const { setFgaCheckOverride } = await import("../src/auth/openfga-client.js");
import type { RagClientConfig } from "../src/retrieval/rag-client.js";
import type { ScopeFilterOptions } from "../src/retrieval/types.js";

const baseConfig: RagClientConfig = {
  nornicUri: "bolt://nornic.local:7687",
  nornicUser: "neo4j",
  nornicPassword: "secret",
  nornicDatabase: "nornic",
  nornicVectorIndex: "embeddings",
  nornicRuntimeProfile: "cpu-bge",
  embedderUrl: "",
  embedderModel: "BAAI/bge-m3",
  retrievalStrategy: "hybrid",
  rrfK: 60,
  scoreThreshold: 0,
  rerankScoreMin: 0,
  graphDepth: 1,
  edgeTypes: ["DEFINES"],
  rerankEnabled: false,
  timeoutMs: 1000,
};

function makeRecord(props: Record<string, unknown>, score = 0.9) {
  return {
    get(key: string) {
      if (key === "node") return { properties: { id: props.id ?? "chunk-1", doc_id: props.doc_id ?? "doc-1", text: "content", source_url: "https://test", document_name: "test", authority: "vetted", ...props } };
      if (key === "score") return score;
      if (key === "neighbors") return [];
      if (key === "edge_list") return [];
      return undefined;
    },
  };
}

afterEach(() => {
  runMock.mockReset();
  closeMock.mockReset();
  sessionMock.mockClear();
  setFgaCheckOverride(null);
});

// ---------------------------------------------------------------------------
// Cross-org isolation
// ---------------------------------------------------------------------------
describe("Cross-org isolation", () => {
  it("org-B content is invisible to org-A caller", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test query", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "org-A", callerUserId: "user-1" },
    });

    const [cypher, params] = runMock.mock.calls[0];
    expect(params.caller_org_id).toBe("org-A");
    expect(cypher).toContain('node.visibility_scope = "org" AND node.org_id = $caller_org_id');
    expect(cypher).not.toContain("org-B");
  });

  it("org-scoped content is invisible to anonymous (no org) caller", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test query", baseConfig, {
      topK: 5,
      scopeFilter: {},
    });

    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain('visibility_scope = "org"');
    expect(cypher).not.toContain('visibility_scope = "tenant"');
    expect(cypher).not.toContain('visibility_scope = "user"');
    expect(cypher).not.toContain('visibility_scope = "session"');
    expect(cypher).toContain('coalesce(node.visibility_scope, "global") = "global"');
  });

  it("org-A caller can see global content", async () => {
    runMock.mockResolvedValue({
      records: [makeRecord({ visibility_scope: "global", acl_mode: "open" })],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "org-A" },
    });
    expect(results).toHaveLength(1);
  });

  it("Cypher binds org_id parameter only for the caller's own org", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme-corp" },
    });
    const [, params] = runMock.mock.calls[0];
    expect(params.caller_org_id).toBe("acme-corp");
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant isolation
// ---------------------------------------------------------------------------
describe("Cross-tenant isolation", () => {
  it("tenant-2 content is invisible to caller with only tenant-1", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerTenantIds: ["tenant-1"] },
    });
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain("node.tenant_id IN $caller_tenant_ids");
    expect(params.caller_tenant_ids).toEqual(["tenant-1"]);
  });

  it("tenant content is invisible to org-level caller without callerTenantIds", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain('visibility_scope = "tenant"');
  });

  it("tenant clause requires org_id match (cross-org tenant isolation)", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "org-B", callerTenantIds: ["tenant-1"] },
    });
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain('node.visibility_scope = "tenant" AND node.org_id = $caller_org_id AND node.tenant_id IN $caller_tenant_ids');
    expect(params.caller_org_id).toBe("org-B");
  });
});

// ---------------------------------------------------------------------------
// User-scoped isolation
// ---------------------------------------------------------------------------
describe("User-scoped isolation", () => {
  it("user-B user-scoped content is invisible to user-A in the same org", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "user-A" },
    });
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain('node.visibility_scope = "user" AND node.org_id = $caller_org_id AND node.owner_user_id = $caller_user_id');
    expect(params.caller_user_id).toBe("user-A");
  });

  it("user-scoped content is invisible to org-level caller without callerUserId", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain('visibility_scope = "user"');
  });

  it("user scope requires org_id match", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "org-X", callerUserId: "alice" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('node.visibility_scope = "user" AND node.org_id = $caller_org_id AND node.owner_user_id = $caller_user_id');
  });
});

// ---------------------------------------------------------------------------
// Session-scoped isolation
// ---------------------------------------------------------------------------
describe("Session-scoped isolation", () => {
  it("session clause includes conversation_id binding", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", callerConversationId: "conv-1" },
    });
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain('node.visibility_scope = "session"');
    expect(cypher).toContain("node.conversation_id = $caller_conversation_id");
    expect(params.caller_conversation_id).toBe("conv-1");
  });

  it("session clause includes TTL expiry check", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", callerConversationId: "conv-1" },
    });
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain("coalesce(node.expires_at_epoch, 0) <= 0 OR node.expires_at_epoch >= $now_epoch");
    expect(typeof params.now_epoch).toBe("number");
    expect(params.now_epoch).toBeGreaterThan(0);
  });

  it("session content invisible without callerConversationId", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain('visibility_scope = "session"');
  });

  it("session content invisible without callerUserId even with callerConversationId", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerConversationId: "conv-1" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain('visibility_scope = "session"');
    expect(cypher).not.toContain('visibility_scope = "user"');
  });

  it("session clause requires org_id match", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", callerConversationId: "conv-1" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('node.visibility_scope = "session" AND node.org_id = $caller_org_id AND node.owner_user_id = $caller_user_id AND node.conversation_id = $caller_conversation_id');
  });
});

// ---------------------------------------------------------------------------
// ACL deny-by-default
// ---------------------------------------------------------------------------
describe("ACL deny-by-default", () => {
  it("restricted/private content invisible without callerAclGroups (default ACL clause)", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.acl_mode, "open") IN ["open", ""]');
    expect(cypher).not.toContain('"restricted"');
    expect(cypher).not.toContain('"private"');
  });

  it("restricted content visible with matching callerAclGroups", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerAclGroups: ["team-alpha"] },
    });
    const [cypher, params] = runMock.mock.calls[0];
    expect(cypher).toContain("group IN $caller_acl_groups");
    expect(cypher).toContain("group IN coalesce(node.acl_group_ids, [])");
    expect(params.caller_acl_groups).toEqual(["team-alpha"]);
  });

  it("ACL matching checks both acl_group_ids (array) and acl_groups (CSV) fields", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerAclGroups: ["engineering"] },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain("coalesce(node.acl_group_ids, [])");
    expect(cypher).toContain('split(coalesce(node.acl_groups, ""), ",")');
  });

  it("enforce mode widens ACL to pass restricted/private to FGA", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", authzMode: "enforce" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.acl_mode, "open") IN ["open", "", "restricted", "private"]');
  });

  it("enforce mode without callerUserId does NOT widen ACL", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", authzMode: "enforce" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.acl_mode, "open") IN ["open", ""]');
    expect(cypher).not.toContain('"restricted"');
  });
});

// ---------------------------------------------------------------------------
// Anonymous / solo user (fail-closed)
// ---------------------------------------------------------------------------
describe("Anonymous / solo user (fail-closed)", () => {
  it("empty scopeFilter sees only global + open ACL", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, { topK: 5, scopeFilter: {} });
    const [cypher] = runMock.mock.calls[0];
    const scopeClause = cypher.match(/\(\(coalesce\(node\.visibility_scope.*?\)\)/s)?.[0] ?? cypher;
    expect(scopeClause).toContain('coalesce(node.visibility_scope, "global") = "global"');
    expect(scopeClause).not.toContain('visibility_scope = "org"');
    expect(scopeClause).not.toContain('visibility_scope = "tenant"');
    expect(scopeClause).not.toContain('visibility_scope = "user"');
    expect(scopeClause).not.toContain('visibility_scope = "session"');
    expect(cypher).toContain('coalesce(node.acl_mode, "open") IN ["open", ""]');
  });

  it("undefined scopeFilter sees only global + open ACL", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, { topK: 5 });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.visibility_scope, "global") = "global"');
    expect(cypher).toContain('coalesce(node.acl_mode, "open") IN ["open", ""]');
  });

  it("solo user (userId but no orgId) sees only global + open ACL", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerUserId: "alice" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain('visibility_scope = "org"');
    expect(cypher).not.toContain('visibility_scope = "user"');
    expect(cypher).toContain('coalesce(node.visibility_scope, "global") = "global"');
  });

  it("no scope params are bound when scopeFilter is empty", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, { topK: 5, scopeFilter: {} });
    const [, params] = runMock.mock.calls[0];
    expect(params.caller_org_id).toBeUndefined();
    expect(params.caller_tenant_ids).toBeUndefined();
    expect(params.caller_acl_groups).toBeUndefined();
    expect(params.caller_user_id).toBeUndefined();
    expect(params.caller_conversation_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FGA enforce-mode row filtering
// ---------------------------------------------------------------------------
describe("FGA enforce-mode row filtering", () => {
  it("FGA deny removes results even if Cypher tier allows them", async () => {
    setFgaCheckOverride(() => ({ allowed: false, resolution: "deny-all" }));
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c1", doc_id: "doc-1", visibility_scope: "org", org_id: "acme", acl_mode: "private", authz_object_id: "rag_doc:doc-1" }),
        makeRecord({ id: "c2", doc_id: "doc-2", visibility_scope: "org", org_id: "acme", acl_mode: "private", authz_object_id: "rag_doc:doc-2" }, 0.8),
      ],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", authzMode: "enforce", authzTraceId: "t1", trustedScopeSource: "auth_context" },
    });
    expect(results).toHaveLength(0);
  });

  it("FGA allow passes matching results through", async () => {
    setFgaCheckOverride((_user, _rel, _type, objectId) => ({
      allowed: objectId === "doc-allowed",
    }));
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c1", doc_id: "doc-allowed", visibility_scope: "org", org_id: "acme", acl_mode: "restricted", authz_object_id: "rag_doc:doc-allowed" }),
        makeRecord({ id: "c2", doc_id: "doc-denied", visibility_scope: "org", org_id: "acme", acl_mode: "restricted", authz_object_id: "rag_doc:doc-denied" }, 0.8),
      ],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", authzMode: "enforce", authzTraceId: "t2", trustedScopeSource: "auth_context" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.doc_id).toBe("doc-allowed");
  });

  it("global open content is never FGA-filtered (needsFgaCheck returns false)", async () => {
    setFgaCheckOverride(() => ({ allowed: false, resolution: "deny-all" }));
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c-global", doc_id: "doc-global", visibility_scope: "global", acl_mode: "open", authz_object_id: "" }),
      ],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", authzMode: "enforce", authzTraceId: "t3", trustedScopeSource: "auth_context" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.doc_id).toBe("doc-global");
  });

  it("audit mode skips FGA filtering entirely", async () => {
    const fgaCalls: string[] = [];
    setFgaCheckOverride((_user, _rel, _type, objectId) => {
      fgaCalls.push(objectId);
      return { allowed: false };
    });
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c1", doc_id: "doc-1", visibility_scope: "org", org_id: "acme", acl_mode: "restricted", authz_object_id: "rag_doc:doc-1" }),
      ],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", authzMode: "audit", authzTraceId: "t4", callerAclGroups: ["team"], trustedScopeSource: "auth_context" },
    });
    expect(fgaCalls).toHaveLength(0);
    expect(results).toHaveLength(1);
  });

  it("enforce mode without callerUserId drops non-global non-open rows (no FGA check)", async () => {
    const fgaCalls: string[] = [];
    setFgaCheckOverride((_user, _rel, _type, objectId) => {
      fgaCalls.push(objectId);
      return { allowed: true };
    });
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c-global", doc_id: "doc-global", visibility_scope: "global", acl_mode: "open" }),
        makeRecord({ id: "c-org", doc_id: "doc-org", visibility_scope: "org", org_id: "acme", acl_mode: "restricted", authz_object_id: "rag_doc:doc-org" }, 0.8),
      ],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", authzMode: "enforce", authzTraceId: "t5", trustedScopeSource: "auth_context" },
    });
    expect(fgaCalls).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(results[0]?.doc_id).toBe("doc-global");
  });

  it("rows without parseable authz_object_id are dropped in enforce mode", async () => {
    setFgaCheckOverride(() => ({ allowed: true }));
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c1", doc_id: "doc-1", visibility_scope: "org", org_id: "acme", acl_mode: "private", authz_object_id: "malformed" }),
      ],
    });
    const results = await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice", authzMode: "enforce", authzTraceId: "t6", trustedScopeSource: "auth_context" },
    });
    expect(results).toHaveLength(0);
  });

  it("FGA receives correct user, relation, objectType, objectId", async () => {
    const fgaCalls: Array<{ user: string; relation: string; objectType: string; objectId: string }> = [];
    setFgaCheckOverride((user, relation, objectType, objectId) => {
      fgaCalls.push({ user, relation, objectType, objectId });
      return { allowed: true };
    });
    runMock.mockResolvedValue({
      records: [
        makeRecord({ id: "c1", doc_id: "doc-42", visibility_scope: "org", org_id: "acme", acl_mode: "private", authz_object_id: "rag_doc:doc-42" }),
      ],
    });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerUserId: "alice@acme.com", authzMode: "enforce", authzTraceId: "t7", trustedScopeSource: "auth_context" },
    });
    expect(fgaCalls).toHaveLength(1);
    expect(fgaCalls[0]).toEqual({
      user: "user:alice@acme.com",
      relation: "can_read",
      objectType: "rag_doc",
      objectId: "doc-42",
    });
  });
});

// ---------------------------------------------------------------------------
// Neighbor node scope enforcement
// ---------------------------------------------------------------------------
describe("Neighbor node scope enforcement", () => {
  it("neighbor WHERE clause uses same scope predicate as seed node", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerTenantIds: ["t1"], callerUserId: "alice" },
      graphDepth: 2,
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain("OPTIONAL MATCH path=(node)-[rels");
    expect(cypher).toContain("WHERE ((coalesce(neighbor.visibility_scope");
    expect(cypher).toContain('neighbor.visibility_scope = "org" AND neighbor.org_id = $caller_org_id');
    expect(cypher).toContain('neighbor.visibility_scope = "tenant" AND neighbor.org_id = $caller_org_id AND neighbor.tenant_id IN $caller_tenant_ids');
  });

  it("neighbor in a different org is excluded by the neighbor clause", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "org-A" },
      graphDepth: 1,
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain("neighbor.org_id = $caller_org_id");
  });

  it("neighbor ACL enforcement matches seed ACL enforcement", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerAclGroups: ["eng"] },
      graphDepth: 2,
    });
    const [cypher] = runMock.mock.calls[0];
    const neighborClause = cypher.split("WHERE ((coalesce(neighbor")[1] ?? "";
    expect(neighborClause).toContain("coalesce(neighbor.acl_group_ids, [])");
    expect(neighborClause).toContain("coalesce(neighbor.acl_groups");
  });

  it("graphDepth=0 skips neighbor expansion entirely", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme" },
      graphDepth: 0,
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).not.toContain("OPTIONAL MATCH path=");
    expect(cypher).toContain("[] AS neighbors");
  });
});

// ---------------------------------------------------------------------------
// Scope parameter truncation / safety
// ---------------------------------------------------------------------------
describe("Scope parameter safety", () => {
  it("callerTenantIds are truncated to 50 items", async () => {
    runMock.mockResolvedValue({ records: [] });
    const manyTenants = Array.from({ length: 100 }, (_, i) => `tenant-${i}`);
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerTenantIds: manyTenants },
    });
    const [, params] = runMock.mock.calls[0];
    expect(params.caller_tenant_ids).toHaveLength(50);
  });

  it("callerAclGroups are truncated to 100 items", async () => {
    runMock.mockResolvedValue({ records: [] });
    const manyGroups = Array.from({ length: 150 }, (_, i) => `group-${i}`);
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme", callerAclGroups: manyGroups },
    });
    const [, params] = runMock.mock.calls[0];
    expect(params.caller_acl_groups).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Hierarchical tier unlocking
// ---------------------------------------------------------------------------
describe("Hierarchical tier unlocking", () => {
  it("full context unlocks all five tiers (global, org, tenant, user, session)", async () => {
    runMock.mockResolvedValue({ records: [] });
    const scope: ScopeFilterOptions = {
      callerOrgId: "acme",
      callerTenantIds: ["t1"],
      callerUserId: "alice",
      callerConversationId: "conv-1",
    };
    await retrieveContext("test", baseConfig, { topK: 5, scopeFilter: scope });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.visibility_scope, "global") = "global"');
    expect(cypher).toContain('node.visibility_scope = "org"');
    expect(cypher).toContain('node.visibility_scope = "tenant"');
    expect(cypher).toContain('node.visibility_scope = "user"');
    expect(cypher).toContain('node.visibility_scope = "session"');
  });

  it("org-only context unlocks only global and org tiers", async () => {
    runMock.mockResolvedValue({ records: [] });
    await retrieveContext("test", baseConfig, {
      topK: 5,
      scopeFilter: { callerOrgId: "acme" },
    });
    const [cypher] = runMock.mock.calls[0];
    expect(cypher).toContain('coalesce(node.visibility_scope, "global") = "global"');
    expect(cypher).toContain('node.visibility_scope = "org"');
    expect(cypher).not.toContain('node.visibility_scope = "tenant"');
    expect(cypher).not.toContain('node.visibility_scope = "user"');
    expect(cypher).not.toContain('node.visibility_scope = "session"');
  });
});
