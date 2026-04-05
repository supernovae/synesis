import { describe, expect, it } from "vitest";
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
      payload: { query: "synesis roadmap" },
    });
    expect(res.statusCode).toBe(401);
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
});

