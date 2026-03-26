import { describe, expect, it } from "vitest";
import { maskVerboseLog } from "../src/context/log-mask.js";

describe("maskVerboseLog", () => {
  it("returns original content for short logs", () => {
    const input = ["a", "b", "c"].join("\n");
    expect(maskVerboseLog(input, 2, 2)).toBe(input);
  });

  it("suppresses middle lines for long logs", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`);
    const output = maskVerboseLog(lines.join("\n"), 3, 3);
    expect(output).toContain("line-1");
    expect(output).toContain("line-40");
    expect(output).toContain("lines of log suppressed");
    expect(output).not.toContain("line-20");
  });
});
