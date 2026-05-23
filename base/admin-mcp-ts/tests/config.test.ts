import { describe, expect, it } from "vitest";
import { adminApiBaseUrl, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns coherent defaults", () => {
    const c = loadConfig();
    expect(c.PORT).toBeGreaterThan(0);
    expect(c.SYNESIS_ADMIN_MCP_HTTP_PATH.startsWith("/")).toBe(true);
    expect(c.SYNESIS_ADMIN_API_URL.length).toBeGreaterThan(0);
  });

  it("normalizes admin API roots when operators include the API prefix", () => {
    expect(adminApiBaseUrl({ SYNESIS_ADMIN_API_URL: "http://admin.local/api/v1" })).toBe("http://admin.local");
    expect(adminApiBaseUrl({ SYNESIS_ADMIN_API_URL: "http://admin.local/" })).toBe("http://admin.local");
  });
});
