import { describe, expect, it } from "vitest";
import { normalizeCommandOutputForComparison } from "../src/reduction/output-normalization.js";

describe("normalizeCommandOutputForComparison", () => {
  it("removes ANSI noise and normalizes volatile fields", () => {
    const raw = "\u001b[31mERROR\u001b[0m at 2026-04-07T21:01:33.123Z duration=149ms tmp=/tmp/abc123";
    const normalized = normalizeCommandOutputForComparison(raw);
    expect(normalized).toContain("ERROR");
    expect(normalized).not.toContain("\u001b[31m");
    expect(normalized).toContain("<ts>");
    expect(normalized).toContain("<dur>");
    expect(normalized).toContain("<tmp_path>");
  });

  it("normalizes semantically identical outputs with different timestamps", () => {
    const a = "FAIL pkg/a 0.39s\n12:33:44 run_id=deadbeefcafebabe";
    const b = "FAIL pkg/a 0.42s\n12:33:55 run_id=0011223344556677";
    expect(normalizeCommandOutputForComparison(a)).toBe(
      normalizeCommandOutputForComparison(b),
    );
  });
});

