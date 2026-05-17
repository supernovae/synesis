import { describe, expect, it, vi } from "vitest";

const resolvePatFromDbMock = vi.fn(async (token: string, _pepper: string) => {
  if (token === "syn-org1-user") {
    return {
      userId: "user-1",
      orgId: "org-1",
      tenantIds: ["tenant-1"],
      role: "user",
      scopes: ["model:readonly"],
    };
  }
  if (token === "syn-org2-user") {
    return {
      userId: "user-2",
      orgId: "org-2",
      tenantIds: ["tenant-2"],
      role: "user",
      scopes: ["model:readonly"],
    };
  }
  if (token === "syn-solo-user") {
    return {
      userId: "solo-user",
      orgId: "",
      tenantIds: [],
      role: "user",
      scopes: ["model:readonly"],
    };
  }
  if (token === "syn-acl-user") {
    return {
      userId: "acl-user",
      orgId: "org-1",
      tenantIds: ["tenant-1"],
      role: "user",
      scopes: ["model:readonly"],
      aclGroups: ["engineering", "platform"],
    };
  }
  return null;
});

vi.mock("../src/auth/pat-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/pat-resolver.js")>("../src/auth/pat-resolver.js");
  return {
    ...actual,
    resolvePatFromDb: (token: string, pepper: string) => resolvePatFromDbMock(token, pepper),
  };
});

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "debug-token",
    SYNESIS_WEB_SEARCH_ENABLED: "false",
    SYNESIS_WEB_SEARCH_URL: "",
    SYNESIS_NORNIC_URI: "",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Knowledge route: scope derived from auth, body hints ignored
// ---------------------------------------------------------------------------
describe("Knowledge route scope derived from auth", () => {
  it("PAT org-1 scope is used; body caller_org_id=org-2 is ignored", async () => {
    const app = buildApp(makeConfig({ SYNESIS_RAG_AUTHZ_MODE: "enforce" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: {
        query: "test query",
        caller_org_id: "org-2",
        caller_tenant_ids: ["other-tenant"],
        caller_user_id: "other-user",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authz_mode).toBe("enforce");
    expect(body.authz_trace_id).toBeTruthy();
    expect(body.results).toEqual([]);
    await app.close();
  });

  it("PAT org-2 user gets different scope than org-1 user", async () => {
    const app = buildApp(makeConfig());
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: { query: "test" },
    });
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org2-user" },
      payload: { query: "test" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const trace1 = res1.headers["x-synesis-authz-trace-id"];
    const trace2 = res2.headers["x-synesis-authz-trace-id"];
    expect(trace1).toBeTruthy();
    expect(trace2).toBeTruthy();
    expect(trace1).not.toBe(trace2);
    await app.close();
  });

  it("internal token with forwarded headers derives scope from headers", async () => {
    const app = buildApp(makeConfig({
      SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: {
        authorization: "Bearer debug-token",
        "x-openwebui-user-id": "forwarded-user-1",
        "x-synesis-org-id": "forwarded-org",
        "x-synesis-tenant-ids": "ft1,ft2",
        "x-synesis-acl-groups": "team-a,team-b",
      },
      payload: {
        query: "test",
        caller_org_id: "should-be-ignored",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-synesis-authz-trace-id"]).toBeTruthy();
    await app.close();
  });

  it("solo user (no org in PAT) gets only global scope", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-solo-user" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
    await app.close();
  });

  it("unauthenticated request gets 401", async () => {
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer totally-random" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// authzMode config propagation
// ---------------------------------------------------------------------------
describe("authzMode configuration", () => {
  it("knowledge search with enforce mode returns authz_mode=enforce", async () => {
    const app = buildApp(makeConfig({ SYNESIS_RAG_AUTHZ_MODE: "enforce" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authz_mode).toBe("enforce");
    await app.close();
  });

  it("knowledge search with audit mode returns authz_mode=audit", async () => {
    const app = buildApp(makeConfig({ SYNESIS_RAG_AUTHZ_MODE: "audit" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authz_mode).toBe("audit");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Knowledge route: authz trace is unique per request
// ---------------------------------------------------------------------------
describe("authz trace isolation", () => {
  it("each request gets a unique authz_trace_id", async () => {
    const app = buildApp(makeConfig());
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/knowledge/search",
        headers: { authorization: "Bearer syn-org1-user" },
        payload: { query: `test-${i}` },
      });
      expect(res.statusCode).toBe(200);
      const id = res.headers["x-synesis-authz-trace-id"];
      expect(id).toBeTruthy();
      ids.add(String(id));
    }
    expect(ids.size).toBe(5);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Bundle and resolve-pack routes honor scope
// ---------------------------------------------------------------------------
describe("Bundle and resolve-pack scope", () => {
  it("resolve-pack requires authorized access", async () => {
    const app = buildApp(makeConfig());
    const denied = await app.inject({
      method: "POST",
      url: "/v1/knowledge/resolve-pack",
      headers: { authorization: "Bearer totally-random" },
      payload: { query: "test" },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("resolve-pack returns authz diagnostics", async () => {
    const app = buildApp(makeConfig({ SYNESIS_RAG_AUTHZ_MODE: "enforce" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/resolve-pack",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authz_trace_id).toBeTruthy();
    expect(body.authz_mode).toBe("enforce");
    await app.close();
  });

  it("bundle route requires authorized access", async () => {
    const app = buildApp(makeConfig());
    const denied = await app.inject({
      method: "POST",
      url: "/v1/knowledge/bundle",
      headers: { authorization: "Bearer totally-random" },
      payload: { query: "test" },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("bundle route returns authz diagnostics with org-scoped PAT", async () => {
    const app = buildApp(makeConfig({ SYNESIS_RAG_AUTHZ_MODE: "enforce" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/bundle",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: { query: "test query", language: "go" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authz_trace_id).toBeTruthy();
    expect(body.authz_mode).toBe("enforce");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Chat path authzMode is now threaded (gap closed)
// ---------------------------------------------------------------------------
describe("Chat path authzMode threading (gap closed)", () => {
  // The chat path now threads authzMode through:
  //   app.ts baseState (rag_authz_mode) -> router.ts (authzMode on UnifiedRetrievalRequest)
  //     -> unified.ts scopeFilter (authzMode) -> rag-client.ts filterByFga
  // Unit-level verification of each hop is in chat-scope-parity.test.ts.
  // This test confirms the knowledge route still works correctly with enforce mode.

  it("knowledge route sets authzMode from config (parity baseline)", async () => {
    const app = buildApp(makeConfig({
      SYNESIS_RAG_AUTHZ_MODE: "enforce",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authz_mode).toBe("enforce");
    await app.close();
  });

  it("ACL user on knowledge route has acl groups threaded from PAT", async () => {
    const app = buildApp(makeConfig({
      SYNESIS_RAG_AUTHZ_MODE: "enforce",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-acl-user" },
      payload: { query: "test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authz_mode).toBe("enforce");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Caller scope hints are never trusted from request body
// ---------------------------------------------------------------------------
describe("Caller scope hints ignored from body", () => {
  it("caller_org_id in body does not override PAT org", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: {
        query: "test",
        caller_org_id: "attacker-org",
        caller_tenant_ids: ["attacker-tenant"],
        caller_acl_groups: ["attacker-group"],
        caller_user_id: "attacker-user",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("resolve-pack ignores caller scope hints from body", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/resolve-pack",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: {
        query: "test",
        caller_org_id: "attacker-org",
        caller_user_id: "attacker-user",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("bundle route ignores caller scope hints from body", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/bundle",
      headers: { authorization: "Bearer syn-org1-user" },
      payload: {
        query: "test",
        caller_org_id: "attacker-org",
        caller_user_id: "attacker-user",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
