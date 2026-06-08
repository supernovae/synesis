import { describe, expect, it } from "vitest";
import {
  authDiagnostics,
  buildForwardedIdentityPrincipal,
  constantTimeBearerMatch,
  extractBearerToken,
  hasForwardedIdentityHeaders,
  hasScopePrefix,
  hashPatToken,
  normalizeTokenScopes,
  parseForwardedIdentityHeaders,
  parseCsvScopes,
  stableOpaqueBearerUserId,
  validatePatPepperRequirement,
} from "../src/index.js";

describe("@synesis/auth-contracts", () => {
  it("extracts bearer tokens case-insensitively", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("Basic abc")).toBe("");
  });

  it("compares bearer tokens without accepting empty or unequal length values", () => {
    expect(constantTimeBearerMatch("Bearer secret", "secret")).toBe(true);
    expect(constantTimeBearerMatch("Bearer secret", "other")).toBe(false);
    expect(constantTimeBearerMatch("Bearer secret", "secret-longer")).toBe(false);
    expect(constantTimeBearerMatch(undefined, "secret")).toBe(false);
    expect(constantTimeBearerMatch("Bearer secret", "")).toBe(false);
  });

  it("hashes PATs with and without pepper", () => {
    const plain = hashPatToken("syn-test", "");
    const hmac = hashPatToken("syn-test", "pepper");
    expect(plain).toHaveLength(64);
    expect(hmac).toHaveLength(64);
    expect(hmac).not.toBe(plain);
  });

  it("generates stable opaque bearer ids without exposing token material", () => {
    const first = stableOpaqueBearerUserId("token-1");
    expect(first).toMatch(/^bearer-[a-f0-9]{24}$/);
    expect(stableOpaqueBearerUserId("token-1")).toBe(first);
    expect(stableOpaqueBearerUserId("token-2")).not.toBe(first);
  });

  it("enforces PAT pepper when requested", () => {
    expect(() =>
      validatePatPepperRequirement({
        patValidationEnabled: true,
        pepper: "",
        requirePatPepper: true,
        serviceName: "test",
      }),
    ).toThrow(/SYNESIS_PAT_PEPPER/);
    expect(() =>
      validatePatPepperRequirement({
        patValidationEnabled: true,
        pepper: "",
        requirePatPepper: false,
        serviceName: "test",
      }),
    ).not.toThrow();
  });

  it("parses comma-separated scopes", () => {
    expect(parseCsvScopes(" model:readonly, coder:readonly ,,")).toEqual(["model:readonly", "coder:readonly"]);
    expect(parseCsvScopes(" MCP:INVOKE, coder:execute, mcp:invoke")).toEqual(["mcp:invoke", "coder:execute"]);
    expect(parseCsvScopes(["a,b", "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeTokenScopes([" model:readonly", "model:readonly", ""])).toEqual(["model:readonly"]);
    expect(hasScopePrefix(["coder:execute"], ["coder:"])).toBe(true);
    expect(hasScopePrefix(["model:readonly"], ["coder:"])).toBe(false);
  });

  it("rejects malformed security scope strings", () => {
    expect(() => parseCsvScopes("model:readonly, role override")).toThrow(/invalid_token_scopes/);
    expect(() => parseCsvScopes("model:readonly,admin/write")).toThrow(/invalid_token_scopes/);
  });

  it("parses trusted forwarded identity headers into a principal contract", () => {
    const headers = {
      "x-openwebui-user-id": "user-1",
      "x-openwebui-user-email": "user@example.com",
      "x-synesis-org-id": "org-1",
      "x-synesis-tenant-ids": "tenant-a,tenant-b",
      "x-synesis-acl-groups": ["team-a, team-b"],
      "x-synesis-token-scopes": "model:readonly,coder:execute",
    };

    expect(hasForwardedIdentityHeaders(headers)).toBe(true);
    const forwarded = parseForwardedIdentityHeaders(headers);
    expect(forwarded).toMatchObject({
      present: true,
      userId: "user-1",
      userEmail: "user@example.com",
      orgId: "org-1",
      tenantIds: ["tenant-a", "tenant-b"],
      aclGroups: ["team-a", "team-b"],
      tokenScopes: ["model:readonly", "coder:execute"],
    });

    const principal = buildForwardedIdentityPrincipal(forwarded);
    expect(principal.authMethod).toBe("internal_service");
    expect(principal.trustedForwardedIdentity).toBe(true);
    expect(principal.tokenScopes).toEqual(["model:readonly", "coder:execute"]);
    expect(authDiagnostics(principal)).toMatchObject({
      user_id: "user-1",
      auth_method: "internal_service",
      trusted_forwarded_identity: true,
      scope_count: 2,
    });
  });

  it("rejects malformed trusted forwarded identity headers", () => {
    expect(() => parseForwardedIdentityHeaders({
      "x-openwebui-user-id": "trusted user",
    })).toThrow(/invalid_forwarded_user_id/);
    expect(() => parseForwardedIdentityHeaders({
      "x-openwebui-user-id": "trusted-user",
      "x-openwebui-user-email": "not an email",
    })).toThrow(/invalid_forwarded_user_email/);
    expect(() => parseForwardedIdentityHeaders({
      "x-openwebui-user-id": "trusted-user",
      "x-synesis-org-id": "org alpha",
    })).toThrow(/invalid_forwarded_org_id/);
    expect(() => parseForwardedIdentityHeaders({
      "x-openwebui-user-id": "trusted-user",
      "x-synesis-token-scopes": "model:readonly,role override",
    })).toThrow(/invalid_token_scopes/);
  });
});
