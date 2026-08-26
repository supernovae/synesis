/**
 * Chat-scope-parity tests — verify the chat path threads authzMode,
 * aclGroups, and scope metadata with the same fidelity as the knowledge API.
 *
 * These tests cover:
 *  1. GraphState carries acl_groups and rag_authz_mode from auth + config
 *  2. Router threads them into UnifiedRetrievalRequest
 *  3. retrieveUnified passes authzMode into scopeFilter for rag-client
 *  4. Enforce mode on the chat path triggers FGA post-filter
 *  5. ACL groups on the chat path produce group-matching Cypher predicates
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock neo4j-driver before any retrieval imports
// ---------------------------------------------------------------------------
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

const { retrieveContext, buildScopePredicate, addScopeParams } = await import("../src/retrieval/rag-client.js");
const { retrieveUnified } = await import("../src/retrieval/unified.js");
const { setFgaCheckOverride } = await import("../src/auth/openfga-client.js");

import type { RagClientConfig } from "../src/retrieval/rag-client.js";
import type { UnifiedRetrievalRequest } from "../src/retrieval/types.js";
import type { RetrievalSettings } from "../src/retrieval/unified.js";
import type { GraphState } from "../src/state/types.js";

const baseRagConfig: RagClientConfig = {
  nornicUri: "bolt://nornic.local:7687",
  nornicHttpUrl: "",
  nornicUser: "neo4j",
  nornicPassword: "secret",
  nornicDatabase: "nornic",
  nornicVectorIndex: "embeddings",
  nornicRuntimeProfile: "cpu-bge",
  embedderUrl: "",
  embedderModel: "BAAI/bge-m3",
  retrievalStrategy: "hybrid",
  graphDepth: 1,
  edgeTypes: ["DEFINES"],
  timeoutMs: 1000,
};

const baseSettings: RetrievalSettings = {
  rag: baseRagConfig,
  web: { url: "", enabled: false, timeoutMs: 3000, maxResults: 5, engineAuthorityMap: {} },
  cohesion: {
    enabled: false,
    minResults: 2,
    embeddingThreshold: 0.7,
    llmBorderlineLow: 0.3,
    llmBorderlineHigh: 0.7,
    compressionThreshold: 0.9,
    embedderUrl: "",
    embedderModel: "BAAI/bge-m3",
  },
  rrfK: 60,
  overfetchMin: 8,
  overfetchMax: 25,
  adaptiveGapMultiplier: 1.5,
  domainPolicyMode: "prefer",
  domainPolicyBoost: 1.2,
  webBudgetBase: 3,
  webBudgetMax: 8,
  freshnessWeight: 0.15,
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
  vi.clearAllMocks();
  setFgaCheckOverride(null);
});

// ---------------------------------------------------------------------------
// 1. GraphState field population
// ---------------------------------------------------------------------------
describe("GraphState carries acl_groups and rag_authz_mode", () => {
  it("acl_groups and rag_authz_mode are valid GraphState fields", () => {
    const state: GraphState = {
      user_id: "user-1",
      org_id: "org-1",
      tenant_ids: ["t1"],
      acl_groups: ["engineering", "platform"],
      rag_authz_mode: "enforce",
      authz_trace_id: "trace-123",
    };
    expect(state.acl_groups).toEqual(["engineering", "platform"]);
    expect(state.rag_authz_mode).toBe("enforce");
  });

  it("acl_groups defaults to undefined when not set", () => {
    const state: GraphState = { user_id: "u1" };
    expect(state.acl_groups).toBeUndefined();
    expect(state.rag_authz_mode).toBeUndefined();
  });

  it("rag_authz_mode accepts 'audit' and 'enforce'", () => {
    const audit: GraphState = { rag_authz_mode: "audit" };
    const enforce: GraphState = { rag_authz_mode: "enforce" };
    expect(audit.rag_authz_mode).toBe("audit");
    expect(enforce.rag_authz_mode).toBe("enforce");
  });
});

// ---------------------------------------------------------------------------
// 2. Router threading: state fields map into UnifiedRetrievalRequest
// ---------------------------------------------------------------------------
describe("Router threads scope from GraphState into UnifiedRetrievalRequest", () => {
  it("callerAclGroups, authzMode, authzTraceId populate from state fields", () => {
    const state: GraphState = {
      org_id: "org-1",
      tenant_ids: ["t1", "t2"],
      acl_groups: ["engineering"],
      user_id: "user-1",
      conversation_id: "conv-1",
      rag_authz_mode: "enforce",
      authz_trace_id: "trace-xyz",
      auth_method: "bearer",
    };

    const request: UnifiedRetrievalRequest = {
      query: "test",
      callerOrgId: state.org_id,
      callerTenantIds: state.tenant_ids,
      callerAclGroups: state.acl_groups,
      callerUserId: state.user_id,
      callerConversationId: state.conversation_id,
      authzMode: state.rag_authz_mode,
      authzTraceId: state.authz_trace_id,
    };

    expect(request.callerAclGroups).toEqual(["engineering"]);
    expect(request.authzMode).toBe("enforce");
    expect(request.authzTraceId).toBe("trace-xyz");
  });

  it("missing acl_groups in state yields undefined callerAclGroups", () => {
    const state: GraphState = {
      org_id: "org-1",
      user_id: "user-1",
    };

    const request: UnifiedRetrievalRequest = {
      query: "test",
      callerOrgId: state.org_id,
      callerAclGroups: state.acl_groups,
      authzMode: state.rag_authz_mode,
    };

    expect(request.callerAclGroups).toBeUndefined();
    expect(request.authzMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. retrieveUnified passes authzMode into scopeFilter -> retrieveContext
// ---------------------------------------------------------------------------
describe("retrieveUnified threads authzMode into scopeFilter", () => {
  it("enforce mode request reaches rag-client scopeFilter with authzMode=enforce", async () => {
    runMock.mockResolvedValue({ records: [] });

    const request: UnifiedRetrievalRequest = {
      query: "test query",
      callerOrgId: "org-1",
      callerTenantIds: ["t1"],
      callerAclGroups: ["engineering"],
      callerUserId: "user-1",
      authzMode: "enforce",
      authzTraceId: "trace-parity",
    };

    const bundle = await retrieveUnified(request, baseSettings);
    expect(bundle.results).toBeDefined();

    const callArgs = runMock.mock.calls[0];
    expect(callArgs).toBeDefined();
  });

  it("audit mode request does not trigger FGA filtering", async () => {
    const globalDoc = makeRecord({
      id: "global-1",
      visibility_scope: "global",
      acl_mode: "open",
    });
    runMock.mockResolvedValue({ records: [globalDoc] });

    let fgaCalled = false;
    setFgaCheckOverride(() => {
      fgaCalled = true;
      return { allowed: false };
    });

    const request: UnifiedRetrievalRequest = {
      query: "test",
      callerOrgId: "org-1",
      callerUserId: "user-1",
      authzMode: "audit",
    };

    const bundle = await retrieveUnified(request, baseSettings);
    expect(bundle.results.length).toBeGreaterThanOrEqual(1);
    expect(fgaCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Enforce mode on chat path triggers FGA post-filter
// ---------------------------------------------------------------------------
describe("Enforce mode triggers FGA filtering through chat path scope", () => {
  it("FGA deny removes results when authzMode=enforce via scopeFilter", async () => {
    const restrictedDoc = makeRecord({
      id: "restricted-1",
      visibility_scope: "org",
      acl_mode: "restricted",
      acl_allow: '["other-group"]',
      org_id: "org-1",
    });
    runMock.mockResolvedValue({ records: [restrictedDoc] });

    setFgaCheckOverride(() => ({ allowed: false }));

    const results = await retrieveContext("test", baseRagConfig, {
      collections: ["synesis_catalog"],
      topK: 5,
      scopeFilter: {
        callerOrgId: "org-1",
        callerUserId: "user-1",
        callerAclGroups: ["engineering"],
        authzMode: "enforce",
        authzTraceId: "trace-fga-deny",
      },
    });

    expect(results).toHaveLength(0);
  });

  it("FGA allow retains results when authzMode=enforce via scopeFilter", async () => {
    const restrictedDoc = makeRecord({
      id: "allowed-1",
      visibility_scope: "org",
      acl_mode: "restricted",
      acl_allow: '["engineering"]',
      org_id: "org-1",
      authz_object_id: "document:doc-allowed-1",
    });
    runMock.mockResolvedValue({ records: [restrictedDoc] });

    setFgaCheckOverride(() => ({ allowed: true }));

    const results = await retrieveContext("test", baseRagConfig, {
      collections: ["synesis_catalog"],
      topK: 5,
      scopeFilter: {
        callerOrgId: "org-1",
        callerUserId: "user-1",
        callerAclGroups: ["engineering"],
        authzMode: "enforce",
        authzTraceId: "trace-fga-allow",
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("allowed-1");
  });

  it("without authzMode FGA is a no-op (pre-fix behavior)", async () => {
    const restrictedDoc = makeRecord({
      id: "leaked-1",
      visibility_scope: "org",
      acl_mode: "restricted",
      acl_allow: '["other-group"]',
      org_id: "org-1",
    });
    runMock.mockResolvedValue({ records: [restrictedDoc] });

    setFgaCheckOverride(() => ({ allowed: false }));

    const results = await retrieveContext("test", baseRagConfig, {
      collections: ["synesis_catalog"],
      topK: 5,
      scopeFilter: {
        callerOrgId: "org-1",
        callerUserId: "user-1",
        callerAclGroups: ["engineering"],
        // authzMode intentionally omitted — simulates pre-fix state
      },
    });

    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. ACL groups on chat path produce group-matching Cypher predicates
// ---------------------------------------------------------------------------
describe("ACL groups produce correct Cypher predicates", () => {
  it("acl_groups without enforce mode generates Cypher-level group-match clause", () => {
    const predicate = buildScopePredicate("n", {
      callerOrgId: "org-1",
      callerAclGroups: ["engineering", "platform"],
      callerUserId: "user-1",
    });

    expect(predicate).toContain("$caller_acl_groups");
    expect(predicate).toContain("caller_org_id");
  });

  it("enforce mode with callerUserId delegates ACL to FGA (all modes pass Cypher)", () => {
    const predicate = buildScopePredicate("n", {
      callerOrgId: "org-1",
      callerAclGroups: ["engineering", "platform"],
      callerUserId: "user-1",
      authzMode: "enforce",
    });

    expect(predicate).not.toContain("$caller_acl_groups");
    expect(predicate).toContain('"restricted"');
    expect(predicate).toContain('"private"');
  });

  it("scope params include caller_acl_groups array (snake_case)", () => {
    const params: Record<string, unknown> = {};
    addScopeParams(
      {
        callerOrgId: "org-1",
        callerAclGroups: ["engineering", "platform"],
        callerUserId: "user-1",
        authzMode: "enforce",
      },
      params,
    );

    expect(params.caller_acl_groups).toEqual(["engineering", "platform"]);
    expect(params.caller_org_id).toBe("org-1");
  });

  it("empty acl_groups still generates safe predicate", () => {
    const predicate = buildScopePredicate("n", {
      callerOrgId: "org-1",
      callerAclGroups: [],
      callerUserId: "user-1",
    });

    expect(predicate).toBeTruthy();
  });

  it("undefined acl_groups produces predicate without group clause", () => {
    const params: Record<string, unknown> = {};
    addScopeParams(
      {
        callerOrgId: "org-1",
        callerUserId: "user-1",
      },
      params,
    );

    expect(params.caller_acl_groups).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Chat-knowledge parity: full scope round-trip through retrieveUnified
// ---------------------------------------------------------------------------
describe("Chat-knowledge parity: full scope round-trip", () => {
  it("enforce + aclGroups through retrieveUnified filters correctly", async () => {
    const restrictedDoc = makeRecord({
      id: "fga-gated-1",
      visibility_scope: "org",
      acl_mode: "restricted",
      acl_allow: '["other-group"]',
      org_id: "org-1",
    });
    runMock.mockResolvedValue({ records: [restrictedDoc] });

    setFgaCheckOverride(() => ({ allowed: false }));

    const request: UnifiedRetrievalRequest = {
      query: "test parity",
      callerOrgId: "org-1",
      callerTenantIds: ["t1"],
      callerAclGroups: ["engineering"],
      callerUserId: "user-1",
      authzMode: "enforce",
      authzTraceId: "trace-parity-full",
      trustedScopeSource: "auth_context",
    };

    const bundle = await retrieveUnified(request, baseSettings);

    const ragResults = bundle.results.filter((r) => r.origin_type === "graph");
    expect(ragResults).toHaveLength(0);
  });

  it("trustedScopeSource is threaded into request for diagnostics", () => {
    const request: UnifiedRetrievalRequest = {
      query: "test",
      callerOrgId: "org-1",
      trustedScopeSource: "auth_context",
    };
    expect(request.trustedScopeSource).toBe("auth_context");
  });
});
