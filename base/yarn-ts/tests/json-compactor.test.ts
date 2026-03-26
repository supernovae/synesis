import { describe, expect, it } from "vitest";
import { compactJsonArray } from "../src/reduction/json-compactor.js";

function makeItems(n: number): Array<{ id: number; name: string; status: string; score: number }> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `item-${i + 1}`,
    status: i === 7 ? "error" : "ok",
    score: Math.round(Math.random() * 100)
  }));
}

describe("compactJsonArray", () => {
  it("returns null for non-JSON input", () => {
    expect(compactJsonArray("not json")).toBeNull();
    expect(compactJsonArray("{ key: value }")).toBeNull();
  });

  it("returns null for arrays with fewer than 3 items", () => {
    expect(compactJsonArray(JSON.stringify([{ id: 1, score: 10 }]))).toBeNull();
    expect(compactJsonArray(JSON.stringify([{ id: 1, score: 10 }, { id: 2, score: 20 }]))).toBeNull();
  });

  it("returns null for heterogeneous arrays", () => {
    const mixed = [
      { type: "user", name: "Alice" },
      { error: "not found", code: 404 },
      { count: 5, items: [] },
      "just a string"
    ];
    expect(compactJsonArray(JSON.stringify(mixed))).toBeNull();
  });

  it("compacts a homogeneous array with signal fields", () => {
    const items = makeItems(50);
    const raw = JSON.stringify(items);
    const result = compactJsonArray(raw);
    expect(result).not.toBeNull();
    expect(result!.originalItems).toBe(50);
    expect(result!.keptItems).toBeLessThan(50);
    expect(result!.compressionRatio).toBeGreaterThan(0);
    expect(result!.compacted).toContain("<JSON_COMPACTED");
    expect(result!.compacted).toContain("</JSON_COMPACTED>");
  });

  it("preserves boundary items (first/last)", () => {
    const items = makeItems(20);
    items[0].name = "FIRST";
    items[19].name = "LAST";
    const result = compactJsonArray(JSON.stringify(items));
    expect(result).not.toBeNull();
    expect(result!.compacted).toContain("FIRST");
    expect(result!.compacted).toContain("LAST");
  });

  it("preserves anomaly items", () => {
    const items = makeItems(30);
    const result = compactJsonArray(JSON.stringify(items));
    expect(result).not.toBeNull();
    expect(result!.compacted).toContain("error");
  });

  it("includes artifact handle when provided", () => {
    const items = makeItems(10);
    const result = compactJsonArray(JSON.stringify(items), { artifactHandle: "art_abc123" });
    expect(result).not.toBeNull();
    expect(result!.compacted).toContain("artifact_handle=art_abc123");
  });

  it("achieves high compression on large arrays", () => {
    const items = makeItems(200);
    const raw = JSON.stringify(items);
    const result = compactJsonArray(raw);
    expect(result).not.toBeNull();
    expect(result!.compressionRatio).toBeGreaterThan(0.5);
    expect(result!.keptItems).toBeLessThanOrEqual(30);
  });

  it("keeps all items for small arrays (5 or fewer)", () => {
    const items = makeItems(5);
    const raw = JSON.stringify(items);
    const result = compactJsonArray(raw);
    expect(result).not.toBeNull();
    expect(result!.keptItems).toBe(5);
  });

  it("respects maxOutputItems override", () => {
    const items = makeItems(50);
    const result = compactJsonArray(JSON.stringify(items), { maxOutputItems: 6 });
    expect(result).not.toBeNull();
    expect(result!.keptItems).toBe(6);
  });
});
