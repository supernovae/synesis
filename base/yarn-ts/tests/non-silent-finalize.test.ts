import { describe, expect, it } from "vitest";
import { enforceNonSilentFinalizeText } from "../src/verification/non-silent-finalize.js";

describe("enforceNonSilentFinalizeText", () => {
  it("preserves actionable text", () => {
    const input = "Implemented parser fixes and ran go test ./... successfully.";
    const out = enforceNonSilentFinalizeText(input);
    expect(out.applied).toBe(false);
    expect(out.text).toBe(input);
  });

  it("replaces empty text with explicit fallback guidance", () => {
    const out = enforceNonSilentFinalizeText("   ");
    expect(out.applied).toBe(true);
    expect(out.text).toContain("paused before producing a usable final update");
    expect(out.text).toContain("reply with: continue");
  });

  it("replaces non-actionable placeholder text", () => {
    const out = enforceNonSilentFinalizeText("...");
    expect(out.applied).toBe(true);
  });
});
