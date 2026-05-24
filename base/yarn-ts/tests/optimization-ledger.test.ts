import { describe, it, expect } from "vitest";
import { OptimizationLedger } from "../src/telemetry/optimization-ledger.js";

describe("OptimizationLedger", () => {
  it("records original message sizes", () => {
    const ledger = new OptimizationLedger();
    ledger.recordOriginal([
      { content: "hello" },
      { content: "world!" },
    ]);
    const snap = ledger.finalize();
    expect(snap.inputCharsOriginal).toBe(11);
  });

  it("computes estimated tokens saved", () => {
    const ledger = new OptimizationLedger();
    ledger.recordOriginal([{ content: "a".repeat(4000) }]);
    ledger.recordFinal([{ content: "a".repeat(2000) }]);
    const snap = ledger.finalize();
    expect(snap.estimatedTokensSaved).toBe(500);
  });

  it("accumulates dedup hits", () => {
    const ledger = new OptimizationLedger();
    ledger.addResponseDedupHit();
    ledger.addResponseDedupHit();
    ledger.addResponseDedupMiss();
    const snap = ledger.finalize();
    expect(snap.responseDedupHits).toBe(2);
    expect(snap.responseDedupMisses).toBe(1);
  });

  it("tracks block store hits", () => {
    const ledger = new OptimizationLedger();
    ledger.addBlockStoreHit();
    ledger.addBlockStoreHit();
    ledger.addBlockStoreMiss();
    const snap = ledger.finalize();
    expect(snap.blockStoreHits).toBe(2);
    expect(snap.blockStoreMisses).toBe(1);
  });

  it("records prefixStableBytes when explicitly set", () => {
    const ledger = new OptimizationLedger();
    ledger.setPrefixStableBytes(1234);
    const snap = ledger.finalize();
    expect(snap.prefixStableBytes).toBe(1234);
  });

  it("records pipeline latency", () => {
    const ledger = new OptimizationLedger();
    const snap = ledger.finalize();
    expect(snap.pipelineLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records stage timings cumulatively", () => {
    const ledger = new OptimizationLedger();
    const endProvider = ledger.startStage("provider", 100);
    endProvider(125);
    ledger.recordStageDuration("provider", 5);
    const snap = ledger.finalize();
    expect(snap.stageTimingsMs.provider).toBe(30);
  });

  it("records cache diagnostics", () => {
    const ledger = new OptimizationLedger();
    ledger.recordCacheDiagnostics({
      policyAction: "stabilize",
      policyProvider: "openai",
      policyReasons: ["low_cache"],
    });
    ledger.recordCacheDiagnostics({
      prefixHash: "abc",
      prefixChangeReasons: ["tools_changed"],
    });
    const snap = ledger.finalize();
    expect(snap.cacheDiagnostics).toEqual({
      policyAction: "stabilize",
      policyProvider: "openai",
      policyReasons: ["low_cache"],
      prefixHash: "abc",
      prefixChangeReasons: ["tools_changed"],
    });
  });

  it("toLogRecord omits zero-value fields", () => {
    const ledger = new OptimizationLedger();
    ledger.recordOriginal([{ content: "test" }]);
    ledger.recordFinal([{ content: "test" }]);
    const log = ledger.toLogRecord();
    expect(log.inputCharsOriginal).toBe(4);
    expect(log.inputCharsFinal).toBe(4);
    expect(log.responseDedupHits).toBeUndefined();
    expect(log.estimatedTokensSaved).toBeUndefined();
  });

  it("toLogRecord includes stage timings and cache diagnostics", () => {
    const ledger = new OptimizationLedger();
    ledger.recordStageDuration("ingress", 3);
    ledger.recordCacheDiagnostics({ policyAction: "observe" });
    const log = ledger.toLogRecord();
    expect(log.stageTimingsMs).toEqual({ ingress: 3 });
    expect(log.cacheDiagnostics).toEqual({ policyAction: "observe" });
  });

  it("handles non-string content via JSON.stringify", () => {
    const ledger = new OptimizationLedger();
    ledger.recordOriginal([{ content: { key: "value" } }]);
    const snap = ledger.finalize();
    expect(snap.inputCharsOriginal).toBeGreaterThan(0);
  });

  it("handles null/undefined content gracefully", () => {
    const ledger = new OptimizationLedger();
    ledger.recordOriginal([{ content: null }, {}]);
    const snap = ledger.finalize();
    expect(snap.inputCharsOriginal).toBe(0);
  });
});
