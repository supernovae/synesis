import { describe, expect, it } from "vitest";
import {
  applyRuntimePreferenceLoopLimits,
  normalizeUserRuntimePreferences,
} from "../src/runtime/user-preferences.js";

const baseLimits = {
  consecutiveToolCallsLimit: 25,
  consecutiveToolCallsPivot: 15,
  stagnantToolCyclesLimit: 8,
  toolLoopNoUserAckHardLimit: 4,
  hardRejectAfter: 6,
};

describe("user runtime preferences", () => {
  it("normalizes invalid preference payloads to safe defaults", () => {
    const prefs = normalizeUserRuntimePreferences({
      loopBreakMode: "bogus",
      cachePolicyBias: "nope",
      allowAggressiveCompactionWithoutCacheHits: "yes",
      maxToolLoopSoftFails: 999,
    });

    expect(prefs.loopBreakMode).toBe("standard");
    expect(prefs.cachePolicyBias).toBe("auto");
    expect(prefs.allowAggressiveCompactionWithoutCacheHits).toBe(true);
    expect(prefs.maxToolLoopSoftFails).toBe(20);
  });

  it("makes assertive loop breaking stricter", () => {
    const prefs = normalizeUserRuntimePreferences({ loopBreakMode: "assertive" });
    const limits = applyRuntimePreferenceLoopLimits(baseLimits, prefs);

    expect(limits.consecutiveToolCallsPivot).toBeLessThan(baseLimits.consecutiveToolCallsPivot);
    expect(limits.stagnantToolCyclesLimit).toBeLessThan(baseLimits.stagnantToolCyclesLimit);
    expect(limits.hardRejectAfter).toBeLessThan(baseLimits.hardRejectAfter);
  });

  it("lets advanced users extend loop tolerance while preserving hard bounds", () => {
    const prefs = normalizeUserRuntimePreferences({
      loopBreakMode: "hands_off",
      maxToolLoopSoftFails: 10,
    });
    const limits = applyRuntimePreferenceLoopLimits(baseLimits, prefs);

    expect(limits.consecutiveToolCallsPivot).toBeGreaterThanOrEqual(20);
    expect(limits.stagnantToolCyclesLimit).toBeGreaterThanOrEqual(12);
    expect(limits.toolLoopNoUserAckHardLimit).toBe(10);
    expect(limits.consecutiveToolCallsLimit).toBeGreaterThan(limits.consecutiveToolCallsPivot);
  });
});
