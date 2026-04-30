import { describe, expect, it, vi } from "vitest";

const resolvePatFromDbMock = vi.fn(async (token: string, _pepper: string) => {
  if (token === "syn-valid") {
    return {
      userId: "user-1",
      orgId: "org-1",
      tenantIds: ["tenant-1"],
      role: "user",
      scopes: ["model:readonly"],
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
    ...overrides,
  });
}

describe("search route authorization", () => {
  it("rejects arbitrary bearer when internal token is unset", async () => {
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/web/search",
      headers: { authorization: "Bearer totally-random" },
      payload: { query: "synesis docs" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects invalid syn PAT", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/web/search",
      headers: { authorization: "Bearer syn-invalid" },
      payload: { query: "synesis docs" },
    });
    expect(res.statusCode).toBe(401);
    expect(resolvePatFromDbMock).toHaveBeenCalled();
    await app.close();
  });

  it("accepts validated syn PAT", async () => {
    const app = buildApp(makeConfig({ SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "" }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/web/search",
      headers: { authorization: "Bearer syn-valid" },
      payload: { query: "synesis docs" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("accepts internal token for knowledge search", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer debug-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("ignores caller-provided RAG scope hints and returns authz diagnostics", async () => {
    const app = buildApp(makeConfig({
      SYNESIS_NORNIC_URI: "",
      SYNESIS_RAG_AUTHZ_MODE: "enforce",
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      headers: { authorization: "Bearer syn-valid" },
      payload: {
        query: "tenant private docs",
        caller_org_id: "other-org",
        caller_tenant_ids: ["other-tenant"],
        caller_acl_groups: ["admins"],
        caller_user_id: "other-user",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-synesis-authz-trace-id"]).toBeTruthy();
    const body = res.json();
    expect(body.authz_mode).toBe("enforce");
    expect(body.authz_trace_id).toBe(res.headers["x-synesis-authz-trace-id"]);
    expect(body.results).toEqual([]);
    await app.close();
  });
});
