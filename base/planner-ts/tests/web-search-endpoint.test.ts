import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "debug-token",
    ...overrides,
  });
}

describe("planner /v1/web/search", () => {
  it("rejects missing auth", async () => {
    const app = buildApp(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/v1/web/search",
      payload: { query: "synesis roadmap", role_override: "admin" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unknown fields on authorized web search bodies", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_WEB_SEARCH_ENABLED: "false",
        SYNESIS_WEB_SEARCH_URL: "",
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/web/search",
      headers: { authorization: "Bearer debug-token" },
      payload: {
        query: "synesis docs",
        source_surface: "planner_internal",
        policy_override: "allow_all",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Request validation failed" });
    await app.close();
  });

  it("returns deny policy when web search is disabled", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_WEB_SEARCH_ENABLED: "false",
        SYNESIS_WEB_SEARCH_URL: "",
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/web/search",
      headers: { authorization: "Bearer debug-token" },
      payload: { query: "synesis docs" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.policy?.action).toBe("deny");
    expect(body.policy?.reason).toBe("web_search_disabled");
    await app.close();
  });

  it("applies preferred domain restrict policy on direct web search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Vendor docs",
              url: "https://docs.example.com/page",
              content: "synesis docs answer",
              engine: "duckduckgo",
              score: 1,
            },
            {
              title: "Other blog",
              url: "https://blog.example.net/page",
              content: "synesis docs answer",
              engine: "duckduckgo",
              score: 1,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const app = buildApp(
      makeConfig({
        SYNESIS_WEB_SEARCH_ENABLED: "true",
        SYNESIS_WEB_SEARCH_URL: "http://searxng.local",
        SYNESIS_DOMAIN_POLICY_MODE: "restrict",
      }),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/web/search",
        headers: { authorization: "Bearer debug-token" },
        payload: {
          query: "synesis docs",
          fetch_pages: false,
          preferred_domains: ["docs.example.com"],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.results[0].url).toBe("https://docs.example.com/page");
    } finally {
      fetchMock.mockRestore();
      await app.close();
    }
  });
});
