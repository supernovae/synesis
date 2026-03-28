import { describe, it, expect } from "vitest";
import { sortObjectKeys, sortToolSchemas, stableJsonStringify } from "../src/compat/sorted-tools.js";

describe("sortObjectKeys", () => {
  it("sorts top-level keys alphabetically", () => {
    const result = sortObjectKeys({ z: 1, a: 2, m: 3 });
    expect(Object.keys(result as Record<string, unknown>)).toEqual(["a", "m", "z"]);
  });

  it("recursively sorts nested objects", () => {
    const result = sortObjectKeys({ b: { z: 1, a: 2 }, a: 1 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.b as Record<string, unknown>)).toEqual(["a", "z"]);
  });

  it("handles arrays by sorting elements if they are objects", () => {
    const result = sortObjectKeys([{ b: 1, a: 2 }]) as Array<Record<string, unknown>>;
    expect(Object.keys(result[0])).toEqual(["a", "b"]);
  });

  it("passes through primitives", () => {
    expect(sortObjectKeys(42)).toBe(42);
    expect(sortObjectKeys("hello")).toBe("hello");
    expect(sortObjectKeys(null)).toBeNull();
    expect(sortObjectKeys(undefined)).toBeUndefined();
  });
});

describe("sortToolSchemas", () => {
  it("returns undefined for undefined, passes through empty array", () => {
    expect(sortToolSchemas(undefined)).toBeUndefined();
    expect(sortToolSchemas([])).toEqual([]);
  });

  it("produces deterministic JSON across different key orders", () => {
    const toolsA = [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
    const toolsB = [{ input_schema: { properties: { command: { type: "string" } }, type: "object" }, name: "bash" }];
    const a = JSON.stringify(sortToolSchemas(toolsA));
    const b = JSON.stringify(sortToolSchemas(toolsB));
    expect(a).toBe(b);
  });
});

describe("stableJsonStringify", () => {
  it("produces sorted JSON string", () => {
    const result = stableJsonStringify({ c: 3, a: 1, b: 2 });
    expect(result).toBe('{"a":1,"b":2,"c":3}');
  });
});
