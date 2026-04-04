import { describe, expect, it } from "vitest";
import { filterMcpCatalogForOpenClaw, isOpenClawClientHeader } from "../src/mcp/index.js";

describe("OpenClaw MCP profile", () => {
  it("detects openclaw client headers", () => {
    expect(isOpenClawClientHeader("openclaw")).toBe(true);
    expect(isOpenClawClientHeader("OpenClaw Desktop")).toBe(true);
    expect(isOpenClawClientHeader("claw-enterprise")).toBe(true);
    expect(isOpenClawClientHeader("cursor")).toBe(false);
  });

  it("filters MCP catalog to OpenClaw allowlist", () => {
    const catalog = [
      { name: "read_file", description: "" },
      { name: "write_file", description: "" },
      { name: "git_status", description: "" },
    ];
    const filtered = filterMcpCatalogForOpenClaw(catalog);
    expect(filtered.map((t) => t.name)).toEqual(["read_file", "git_status"]);
  });

  it("allows read-only Synesis platform tools but not plan/critique/classify in OpenClaw filter", () => {
    const catalog = [
      { name: "synesis_search", description: "" },
      { name: "synesis_plan", description: "" },
      { name: "synesis_classify", description: "" },
    ];
    const filtered = filterMcpCatalogForOpenClaw(catalog);
    expect(filtered.map((t) => t.name)).toEqual(["synesis_search"]);
  });
});
