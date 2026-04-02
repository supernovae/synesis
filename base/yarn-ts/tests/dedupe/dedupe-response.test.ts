import { describe, expect, it } from "vitest";
import { DedupeCache } from "../../src/dedupe/DedupeCache.js";
import { ResponseDedupe } from "../../src/dedupe/ResponseDedupe.js";

describe("DedupeCache", () => {
  it("evicts oldest response entries when over max (effective floor 16)", () => {
    const c = new DedupeCache(16);
    for (let i = 0; i < 18; i++) {
      c.setResponse(`k${i}`, `v${i}`);
    }
    expect(c.getResponse("k0")).toBeUndefined();
    expect(c.getResponse("k1")).toBeUndefined();
    expect(c.getResponse("k17")).toBe("v17");
  });
});

describe("ResponseDedupe", () => {
  it("returns full body on first read_file result", () => {
    const rd = new ResponseDedupe(new DedupeCache(64), {});
    const body = "line1\nline2";
    const out = rd.wrapToolResult("read_file", { path: "foo.js" }, body);
    expect(out).toBe(body);
  });

  it("returns stub on second identical read_file result", () => {
    const rd = new ResponseDedupe(new DedupeCache(64), {});
    const body = "same";
    expect(rd.wrapToolResult("read_file", { path: "foo.js" }, body)).toBe(body);
    const stub = rd.wrapToolResult("read_file", { path: "foo.js" }, body);
    const j = JSON.parse(stub) as Record<string, unknown>;
    expect(j.cached).toBe(true);
    expect(j.file).toBe("foo.js");
    expect(j.note).toMatch(/omitted/);
  });

  it("does not stub apply_patch results", () => {
    const rd = new ResponseDedupe(new DedupeCache(64), {});
    const p = "ok";
    expect(rd.wrapToolResult("apply_patch", { path: "x", patch: "y" }, p)).toBe(p);
    expect(rd.wrapToolResult("apply_patch", { path: "x", patch: "y" }, p)).toBe(p);
  });

  it("does not stub run_tests payload", () => {
    const rd = new ResponseDedupe(new DedupeCache(64), {});
    const p = "test output";
    expect(rd.wrapToolResult("run_tests", { command: "npm test" }, p)).toBe(p);
    expect(rd.wrapToolResult("run_tests", { command: "npm test" }, p)).toBe(p);
  });
});
