import { describe, expect, it } from "vitest";
import { buildPgPoolConfig } from "../src/db/pg-pool-config.js";

describe("buildPgPoolConfig", () => {
  it("normalizes asyncpg URLs and ssl=require for node-pg", () => {
    const config = buildPgPoolConfig(
      "postgresql+asyncpg://user:pass@example.com:5432/synesis_admin?ssl=require",
      5,
    );

    expect(config.max).toBe(5);
    expect(config.connectionString).toBe(
      "postgresql://user:pass@example.com:5432/synesis_admin?sslmode=require&uselibpqcompat=true",
    );
  });

  it("leaves sslmode URLs usable without adding duplicate SSL parameters", () => {
    const config = buildPgPoolConfig(
      "postgresql://user:pass@example.com:5432/synesis_admin?sslmode=verify-full",
      10,
    );

    expect(config.max).toBe(10);
    expect(config.connectionString).toBe(
      "postgresql://user:pass@example.com:5432/synesis_admin?sslmode=verify-full",
    );
  });
});

