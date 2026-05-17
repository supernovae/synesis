import { describe, expect, it } from "vitest";
import { McpAuthResolver, type PatUser } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

function resolver(): McpAuthResolver {
  return new McpAuthResolver(loadConfig({}));
}

function user(scopes: string[]): PatUser {
  return {
    userId: "u1",
    orgId: "o1",
    tenantIds: [],
    role: "user",
    tokenScopes: scopes,
  };
}

describe("McpAuthResolver", () => {
  it("denies empty or chat/model-only scopes for MCP access", () => {
    const auth = resolver();
    expect(() => auth.requireCoderScope(user([]))).toThrow(/Insufficient scope/);
    expect(() => auth.requireCoderScope(user(["model:readonly"]))).toThrow(/Insufficient scope/);
    expect(() => auth.requireCoderScope(user(["chat:write"]))).toThrow(/Insufficient scope/);
  });

  it("allows explicit MCP and coder scopes", () => {
    const auth = resolver();
    expect(() => auth.requireCoderScope(user(["mcp:invoke"]))).not.toThrow();
    expect(() => auth.requireCoderScope(user(["mcp:tool:synesis_search"]))).not.toThrow();
    expect(() => auth.requireCoderScope(user(["coder:execute"]))).not.toThrow();
  });

  it("can require PAT pepper when configured", () => {
    expect(() =>
      loadConfig({
        SYNESIS_ADMIN_DB_URL: "postgresql://admin.example/synesis",
        SYNESIS_REQUIRE_PAT_PEPPER: "true",
      }),
    ).toThrow(/SYNESIS_PAT_PEPPER/);
  });
});
