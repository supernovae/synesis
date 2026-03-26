import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateWithRepair } from "../src/validation/json-repair.js";

describe("validateWithRepair", () => {
  const schema = z.object({
    approved: z.boolean(),
    notes: z.string().default("")
  });

  it("parses clean JSON", () => {
    const out = validateWithRepair('{"approved":true,"notes":"ok"}', schema);
    expect(out.approved).toBe(true);
    expect(out.notes).toBe("ok");
  });

  it("extracts JSON from wrapped text", () => {
    const out = validateWithRepair('model output\n{"approved":false}\ntrailing', schema);
    expect(out.approved).toBe(false);
  });

  it("repairs trailing commas", () => {
    const out = validateWithRepair('{"approved":true,"notes":"x",}', schema);
    expect(out.approved).toBe(true);
  });
});
