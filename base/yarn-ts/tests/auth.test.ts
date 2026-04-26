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

    it("returns stable hashed user id for opaque non-PAT bearer tokens", async () => {
      resolver = new AuthResolver(makeConfig());
      const user = await resolver.resolve("Bearer some-api-key-123");
      expect(user.userId).toMatch(/^bearer-[a-f0-9]{24}$/);
      expect(user.authMethod).toBe("bearer");
      expect(user.tokenScopes).toEqual([]);

      const again = await resolver.resolve("Bearer some-api-key-123");
      expect(again.userId).toBe(user.userId);
    });

    it("normalizes JWT bearer identity from a test user email", async () => {
      resolver = new AuthResolver(makeConfig());
      const token = unsignedJwt({
        email: "Yarn.Test.User@example.com",
        sub: "test-user-subject",
      });
      const user = await resolver.resolve(`Bearer ${token}`);
      expect(user.userId).toBe("yarn.test.user@example.com");
      expect(user.displayName).toBe("yarn.test.user@example.com");
      expect(user.authMethod).toBe("bearer");
    });

    it("normalizes JWT bearer identity from sub when email is absent", async () => {
      resolver = new AuthResolver(makeConfig());
      const token = unsignedJwt({ sub: "test-user-subject" });
      const user = await resolver.resolve(`Bearer ${token}`);
      expect(user.userId).toBe("test-user-subject");
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

    it("passes for user with empty scopes (permissive default)", () => {
      expect(() =>
        resolver.requireCoderScope({ userId: "u1", orgId: "", role: "user", authMethod: "bearer", tokenScopes: [] })
      ).not.toThrow();
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
