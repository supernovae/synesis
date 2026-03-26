import { describe, expect, it } from "vitest";
import { RepeatGuard } from "../src/middleware/repeat-guard.js";

describe("RepeatGuard", () => {
  it("triggers pivot on third identical attempt", () => {
    const guard = new RepeatGuard();
    const attempt = {
      toolName: "apply_patch",
      args: { file: "a.ts", patch: "..." },
      fsFingerprint: "abc123"
    };

    expect(guard.shouldPivot(attempt)).toBe(false);
    expect(guard.shouldPivot(attempt)).toBe(false);
    expect(guard.shouldPivot(attempt)).toBe(true);
  });

  it("does not pivot across different fingerprints", () => {
    const guard = new RepeatGuard();
    expect(
      guard.shouldPivot({
        toolName: "apply_patch",
        args: { file: "a.ts" },
        fsFingerprint: "one"
      })
    ).toBe(false);
    expect(
      guard.shouldPivot({
        toolName: "apply_patch",
        args: { file: "a.ts" },
        fsFingerprint: "two"
      })
    ).toBe(false);
  });
});
