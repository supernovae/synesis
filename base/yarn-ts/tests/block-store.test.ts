import { describe, it, expect } from "vitest";
import { BlockStore } from "../src/store/block-store.js";

describe("BlockStore", () => {
  it("returns same hash for identical content", () => {
    const store = new BlockStore();
    const ref1 = store.put("hello world");
    const ref2 = store.put("hello world");
    expect(ref1.hash).toBe(ref2.hash);
    expect(store.stats().hits).toBe(1);
    expect(store.stats().misses).toBe(1);
  });

  it("returns different hash for different content", () => {
    const store = new BlockStore();
    const ref1 = store.put("hello");
    const ref2 = store.put("world");
    expect(ref1.hash).not.toBe(ref2.hash);
  });

  it("NFC-normalizes content before hashing", () => {
    const store = new BlockStore();
    // U+00E9 (precomposed) vs U+0065 U+0301 (decomposed) — NFC normalizes both
    const ref1 = store.put("\u00e9");
    const ref2 = store.put("\u0065\u0301");
    expect(ref1.hash).toBe(ref2.hash);
  });

  it("get returns stored content after put", () => {
    const store = new BlockStore();
    const ref = store.put("test content");
    expect(store.get(ref.hash)).toBe("test content");
  });

  it("intern returns the same string reference", () => {
    const store = new BlockStore();
    const s1 = store.intern("interned text");
    const s2 = store.intern("interned text");
    expect(s1).toBe(s2);
  });

  it("evicts LRU entries when maxEntries exceeded", () => {
    const store = new BlockStore({ maxEntries: 3 });
    const ref1 = store.put("aaa");
    store.put("bbb");
    store.put("ccc");
    store.put("ddd");
    expect(store.get(ref1.hash)).toBeUndefined();
    expect(store.stats().evictions).toBe(1);
  });

  it("evicts when maxBytes exceeded", () => {
    const store = new BlockStore({ maxBytes: 30 });
    const ref1 = store.put("twelve_chars"); // 12 bytes
    store.put("another_twelve"); // 14 bytes — total would be 26, ok
    store.put("this_pushes_it_over"); // 20 bytes — eviction needed
    expect(store.get(ref1.hash)).toBeUndefined();
    expect(store.stats().evictions).toBeGreaterThanOrEqual(1);
  });

  it("provides accurate token estimates", () => {
    const store = new BlockStore();
    const ref = store.put("a".repeat(400));
    expect(ref.tokenEstimate).toBe(100);
  });

  it("has returns true for stored hashes", () => {
    const store = new BlockStore();
    const ref = store.put("check");
    expect(store.has(ref.hash)).toBe(true);
    expect(store.has("nonexistent")).toBe(false);
  });

  it("get returns undefined for unknown hash (fail-safe)", () => {
    const store = new BlockStore();
    expect(store.get("deadbeef")).toBeUndefined();
  });

  it("static hash is deterministic", () => {
    expect(BlockStore.hash("foo")).toBe(BlockStore.hash("foo"));
    expect(BlockStore.hash("foo")).not.toBe(BlockStore.hash("bar"));
  });

  it("tracks cumulative stats", () => {
    const store = new BlockStore();
    store.put("a");
    store.put("a");
    store.put("b");
    const s = store.stats();
    expect(s.puts).toBe(3);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(2);
    expect(s.entries).toBe(2);
  });
});
