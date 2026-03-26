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
});
