import { describe, expect, it } from "vitest";

import { upstreamAuthHeaders } from "../../../packages/synesis-mcp-tools/src/deps.js";

describe("MCP upstream authorization", () => {
  const auth = {
    bearerToken: "client-token-must-not-transit",
    userId: "user-1",
    orgId: "org-1",
    tenantIds: ["tenant-a", "tenant-b"],
    aclGroups: ["team-a"],
  };

  it("uses a distinct service credential and forwards validated identity", () => {
    expect(upstreamAuthHeaders(auth, {
      plannerBaseUrl: "http://planner",
      internalServiceToken: "planner-service-token",
    })).toEqual({
      Authorization: "Bearer planner-service-token",
      "x-openwebui-user-id": "user-1",
      "x-synesis-org-id": "org-1",
      "x-synesis-tenant-ids": "tenant-a,tenant-b",
      "x-synesis-acl-groups": "team-a",
    });
  });

  it("keeps explicit local compatibility fallback free of trusted identity headers", () => {
    expect(upstreamAuthHeaders(auth, {
      plannerBaseUrl: "http://planner",
      allowClientTokenFallback: true,
    })).toEqual({
      Authorization: "Bearer client-token-must-not-transit",
    });
  });

  it("fails closed for hosted callers without a service credential", () => {
    expect(upstreamAuthHeaders(auth, { plannerBaseUrl: "http://planner" })).toEqual({});
  });
});
