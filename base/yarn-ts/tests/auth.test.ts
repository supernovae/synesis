import crypto from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AuthResolver } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";

vi.mock("pg", () => {
  class MockPool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: MockPool };
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    PORT: 8000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    SYNESIS_YARN_ADMIN_API_URL: "http://admin",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "",
    SYNESIS_YARN_TIER_POLL_INTERVAL: 60,
    SYNESIS_YARN_DEFAULT_TIER: "synesis-core",
    SYNESIS_YARN_OPENAI_COMPAT_BASE_URL: "https://fallback/v1",
    SYNESIS_YARN_OPENAI_COMPAT_API_KEY: "k",
    SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS: 12,
    SYNESIS_YARN_SESSION_REDIS_URL: "redis://localhost:6379/3",
    SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
    SYNESIS_PAT_PEPPER: "",
    SYNESIS_REQUIRE_PAT_PEPPER: false,
    SYNESIS_YARN_ALLOW_OPAQUE_BEARER: false,
    SYNESIS_YARN_DB_POOL_MAX: 5,
    SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
    SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
    SYNESIS_YARN_WRITE_QUEUE_MAX: 10000,
    SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 50,
    SYNESIS_YARN_SESSION_TTL_MS: 14400000,
    SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
    ...overrides
  };
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
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

describe("AuthResolver", () => {
  let resolver: AuthResolver;

  afterEach(async () => {
    if (resolver) await resolver.close();
    vi.restoreAllMocks();
  });

  describe("resolve", () => {
    it("throws on missing Authorization header", async () => {
      resolver = new AuthResolver(makeConfig());
      await expect(resolver.resolve(undefined)).rejects.toThrow("Missing Bearer token");
    });

    it("throws on empty Authorization header", async () => {
      resolver = new AuthResolver(makeConfig());
      await expect(resolver.resolve("")).rejects.toThrow("Missing Bearer token");
    });

    it("throws on Authorization header without Bearer prefix", async () => {
      resolver = new AuthResolver(makeConfig());
      await expect(resolver.resolve("Basic abc")).rejects.toThrow("Missing Bearer token");
    });

    it("rejects opaque non-PAT bearer tokens by default", async () => {
      resolver = new AuthResolver(makeConfig());
      await expect(resolver.resolve("Bearer some-api-key-123")).rejects.toThrow("Opaque bearer authentication is disabled");
    });

    it("returns stable hashed user id for opaque non-PAT bearer tokens when compatibility is enabled", async () => {
      resolver = new AuthResolver(makeConfig({ SYNESIS_YARN_ALLOW_OPAQUE_BEARER: true }));
      const user = await resolver.resolve("Bearer some-api-key-123");
      expect(user.userId).toMatch(/^bearer-[a-f0-9]{24}$/);
      expect(user.authMethod).toBe("bearer");
      expect(user.tokenScopes).toEqual(["coder:opaque"]);

      const again = await resolver.resolve("Bearer some-api-key-123");
      expect(again.userId).toBe(user.userId);
    });

    it("does not trust unsigned JWT email claims for authorization identity", async () => {
      resolver = new AuthResolver(makeConfig({ SYNESIS_YARN_ALLOW_OPAQUE_BEARER: true }));
      const token = unsignedJwt({
        email: "Yarn.Test.User@example.com",
        sub: "test-user-subject",
      });
      const user = await resolver.resolve(`Bearer ${token}`);
      expect(user.userId).toMatch(/^bearer-[a-f0-9]{24}$/);
      expect(user.userId).not.toBe("yarn.test.user@example.com");
      expect(user.displayName).toBe("yarn.test.user@example.com");
      expect(user.authMethod).toBe("bearer");
    });

    it("does not trust unsigned JWT sub claims for authorization identity", async () => {
      resolver = new AuthResolver(makeConfig({ SYNESIS_YARN_ALLOW_OPAQUE_BEARER: true }));
      const token = unsignedJwt({ sub: "test-user-subject" });
      const user = await resolver.resolve(`Bearer ${token}`);
      expect(user.userId).toMatch(/^bearer-[a-f0-9]{24}$/);
      expect(user.userId).not.toBe("test-user-subject");
      expect(user.displayName).toBeUndefined();
    });

    it("throws for invalid PAT (syn- prefix but not found in DB)", async () => {
      resolver = new AuthResolver(makeConfig());
      await expect(resolver.resolve("Bearer syn-invalid-token")).rejects.toThrow("Invalid token");
    });

    it("resolves a valid PAT from DB", async () => {
      resolver = new AuthResolver(makeConfig());
      const pool = (resolver as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
      pool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_id: "u1", org_id: "org1", role: "admin", scopes: ["coder", "model:write"] }]
      });
      const user = await resolver.resolve("Bearer syn-valid-token");
      expect(user.userId).toBe("u1");
      expect(user.orgId).toBe("org1");
      expect(user.authMethod).toBe("pat");
      expect(user.tokenScopes).toEqual(["coder", "model:write"]);
    });

    it("resolves a valid harness OIDC bearer token", async () => {
      const { privateKey, jwk } = keyPair();
      stubOidcJwks(jwk);
      resolver = new AuthResolver(makeConfig({
        SYNESIS_YARN_ADMIN_DB_URL: "",
        SYNESIS_OIDC_ISSUER_URL: "https://auth.example.com/realms/synesis",
        SYNESIS_OIDC_INTERNAL_ISSUER_URL: "http://keycloak.internal/realms/synesis",
        SYNESIS_OIDC_ALLOWED_CLIENT_IDS: "synesis-harness",
        SYNESIS_OIDC_REQUIRED_ROLES: "synesis-user",
      }));
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);

      const user = await resolver.resolve(`Bearer ${signedJwt(privateKey, validOidcPayload())}`);

      expect(user.userId).toBe("user-123");
      expect(user.orgId).toBe("org-1");
      expect(user.role).toBe("org_admin");
      expect(user.authMethod).toBe("oidc");
      expect(user.tokenScopes).toEqual(["coder:oidc", "openid", "profile", "email"]);
      nowSpy.mockRestore();
    });

    it("fails closed for malformed OIDC bearer tokens when OIDC is configured", async () => {
      resolver = new AuthResolver(makeConfig({
        SYNESIS_YARN_ADMIN_DB_URL: "",
        SYNESIS_OIDC_ISSUER_URL: "https://auth.example.com/realms/synesis",
      }));
      const token = unsignedJwt({ sub: "test-user-subject" });
      await expect(resolver.resolve(`Bearer ${token}`)).rejects.toThrow("Invalid OIDC token");
    });
  });

  describe("requireCoderScope", () => {
    beforeEach(() => {
      resolver = new AuthResolver(makeConfig());
    });

    it("passes for user with coder scope", () => {
      expect(() =>
        resolver.requireCoderScope({ userId: "u1", orgId: "", role: "user", authMethod: "pat", tokenScopes: ["coder"] })
      ).not.toThrow();
    });

    it("passes for user with model: scope prefix", () => {
      expect(() =>
        resolver.requireCoderScope({ userId: "u1", orgId: "", role: "user", authMethod: "pat", tokenScopes: ["model:write"] })
      ).not.toThrow();
    });

    it("passes for user with chat: scope prefix", () => {
      expect(() =>
        resolver.requireCoderScope({ userId: "u1", orgId: "", role: "user", authMethod: "pat", tokenScopes: ["chat:read"] })
      ).not.toThrow();
    });

    it("denies user with empty scopes (fail-closed)", () => {
      expect(() =>
        resolver.requireCoderScope({ userId: "u1", orgId: "", role: "user", authMethod: "bearer", tokenScopes: [] })
      ).toThrow("Insufficient scope");
    });

    it("throws for user with only unrelated scopes", () => {
      expect(() =>
        resolver.requireCoderScope({ userId: "u1", orgId: "", role: "user", authMethod: "pat", tokenScopes: ["admin:read", "billing:write"] })
      ).toThrow("Insufficient scope");
    });
  });

  describe("PAT hashing", () => {
    it("produces consistent hash without pepper", async () => {
      resolver = new AuthResolver(makeConfig({ SYNESIS_PAT_PEPPER: "" }));
      const pool = (resolver as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
      pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

      await resolver.resolve("Bearer syn-test").catch(() => {});
      const call1Args = pool.query.mock.calls[0]?.[1]?.[0] as string;

      await resolver.resolve("Bearer syn-test").catch(() => {});
      const call2Args = pool.query.mock.calls[1]?.[1]?.[0] as string;

      expect(call1Args).toBe(call2Args);
      expect(call1Args).toHaveLength(64);
    });

    it("produces different hash with pepper vs without", async () => {
      const noPepper = new AuthResolver(makeConfig({ SYNESIS_PAT_PEPPER: "" }));
      const withPepper = new AuthResolver(makeConfig({ SYNESIS_PAT_PEPPER: "secret-pepper" }));

      const poolNp = (noPepper as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
      const poolWp = (withPepper as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
      poolNp.query.mockResolvedValue({ rowCount: 0, rows: [] });
      poolWp.query.mockResolvedValue({ rowCount: 0, rows: [] });

      await noPepper.resolve("Bearer syn-test").catch(() => {});
      await withPepper.resolve("Bearer syn-test").catch(() => {});

      const hashNp = poolNp.query.mock.calls[0]?.[1]?.[0] as string;
      const hashWp = poolWp.query.mock.calls[0]?.[1]?.[0] as string;

      expect(hashNp).not.toBe(hashWp);

      await noPepper.close();
      await withPepper.close();
    });
  });
});
