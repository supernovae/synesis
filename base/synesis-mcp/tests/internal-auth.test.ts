import { describe, expect, it } from "vitest";
import { requireInternalBearer } from "../src/internal-auth.js";

describe("internal auth", () => {
  it("accepts matching bearer tokens", () => {
    expect(requireInternalBearer("Bearer internal-token", "internal-token")).toBe(true);
  });

  it("rejects missing or mismatched tokens", () => {
    expect(requireInternalBearer(undefined, "internal-token")).toBe(false);
    expect(requireInternalBearer("Bearer other-token", "internal-token")).toBe(false);
  });

  it("fails closed when the configured token is empty", () => {
    expect(requireInternalBearer("Bearer anything", "")).toBe(false);
    expect(requireInternalBearer("Bearer anything", "   ")).toBe(false);
  });
});
