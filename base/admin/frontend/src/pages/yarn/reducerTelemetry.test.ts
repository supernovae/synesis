import { describe, expect, it } from "vitest";
import { formatReducerHealth, formatSnapshotFreshness } from "./reducerTelemetry";

describe("formatReducerHealth", () => {
  it("returns No data for zero totals", () => {
    expect(formatReducerHealth(0, 0)).toBe("No data");
  });

  it("returns rounded percentage for non-zero totals", () => {
    expect(formatReducerHealth(9, 1)).toBe("90%");
  });
});

describe("formatSnapshotFreshness", () => {
  it("handles no snapshots", () => {
    expect(formatSnapshotFreshness(0, null, true)).toBe("No snapshots yet");
  });

  it("marks stale snapshots", () => {
    const value = formatSnapshotFreshness(5, "2026-04-07T10:00:00+00:00", true);
    expect(value).toContain("(stale)");
  });
});
