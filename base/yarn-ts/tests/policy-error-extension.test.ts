import { describe, expect, it } from "vitest";
import { synesisPolicyErrorExtension } from "../src/policy/policy-error-extension.js";

describe("synesisPolicyErrorExtension", () => {
  it("maps repeat_loop_hard_reject", () => {
    const ext = synesisPolicyErrorExtension(["repeat_loop_hard_reject"]);
    expect(ext?.code).toBe("repeat_loop_hard_reject");
    expect(ext?.retryable).toBe(false);
    expect(ext?.guidance).toContain("new chat/session");
  });

  it("returns undefined for unknown rules", () => {
    expect(synesisPolicyErrorExtension(["allow"])).toBeUndefined();
  });
});
