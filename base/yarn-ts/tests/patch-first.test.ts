import { describe, expect, it } from "vitest";
import { enforcePatchFirst } from "../src/middleware/patch-first.js";

describe("enforcePatchFirst", () => {
  it("returns error when write_file tool is present", () => {
    const result = enforcePatchFirst([
      { function: { name: "write_file", description: "Write a file" } }
    ]);
    expect(result).toContain("Patch-first policy violation");
  });

  it("returns null when tools contain apply_patch", () => {
    const result = enforcePatchFirst([
      { function: { name: "apply_patch", description: "Apply a patch" } }
    ]);
    expect(result).toBeNull();
  });

  it("returns null when tools contain search_replace", () => {
    const result = enforcePatchFirst([
      { function: { name: "search_replace", description: "Search and replace" } }
    ]);
    expect(result).toBeNull();
  });

  it("returns null for undefined or empty tools", () => {
    expect(enforcePatchFirst(undefined)).toBeNull();
    expect(enforcePatchFirst([])).toBeNull();
  });

  it("skips tools with malformed or missing function.name", () => {
    const result = enforcePatchFirst([
      { function: {} },
      { function: { name: 123 } } as never,
      {},
      { function: { name: "read_file" } }
    ]);
    expect(result).toBeNull();
  });

  it("catches write_file even among other valid tools", () => {
    const result = enforcePatchFirst([
      { function: { name: "read_file" } },
      { function: { name: "apply_patch" } },
      { function: { name: "write_file" } }
    ]);
    expect(result).toContain("Patch-first policy violation");
  });
});
