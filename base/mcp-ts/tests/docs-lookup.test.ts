import { describe, it, expect } from "vitest";
import { createDocsLookupTool } from "../src/handlers/docs-lookup.js";

describe("createDocsLookupTool", () => {
  const tool = createDocsLookupTool();

  it("known framework (fastapi) returns docs_url", async () => {
    const result = (await tool.handler({ framework: "fastapi" })) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.framework).toBe("fastapi");
    expect(result.docs_url).toBe("https://fastapi.tiangolo.com");
    expect(result.api_reference).toBe("https://fastapi.tiangolo.com/reference/");
  });

  it("unknown framework returns found: false with available list", async () => {
    const result = (await tool.handler({ framework: "not-a-real-fw" })) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.framework).toBe("not-a-real-fw");
    expect(Array.isArray(result.available_frameworks)).toBe(true);
    const list = result.available_frameworks as string[];
    expect(list).toContain("fastapi");
    expect(list).toEqual([...list].sort());
  });

  it("falls back to latest when version key missing", async () => {
    const result = (await tool.handler({
      framework: "fastapi",
      version: "999.0.0",
    })) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.docs_url).toBe("https://fastapi.tiangolo.com");
    expect(result.version).toBe("0.115.x");
  });

  it("includes topic_hint when topic is provided", async () => {
    const result = (await tool.handler({
      framework: "react",
      topic: "hooks",
    })) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(typeof result.topic_hint).toBe("string");
    const hint = String(result.topic_hint);
    expect(hint).toContain("hooks");
    expect(hint).toContain("react.dev");
  });
});
