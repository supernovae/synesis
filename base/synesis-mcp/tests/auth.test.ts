import crypto from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
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

const nowSeconds = 1_800_000_000;

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}

function signedJwt(privateKey: crypto.KeyObject, payload: Record<string, unknown>): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKey).toString("base64url")}`;
}

function validOidcPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://auth.example.com/realms/synesis",
    sub: "user-123",
    exp: nowSeconds + 600,
    azp: "synesis-harness",
    preferred_username: "pi-user",
    email: "pi-user@example.com",
    scope: "openid profile email",
    realm_access: { roles: ["synesis-user"] },
    organization: {
      "org-1": { name: "Org One", roles: ["admin"] },
    },
    ...overrides,
  };
}

function stubOidcJwks(jwk: JsonWebKey) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    expect(String(url)).toBe("http://keycloak.internal/realms/synesis/protocol/openid-connect/certs");
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
}

describe("McpAuthResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("rejects wildcard credentialed CORS in any environment", () => {
    expect(() =>
      loadConfig({
        SYNESIS_MCP_CORS_ORIGINS: "*",
      }),
    ).toThrow(/CORS_ALLOW_CREDENTIALS/);
  });

  it("rejects wildcard CORS outside development even when non-credentialed", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        SYNESIS_MCP_CORS_ORIGINS: "*",
        SYNESIS_MCP_CORS_ALLOW_CREDENTIALS: "false",
      }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it("allows wildcard CORS only as an explicit non-credentialed development mode", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      SYNESIS_MCP_CORS_ORIGINS: "*",
      SYNESIS_MCP_CORS_ALLOW_CREDENTIALS: "false",
    });
    expect(config.SYNESIS_MCP_CORS_ALLOW_CREDENTIALS).toBe(false);
  });

  it("resolves valid harness OIDC bearer tokens for hosted MCP", async () => {
    const { privateKey, jwk } = keyPair();
    stubOidcJwks(jwk);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const auth = new McpAuthResolver(loadConfig({
      SYNESIS_OIDC_ISSUER_URL: "https://auth.example.com/realms/synesis",
      SYNESIS_OIDC_INTERNAL_ISSUER_URL: "http://keycloak.internal/realms/synesis",
      SYNESIS_OIDC_ALLOWED_CLIENT_IDS: "synesis-harness",
      SYNESIS_OIDC_REQUIRED_ROLES: "synesis-user",
    }));

    const user = await auth.resolveOidc(signedJwt(privateKey, validOidcPayload()));

    expect(user.userId).toBe("user-123");
    expect(user.orgId).toBe("org-1");
    expect(user.role).toBe("org_admin");
    expect(user.authMethod).toBe("oidc");
    expect(user.tokenScopes).toEqual(["mcp:invoke", "coder:oidc", "openid", "profile", "email"]);
    nowSpy.mockRestore();
  });

  it("fails closed for malformed hosted MCP OIDC tokens", async () => {
    const auth = new McpAuthResolver(loadConfig({
      SYNESIS_OIDC_ISSUER_URL: "https://auth.example.com/realms/synesis",
    }));
    await expect(auth.resolveOidc("bad.token.value")).rejects.toThrow(/invalid_oidc_token/);
  });
});
