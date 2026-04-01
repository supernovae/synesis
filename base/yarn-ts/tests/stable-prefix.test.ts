import { describe, expect, it } from "vitest";
import { StablePrefixService } from "../src/context/stable-prefix.js";

describe("StablePrefixService", () => {
  it("produces stable prefix hash for same session + adapter", () => {
    const svc = new StablePrefixService();
    const a = svc.partition("sess-1", "<CLIENT_ADAPTER>cursor</CLIENT_ADAPTER>");
    const b = svc.partition("sess-1", "<CLIENT_ADAPTER>cursor</CLIENT_ADAPTER>");
    expect(a.prefixHash).toBe(b.prefixHash);
    expect(a.stablePrefix).toBe(b.stablePrefix);
  });

  it("produces different hashes for different adapters", () => {
    const svc = new StablePrefixService();
    const a = svc.partition("sess-1", "<CLIENT_ADAPTER>cursor</CLIENT_ADAPTER>");
    const b = svc.partition("sess-1", "<CLIENT_ADAPTER>claude-code</CLIENT_ADAPTER>");
    expect(a.prefixHash).not.toBe(b.prefixHash);
  });

  it("tracks cache hits when prefix is unchanged", () => {
    const svc = new StablePrefixService();
    svc.partition("sess-1", "adapter-block");
    svc.partition("sess-1", "adapter-block");
    svc.partition("sess-1", "adapter-block");
    const stats = svc.getStats();
    expect(stats.partitionsBuilt).toBe(3);
    expect(stats.prefixCacheHits).toBe(2);
    expect(stats.uniquePrefixHashes).toBe(1);
  });

  it("handles undefined adapter block", () => {
    const svc = new StablePrefixService();
    const result = svc.partition("sess-1", undefined);
    expect(result.stablePrefix).toContain("Synesis");
    expect(result.prefixHash).toBeTruthy();
  });

  it("evicts session from cache", () => {
    const svc = new StablePrefixService();
    svc.partition("sess-1", "adapter");
    svc.partition("sess-1", "adapter");
    expect(svc.getStats().prefixCacheHits).toBe(1);
    svc.evictSession("sess-1");
    svc.partition("sess-1", "adapter");
    expect(svc.getStats().prefixCacheHits).toBe(1);
  });

  it("applies prompt overlays in deterministic precedence order", () => {
    const svc = new StablePrefixService();
    const snapshot = {
      profiles: [
        { id: 1, content: "base-default", content_hash: "h1" },
        { id: 2, content: "tier-core", content_hash: "h2" },
        { id: 3, content: "family-qwen", content_hash: "h3" },
        { id: 4, content: "role-coder", content_hash: "h4" },
      ],
      assignments: [
        { target_type: "default", target_value: "*", profile_id: 1 },
        { target_type: "tier", target_value: "synesis-core", profile_id: 2 },
        { target_type: "model_family", target_value: "qwen3-coder", profile_id: 3 },
        { target_type: "role", target_value: "coder-core", profile_id: 4 },
      ],
    };
    const result = svc.partition(
      "sess-1",
      "adapter",
      snapshot,
      { tier: "synesis-core", role: "coder-core", modelFamily: "qwen3-coder" },
    );
    expect(result.stablePrefix).toContain("base-default");
    expect(result.stablePrefix.indexOf("base-default")).toBeLessThan(result.stablePrefix.indexOf("tier-core"));
    expect(result.stablePrefix.indexOf("tier-core")).toBeLessThan(result.stablePrefix.indexOf("family-qwen"));
    expect(result.stablePrefix.indexOf("family-qwen")).toBeLessThan(result.stablePrefix.indexOf("role-coder"));
    expect(result.promptProfileIds).toEqual([1, 2, 3, 4]);
    expect(result.promptProfileHashes).toEqual(["h1", "h2", "h3", "h4"]);
  });

  it("falls back to base instructions when snapshot unavailable", () => {
    const svc = new StablePrefixService();
    const result = svc.partition("sess-1", undefined, null, { tier: "synesis-core" });
    expect(result.stablePrefix).toContain("Synesis");
    expect(result.promptProfileIds).toEqual([]);
    expect(result.promptProfileHashes).toEqual([]);
  });
});
