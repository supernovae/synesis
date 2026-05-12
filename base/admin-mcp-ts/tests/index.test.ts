import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    ...loadConfig(),
    SYNESIS_INTERNAL_SERVICE_TOKEN: "internal-secret",
    SYNESIS_ADMIN_API_URL: "http://admin.local",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin MCP internal auth", () => {
  it("rejects direct user bearer calls without the internal service token", async () => {
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: { authorization: "Bearer user-token" },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("allows Admin API mediated calls with service token and delegated cookie", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          username: "admin",
          role: "org_admin",
          user_id: "u1",
          org_id: "o1",
          org_name: "Org",
          org_roles: ["admin"],
          tenant_ids: [],
          token_scopes: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        "x-synesis-service-token": "internal-secret",
        "x-synesis-delegated-cookie": "synesis_admin_session=session",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().tools.length).toBeGreaterThan(10);
  });

  it("denies trusted calls when delegated user is not an admin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ username: "user", role: "user", user_id: "u1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createApp(cfg());
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin-tools",
      headers: {
        "x-synesis-service-token": "internal-secret",
        "x-synesis-delegated-cookie": "synesis_admin_session=session",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
  });
});

