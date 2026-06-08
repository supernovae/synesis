import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  Pool: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: pgMock.Pool,
}));

import { closePatPool, initPatPool, resolvePatFromDb } from "../src/auth/pat-resolver.js";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "pat-1",
    name: "  Planner Token  ",
    token_prefix: "syn_abc123",
    user_id: "user-1",
    org_id: "org-1",
    tenant_ids: ["tenant-a", "tenant-a", "tenant_b"],
    role: "ORG_ADMIN",
    scopes: ["MODEL:READONLY", "coder:execute", "coder:execute"],
    ...overrides,
  };
}

function selectResult(record: Record<string, unknown>) {
  return { rowCount: 1, rows: [record] };
}

function updateCalls(): unknown[][] {
  return pgMock.query.mock.calls.filter((call) => String(call[0]).includes("UPDATE personal_access_tokens"));
}

beforeEach(() => {
  pgMock.query.mockReset();
  pgMock.end.mockReset();
  pgMock.Pool.mockReset();
  pgMock.Pool.mockImplementation(function Pool() {
    return { query: pgMock.query, end: pgMock.end };
  });
  initPatPool({
    SYNESIS_PLANNER_TS_ADMIN_DB_URL: "postgresql://planner.example/synesis",
    SYNESIS_PAT_PEPPER: "pepper",
  } as never);
});

afterEach(async () => {
  await closePatPool();
  vi.clearAllMocks();
});

describe("resolvePatFromDb", () => {
  it("normalizes validated PAT identity, role, tenants, and scopes", async () => {
    pgMock.query.mockResolvedValueOnce(selectResult(row())).mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const resolved = await resolvePatFromDb("syn-valid-token", "pepper");

    expect(resolved).toEqual({
      id: "pat-1",
      name: "Planner Token",
      tokenPrefix: "syn_abc123",
      userId: "user-1",
      orgId: "org-1",
      tenantIds: ["tenant-a", "tenant_b"],
      role: "org_admin",
      scopes: ["model:readonly", "coder:execute"],
    });
    expect(updateCalls()).toHaveLength(1);
  });

  it("maps legacy admin PAT role to platform_admin", async () => {
    pgMock.query
      .mockResolvedValueOnce(selectResult(row({ role: "admin" })))
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const resolved = await resolvePatFromDb("syn-valid-token", "pepper");

    expect(resolved?.role).toBe("platform_admin");
    expect(updateCalls()).toHaveLength(1);
  });

  it("fails closed for unknown PAT roles from storage", async () => {
    pgMock.query.mockResolvedValueOnce(selectResult(row({ role: "super_admin" })));

    await expect(resolvePatFromDb("syn-valid-token", "pepper")).resolves.toBeNull();
    expect(updateCalls()).toHaveLength(0);
  });

  it("fails closed for malformed tenant and scope fields from storage", async () => {
    pgMock.query.mockResolvedValueOnce(selectResult(row({ tenant_ids: ["tenant a"] })));
    await expect(resolvePatFromDb("syn-valid-token", "pepper")).resolves.toBeNull();
    expect(updateCalls()).toHaveLength(0);

    pgMock.query.mockReset();
    pgMock.query.mockResolvedValueOnce(selectResult(row({ scopes: ["model:readonly", "role override"] })));
    await expect(resolvePatFromDb("syn-valid-token", "pepper")).resolves.toBeNull();
    expect(updateCalls()).toHaveLength(0);
  });

  it("fails closed for tenant-scoped PATs without an org", async () => {
    pgMock.query.mockResolvedValueOnce(selectResult(row({ org_id: "", tenant_ids: ["tenant-a"] })));

    await expect(resolvePatFromDb("syn-valid-token", "pepper")).resolves.toBeNull();
    expect(updateCalls()).toHaveLength(0);
  });
});
