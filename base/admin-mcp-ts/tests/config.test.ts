import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns coherent defaults", () => {
    const c = loadConfig();
    expect(c.PORT).toBeGreaterThan(0);
    expect(c.SYNESIS_ADMIN_MCP_HTTP_PATH.startsWith("/")).toBe(true);
    expect(c.SYNESIS_ADMIN_API_URL.length).toBeGreaterThan(0);
  });
});
