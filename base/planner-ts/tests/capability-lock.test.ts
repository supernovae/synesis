import { describe, expect, it } from "vitest";
import { CAPABILITY_LOCK, assertCapabilityLock } from "../src/capability-lock.js";

describe("capability lock", () => {
  it("keeps all parity capabilities enabled", () => {
    expect(Object.values(CAPABILITY_LOCK).every(Boolean)).toBe(true);
    expect(() => assertCapabilityLock()).not.toThrow();
  });
});
